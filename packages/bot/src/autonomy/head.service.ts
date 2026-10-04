import {
  DEFAULT_RISK_LIMITS,
  createLlmAnalyst,
  convene,
  decisionFingerprint,
  describeHeadPlan,
  isEntry,
  llmConfigFromEnv,
  planPosition,
  recordAiAction,
  resolveProvider,
  type AgentOpinion,
  type AiActionChip,
  type AiActionSeverity,
  type Candle,
  type CouncilConviction,
  type CouncilVerdict,
  type HeadPlan,
  type MarketSnapshot,
  type OpenPosition,
} from "@opentrader/ai-team";
import { xprisma } from "@opentrader/db";
import { exchangeProvider } from "@opentrader/exchanges";
import { logger } from "@opentrader/logger";
import { IntelDesk, deskOptionsFromEnv, type MarketIntel } from "@opentrader/market-intel";
import type { ICandlestick } from "@opentrader/types";
import { closeSmartTrade } from "../trade-closer.js";
import { AUTOPILOT_REF_PREFIX, openSmartTrade, type ManualTradeLimits } from "../trade-opener.js";
import { journalStatus, lastActionAt, openedNotionalToday, pruneJournal, recordDecision } from "./journal.js";
import { effectiveEquity, loadAutopilotPolicy, type AutopilotConfig } from "./policy.js";
import { barMs, candlesNeeded, loadOpenPositions, peakSince, summariseBook } from "./positions.js";
import { SingleFlight } from "./single-flight.js";

/**
 * The trading head.
 *
 * Everything else in this system reacts: a strategy ticks when its candle
 * closes, the regime governor adjusts a cap when a conviction lands, the
 * learning loop writes a proposal when a streak appears. None of them decides
 * to trade. This does.
 *
 * One pass, once a minute:
 *
 *   1. **Gather.** Candles from the exchange, an outside technical read across
 *      six timeframes, the research council's standing conviction, and a
 *      market-wide sentiment index.
 *   2. **Deliberate.** The council votes on identical evidence — the LLM
 *      strategist joining when a provider is configured, and the whole thing
 *      degrading to its deterministic members when one is not.
 *   3. **Plan.** The pure planner decides what a trader would actually do:
 *      manage the position first, then consider a new one, and most of the time
 *      conclude that this is not the minute to do anything.
 *   4. **Act, or not.** In `live` mode an approved plan reaches the exchange
 *      through the same guarded opener and closer an operator's own click uses.
 *      In `observe` it is written down and nothing is placed.
 *   5. **Write it down.** Every decision, traded or not, with the evidence
 *      behind it.
 *
 * The safety property is inherited, not reinvented: the planner can only reduce
 * or refuse relative to the operator's limits, and those limits live in the
 * database rather than in anything a model can reach. The worst a wrong
 * conviction can do is leave capital idle or take a small loss inside a budget
 * that was set before it spoke.
 */

/** Until the policy has been read, poll at the conservative default. */
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Reported when a pass is asked for while one is already running.
 *
 * The timer and `runNow` share one gate — see `runOnce` — so this is what an
 * operator sees when they press "run now" during a slow pass: an answer,
 * rather than a second head sizing against a book the first is still moving.
 */
export const PASS_BUSY = "A pass is already running; passes never overlap.";

/** How often an unchanged hold is written down anyway, so quiet leaves a trail. */
const HOLD_HEARTBEAT_MS = 30 * 60 * 1000;

/** How often old holds are swept out. Slow: the window is measured in days. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;


/** How the head's actions are painted in the AI feed. */
const CHIP: Record<HeadPlan["action"], AiActionChip> = {
  hold: "analysis",
  open: "open",
  add: "open",
  take_profit: "take-profit",
  trail_exit: "take-profit",
  stop_out: "risk",
  close: "close",
  flatten: "risk",
};

const SEVERITY: Partial<Record<HeadPlan["action"], AiActionSeverity>> = {
  stop_out: "danger",
  flatten: "danger",
  take_profit: "success",
  trail_exit: "success",
  close: "success",
};

export type SymbolOutcome = {
  symbol: string;
  action: HeadPlan["action"];
  executed: boolean;
  reason: string;
  /** Why an intended action did not reach the exchange, when one did not. */
  failure?: string;
  /** Notional committed, for an entry that went through. */
  sizeQuote?: number;
  /**
   * Notional the exit will release once it fills.
   *
   * Reported, not spent: the running book deliberately does not credit this
   * back mid-pass, because the order is still working and the inventory is
   * still ours. It is here so the caller can see the size of what was let go.
   */
  exposureFreed?: number;
};

export type HeadPassResult = {
  ran: boolean;
  mode: AutopilotConfig["mode"] | null;
  /** Why the pass did nothing, when it did nothing. */
  reason?: string;
  considered: number;
  executed: number;
  outcomes: SymbolOutcome[];
};

function toCandles(candles: ICandlestick[]): Candle[] {
  return candles.map((candle) => ({
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    timestamp: candle.timestamp,
  }));
}

/**
 * The council's latest view per symbol, from the local mirror.
 *
 * Read from the mirror rather than the research service so a slow or dead
 * service cannot stall the trading loop. The regime poller keeps the mirror
 * current, and the research agent inside the council decays a conviction by its
 * own age, so a stale mirror degrades gracefully rather than misleading.
 */
async function mirroredConvictions(symbols: string[]): Promise<Map<string, CouncilConviction>> {
  const out = new Map<string, CouncilConviction>();

  for (const symbol of symbols) {
    try {
      const row = (await xprisma.regimeConviction.findFirst({
        where: { symbol },
        orderBy: { asOf: "desc" },
      })) as { stance: string; confidence: number; asOf: bigint; summary: string } | null;

      if (!row) continue;

      out.set(symbol, {
        stance: row.stance as CouncilConviction["stance"],
        confidence: row.confidence,
        asOf: Number(row.asOf),
        summary: row.summary,
      });
    } catch {
      // A missing table or an unreadable row is one fewer voice at the table,
      // never a reason to stop trading.
    }
  }

  return out;
}

/**
 * The hard door the head's own orders go through.
 *
 * The planner already refused anything over these numbers. Re-stating them at
 * the opener is deliberate: the planner is pure and could in principle be given
 * the wrong portfolio, while this check reads the database itself. Two
 * independent gates on the one operation that can only increase exposure.
 */
function doorLimits(config: AutopilotConfig): ManualTradeLimits {
  return {
    enabled: true,
    maxNotionalQuote: config.limits.maxPositionQuote,
    maxOpenPositions: config.limits.maxOpenPositions,
    maxDailyNotionalQuote: config.limits.maxDailyOpenNotionalQuote,
    // The watchlist is the allowlist. The head cannot trade a market it was
    // never pointed at, whatever a model decides to name.
    allowedSymbols: config.symbols,
  };
}

export class TradingHead {
  private timer: NodeJS.Timeout | null = null;
  private desk = new IntelDesk(deskOptionsFromEnv());
  /** Single gate for every caller: the timer and `runNow` both enter through it. */
  private pass = new SingleFlight<HeadPassResult>(() => ({
    ran: false,
    mode: null,
    reason: PASS_BUSY,
    considered: 0,
    executed: 0,
    outcomes: [],
  }));
  /** The interval the timer is currently on, so a changed policy can rebuild it. */
  private intervalMs: number | null = null;

  /** Cached strategist, rebuilt when the operator changes provider or model. */
  private llm: { key: string; analyst: (snapshot: MarketSnapshot) => Promise<AgentOpinion | null> } | null = null;

  /** The last action reported per symbol, so the feed shows changes, not a heartbeat. */
  private lastReported = new Map<string, string>();

  /** The last hold written down per symbol, so the journal records news only. */
  private lastJournalled = new Map<string, { fingerprint: string; at: number }>();

  /** The last decision logged per symbol, so the journal shows changes only. */
  private lastLogged = new Map<string, { fingerprint: string; at: number }>();

  /** Last equity reading actually reported, so a static balance logs once, not every pass. */
  private lastEquity: number | null = null;

  /** When a failure was last *shown* for a symbol, so a blocked head heartbeats instead of flooding. */
  private lastFailureAt = new Map<string, number>();

  /** When housekeeping last ran, so it runs on its own slow schedule. */
  private lastPrunedAt = 0;

  /**
   * The LLM strategist, when one is reachable.
   *
   * Enabled by a configured provider — the dashboard's choice or the
   * environment's — rather than by a flag, so arming the head does not also
   * require remembering to switch the model on. Returns undefined when nothing
   * is configured, and the council votes with its deterministic members.
   */
  private llmAnalyst(): ((snapshot: MarketSnapshot) => Promise<AgentOpinion | null>) | undefined {
    const provider = resolveProvider();
    const config = llmConfigFromEnv();

    if (!provider && !config.enabled) return undefined;

    const key = provider ? `${provider.id}:${provider.model}` : `anthropic:${config.model}`;
    if (this.llm?.key !== key) {
      this.llm = { key, analyst: createLlmAnalyst({ ...config, enabled: true }) };
      logger.info(`[Head] Strategist on ${key}`);
    }

    return this.llm.analyst;
  }

  /**
   * Run one full pass over the watchlist — or skip.
   *
   * Every caller enters through this gate: the timer, an operator's `runNow`,
   * the chat's `autopilot.runNow` proposal. Passes never overlap because two
   * heads deciding from the same book at once would both size against the same
   * headroom — and the second caller is *answered*, not queued.
   *
   * Exported through the service so the API can trigger it and see the result,
   * rather than an operator having to wait out the interval to learn whether
   * their change took.
   */
  async runOnce(): Promise<HeadPassResult> {
    return this.pass.run(() => this.runPass());
  }

  /** One pass, entered only while the single-flight gate is held. */
  private async runPass(): Promise<HeadPassResult> {
    const idle = (reason: string, mode: AutopilotConfig["mode"] | null = null): HeadPassResult => ({
      ran: false,
      mode,
      reason,
      considered: 0,
      executed: 0,
      outcomes: [],
    });

    let config = await loadAutopilotPolicy();
    if (!config) return idle("The autopilot policy table is missing; run `prisma db push`.");
    if (!config.enabled) return idle("The trading head is disarmed.", config.mode);
    if (config.symbols.length === 0) return idle("No symbols on the watchlist.", config.mode);
    if (config.botId === null) return idle("No bot selected to route orders through.", config.mode);

    const bot = (await xprisma.bot.findUnique({
      where: { id: config.botId },
      include: { exchangeAccount: true },
    })) as { id: number; symbol: string; exchangeAccount: unknown } | null;

    if (!bot) return idle(`Bot ${config.botId} no longer exists.`, config.mode);

    const exchange = exchangeProvider.fromAccount(bot.exchangeAccount as never);

    const [intel, convictions, positions, book, openedAtPassStart, accountEquity] = await Promise.all([
      this.desk.gather(config.symbols),
      mirroredConvictions(config.symbols),
      loadOpenPositions(config.botId),
      summariseBook(config.botId),
      openedNotionalToday(),
      this.readEquity(exchange, config.symbols),
    ]);

    /*
     * Equity comes from the account, not from a column.
     *
     * The policy's `equityQuote` only moves when an operator remembers to move
     * it — after a loss, a withdrawal or a deposit the head would otherwise
     * size against a figure the account no longer backs. The live balance can
     * only *lower* the ceiling (`effectiveEquity` takes the minimum), so this
     * never widens anything; a balance that cannot be read leaves the
     * operator's number standing, which is the same answer as every pass
     * before the account was consulted at all.
     */
    const policyCeiling = config.limits.equityQuote;
    const equityQuote = effectiveEquity(policyCeiling, accountEquity);

    if (accountEquity !== null && accountEquity !== this.lastEquity) {
      this.lastEquity = accountEquity;
      logger.info(
        `[Head] Equity: ${accountEquity.toFixed(2)} free in quote; entry ceiling ${equityQuote} (policy ${policyCeiling})`,
      );
    }

    config = { ...config, limits: { ...config.limits, equityQuote } };

    // A resting entry that never filled is cancelled before anything else is
    // decided. It holds a position slot and a slice of the day's budget at the
    // order door, so leaving it there would quietly starve the next idea — and
    // the evidence it was opened on is a bar old by now anyway.
    await this.sweepStaleEntries(config);

    const outcomes: SymbolOutcome[] = [];
    let executed = 0;
    // `?? 0` is a fallback, not a claim: null means the journal could not be
    // read, and `execute` refuses new entries in exactly that state — so the
    // unknown budget can never fund an entry, while exits (which need no
    // budget) carry on regardless.
    let spentToday = openedAtPassStart ?? 0;

    // Sequential, not parallel. Each decision changes the exposure the next one
    // is allowed to take, and two symbols sizing against the same headroom at
    // the same moment is how a book ends up over its cap.
    for (const symbol of config.symbols) {
      try {
        const outcome = await this.considerSymbol({
          symbol,
          config,
          exchange,
          intel: intel.get(symbol) ?? null,
          conviction: convictions.get(symbol) ?? null,
          position: positions.get(symbol) ?? null,
          book: {
            openPositions: book.openPositions,
            openExposureQuote: book.openExposureQuote,
            realizedPnlToday: book.realizedPnlToday,
            consecutiveLosses: book.consecutiveLosses,
            openedNotionalToday: spentToday,
          },
        });

        outcomes.push(outcome);

        if (outcome.executed) {
          executed += 1;

          // Keep the running book honest within the pass, so the next symbol
          // sizes against what this one just committed. The daily budget has to
          // fall here too: it is read from the journal once per pass, so
          // without this every symbol in one pass would size against the same
          // untouched allowance and the day's limit could be spent several
          // times over in a single minute.
          if (isEntry(outcome.action)) {
            book.openPositions += 1;
            book.openExposureQuote += outcome.sizeQuote ?? 0;
            spentToday += outcome.sizeQuote ?? 0;
          }

          /*
           * An exit deliberately does not give the headroom back here.
           *
           * Asking to sell is not selling: the order is working and the
           * inventory is still ours until it fills. Crediting the exposure back
           * in the same pass would let a later symbol size against room that
           * does not exist yet — an error in the one direction the limits exist
           * to prevent. The next pass reads the book from the orders and finds
           * the truth, which costs at most one interval of caution.
           */
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[Head] ${symbol} could not be considered: ${message}`);
        outcomes.push({ symbol, action: "hold", executed: false, reason: `${symbol} could not be decided: ${message}`, failure: message });
      }
    }

    return { ran: true, mode: config.mode, considered: config.symbols.length, executed, outcomes };
  }

  /**
   * Cancel autopilot entries still resting after their bar.
   *
   * Only ever touches orders that have not filled, so it cannot close a
   * position — `closeSmartTrade` reports `canceled_unfilled` for exactly this
   * case and leaves anything holding inventory alone.
   */
  private async sweepStaleEntries(config: AutopilotConfig): Promise<void> {
    if (config.entryOrderType !== "limit") return;

    const cutoff = new Date(Date.now() - barMs(config.timeframe));

    try {
      const stale = (await xprisma.smartTrade.findMany({
        where: {
          botId: config.botId!,
          ref: { startsWith: AUTOPILOT_REF_PREFIX },
          createdAt: { lt: cutoff },
          orders: { some: { entityType: "EntryOrder", status: { in: ["Idle", "Placed"] } } },
        },
        select: { id: true, symbol: true },
      })) as { id: number; symbol: string }[];

      for (const trade of stale) {
        const result = await closeSmartTrade(trade.id, "market");
        if (result.outcome === "canceled_unfilled") {
          logger.info(`[Head] Cancelled unfilled entry on ${trade.symbol} after one bar; deciding again.`);
        }
      }
    } catch (error) {
      // Never let housekeeping stop the desk deciding.
      logger.warn(`[Head] Could not sweep stale entries: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Decide and, when allowed, act on one market. */
  private async considerSymbol(input: {
    symbol: string;
    config: AutopilotConfig;
    exchange: ReturnType<typeof exchangeProvider.fromAccount>;
    intel: MarketIntel | null;
    conviction: CouncilConviction | null;
    position: OpenPosition | null;
    book: {
      openPositions: number;
      openExposureQuote: number;
      realizedPnlToday: number;
      consecutiveLosses: number;
      openedNotionalToday: number;
    };
  }): Promise<SymbolOutcome> {
    const { symbol, config, exchange, intel, conviction, book } = input;

    const now = Date.now();
    // Fetch far enough back to cover the position being managed: `peakSince`
    // can only see what this window holds, and a peak rebuilt from too few
    // candles reads low — quietly disarming the trail on exactly the old
    // positions it exists to protect.
    const raw = await exchange.getCandlesticks({
      symbol,
      bar: config.timeframe,
      limit: candlesNeeded(config, input.position?.openedAt ?? null, now),
    });
    const candles = toCandles(raw);

    if (candles.length === 0) {
      return { symbol, action: "hold", executed: false, reason: `No candles for ${symbol}` };
    }

    // The last candle is the one still forming, so its close is the live price.
    const price = candles[candles.length - 1].close;

    const position = input.position
      ? { ...input.position, peakPrice: peakSince(candles, input.position.openedAt, input.position.entryPrice) }
      : null;

    /*
     * No `arb` on this snapshot, so the council's arbitrage scout (weight 1.5)
     * reports itself unavailable and is excluded from the tally — the seat is
     * empty for the head by construction, not by bug. The hybrid strategy wires
     * cross-venue books into its snapshot; this pass gathers one venue. Wiring
     * a scan in here is the deliberate next step; until then the docs say the
     * head votes with its directional seats and its outside readers, not with
     * the scout.
     */
    const snapshot: MarketSnapshot = {
      symbol,
      price,
      candles,
      technical: intel?.technical ?? null,
      sentiment: intel?.sentiment ?? null,
      conviction,
    };

    /*
     * The council votes on direction only.
     *
     * Every portfolio-derived veto is lifted here, and that is a fix rather
     * than a convenience. The council's risk analyst compares exposure against
     * whichever limits it is handed, and it was being handed
     * `DEFAULT_RISK_LIMITS` — a 500-quote cap belonging to the Hybrid strategy
     * and to nothing on this desk. A head running past that figure had every
     * verdict on every symbol vetoed, including the ones that would have closed
     * the positions causing it.
     *
     * The head's own planner enforces the real limits immediately afterwards,
     * from the operator's policy. Letting both layers halt would also mean a
     * tripped budget reached the journal as "the council saw nothing", which is
     * not what happened and not what an operator needs to read.
     *
     * The volatility veto is deliberately left in place: it is a judgement
     * about the market, which is exactly what the council is for.
     */
    const verdict: CouncilVerdict = await convene(
      snapshot,
      {
        ...DEFAULT_RISK_LIMITS,
        maxDailyLossQuote: Number.MAX_SAFE_INTEGER,
        maxConsecutiveLosses: Number.MAX_SAFE_INTEGER,
        maxTotalExposureQuote: Number.MAX_SAFE_INTEGER,
        killSwitch: false,
      },
      {
        openExposureQuote: book.openExposureQuote,
        realizedPnlToday: 0,
        consecutiveLosses: 0,
        equityQuote: config.limits.equityQuote,
      },
      { llmAnalyst: this.llmAnalyst() },
    );

    const plan = planPosition(snapshot, verdict, position, config.limits, {
      openExposureQuote: book.openExposureQuote,
      openPositions: book.openPositions,
      realizedPnlToday: book.realizedPnlToday,
      openedNotionalToday: book.openedNotionalToday,
      consecutiveLosses: book.consecutiveLosses,
      lastActionAt: await lastActionAt(symbol),
    });

    /*
     * The log follows the same rule as the feed and the journal: say it when it
     * changes, not once a minute per symbol forever. Three symbols on a
     * one-minute loop is 4,300 identical lines a day, which is how the one that
     * mattered gets missed. Anything that trades is logged unconditionally
     * below, in `execute`.
     */
    const planFingerprint = decisionFingerprint(plan);
    const lastLogged = this.lastLogged.get(symbol);

    if (!lastLogged || lastLogged.fingerprint !== planFingerprint || now - lastLogged.at >= HOLD_HEARTBEAT_MS) {
      this.lastLogged.set(symbol, { fingerprint: planFingerprint, at: now });
      logger.info(`[Head] ${describeHeadPlan(plan)}`);
    }

    const evidence = {
      price,
      opinions: verdict.opinions.map((opinion) => ({
        agent: opinion.agent,
        signal: opinion.signal,
        confidence: Number(opinion.confidence.toFixed(3)),
        available: opinion.available !== false,
        rationale: opinion.rationale,
      })),
      verdict: { signal: verdict.signal, confidence: verdict.confidence, rationale: verdict.rationale },
      technical: intel?.technical ?? null,
      sentiment: intel?.sentiment ?? null,
      conviction,
      notes: plan.notes,
      limits: config.limits,
    };

    if (plan.action === "hold") {
      /*
       * A hold is written down when it is news, not once a minute.
       *
       * Every decision used to be journalled, holds included, on the reasoning
       * that a log which only records trades hides why the desk stood still.
       * That reasoning is right and the implementation was not: at three
       * symbols a minute it wrote 4,300 rows a day, and after the head halted
       * itself it wrote the identical row 2,662 times. The table reached 10 MB
       * and 98.6% of the database, which tripped the bloat alarm, which mailed
       * the operator every few minutes.
       *
       * So: the first hold of its kind is recorded, repeats are not, and a
       * heartbeat goes in every half hour so a long quiet stretch still leaves
       * a trail. Executed decisions are always recorded, unconditionally.
       */
      const fingerprint = decisionFingerprint(plan);
      const last = this.lastJournalled.get(symbol);
      const newsworthy = !last || last.fingerprint !== fingerprint || now - last.at >= HOLD_HEARTBEAT_MS;

      if (newsworthy) {
        this.lastJournalled.set(symbol, { fingerprint, at: now });
        await recordDecision({ plan, mode: config.mode, executed: false, price, smartTradeId: null, evidence });
      }

      this.report(plan, config, false, null);

      return { symbol, action: "hold", executed: false, reason: plan.reason };
    }

    if (config.mode !== "live") {
      await recordDecision({ plan, mode: config.mode, executed: false, price, smartTradeId: null, evidence });
      this.report(plan, config, false, null);

      return { symbol, action: plan.action, executed: false, reason: `Observing only: ${plan.reason}` };
    }

    logger.info(`[Head] ${describeHeadPlan(plan)}`);

    const execution = await this.execute(plan, config, price, exchange);

    await recordDecision({
      plan,
      mode: config.mode,
      executed: execution.ok,
      price,
      smartTradeId: execution.smartTradeId,
      evidence: { ...evidence, execution: execution.message },
    });

    this.report(plan, config, execution.ok, execution.ok ? null : execution.message);

    return {
      symbol,
      action: plan.action,
      executed: execution.ok,
      reason: execution.ok ? plan.reason : `${plan.reason} — but it did not reach the exchange`,
      failure: execution.ok ? undefined : execution.message,
      sizeQuote: plan.sizeQuote,
      exposureFreed: position ? position.entryPrice * position.quantity : 0,
    };
  }

  /** Place the order a plan asks for, through the paths an operator's click uses. */
  private async execute(
    plan: HeadPlan,
    config: AutopilotConfig,
    /** The price the decision was made at, used to price the resting exit. */
    price: number,
    exchange: ReturnType<typeof exchangeProvider.fromAccount>,
  ): Promise<{ ok: boolean; smartTradeId: number | null; message: string }> {
    if (isEntry(plan.action)) {
      /*
       * The journal is the budget, so an unreadable journal has no budget.
       *
       * `openedNotionalToday`, the cooldowns and the exit-in-flight guard are
       * all reads against the autopilot journal; when those reads fail they
       * used to hand back 0 / null, which reads as "nothing spent today, no
       * cooldown, no working exit" — three permissions granted by a broken
       * table. Exits still work: they reduce risk and need no budget. A fresh
       * commitment of money waits until the journal can record it, and the
       * health check turns red on the same condition, so a head running this
       * way is visible as well as restricted.
       */
      if (!journalStatus().readable) {
        return {
          ok: false,
          smartTradeId: null,
          message:
            "Autopilot journal is unreadable; refusing new entries until it can record them (exits are unaffected). Run `prisma db push` if the table is missing.",
        };
      }

      /*
       * Which exit gets to live at the exchange.
       *
       * Only one can: on spot, two sell orders against the same coins means the
       * venue rejects the second, and this fork has no native OCO. Every entry
       * used to rest its take profit, which insured the upside against this
       * process dying and left the downside to a loop that dies with it.
       *
       * So the stop rests and the target does not. The head re-decides every
       * pass and takes profit itself long before a resting limit would matter —
       * and `closeSmartTrade` cancels this stop before placing that exit, so the
       * two can never both sell. What changes is only what happens while nothing
       * is watching: the position now has a floor under it rather than a ceiling
       * over it.
       */
      const stopPrice = price * (1 - (config.limits.stopLossPercent + config.limits.roundTripFeeBps / 100) / 100);

      /*
       * The stop that survives the daemon.
       *
       * Every entry left a resting take profit and nothing underneath it, so a
       * filled position's downside was protected only by this loop. An outage,
       * a stalled pass or an exchange timeout left it naked — and on daily bars
       * a position is held for weeks, so the window is not theoretical.
       *
       * Priced just below where the loop would act, the same way the take profit
       * sits just above it: in normal operation the loop still decides and this
       * never fires, and `closeSmartTrade` cancels it before placing any exit of
       * its own, so the two can never both sell.
       */


      /*
       * Rest at the bid, or cross the spread.
       *
       * A limit entry saves the half-spread and the maker fee, and is worth more
       * the more the desk trades — measured out-of-sample across 29 daily
       * markets it roughly doubled the year's return. It costs certainty: the
       * order fills only if the market comes back to meet it, and the sweep
       * above cancels it after a bar if it does not.
       *
       * A ticker we cannot read is a reason to cross the spread, not to skip the
       * trade: the planner already decided this one is worth doing.
       */
      let entryPrice: number | null = null;

      if (config.entryOrderType === "limit") {
        try {
          const ticker = await exchange.getTicker(plan.symbol);
          if (ticker.bid > 0) entryPrice = ticker.bid;
        } catch (error) {
          logger.warn(
            `[Head] No ticker for a resting entry on ${plan.symbol}; crossing the spread instead ` +
              `(${error instanceof Error ? error.message : String(error)}).`,
          );
        }
      }

      const result = await openSmartTrade(
        {
          botId: config.botId!,
          symbol: plan.symbol,
          side: "buy",
          quoteAmount: plan.sizeQuote,
          orderType: entryPrice === null ? "market" : "limit",
          price: entryPrice ?? undefined,
          stopLossPrice: Number(stopPrice.toFixed(8)),
        },
        doorLimits(config),
        AUTOPILOT_REF_PREFIX,
      );

      if (!result.ok) logger.warn(`[Head] Entry refused at the door: ${result.message}`);

      return { ok: result.ok, smartTradeId: result.smartTradeId ?? null, message: result.message };
    }

    if (plan.smartTradeId === null) {
      return { ok: false, smartTradeId: null, message: "No deal to close." };
    }

    const result = await closeSmartTrade(plan.smartTradeId, plan.urgency === "now" ? "market" : "limit");

    /*
     * Every outcome the closer reports is a success here, including
     * `already_closed`.
     *
     * That reads oddly until you consider what the alternative does: the head
     * asked to not be holding this, and it is not holding it. Calling that a
     * failure would leave the cooldown unset and have the next pass try to
     * exit inventory that no longer exists. A genuine failure — an exchange
     * rejection, a missing account — throws, and is caught by the caller.
     */
    return { ok: true, smartTradeId: plan.smartTradeId, message: result.message };
  }

  /**
   * Free quote-currency balance across the watchlist's quotes, or null.
   *
   * Null means "could not be read", which is genuinely different from zero:
   * the caller falls back to the operator's policy ceiling rather than
   * refusing every entry on a transient account error. Only the quotes the
   * watchlist trades are counted, and `availableBalance` rather than the
   * total: balance already committed to open orders or positions is not
   * money this loop may spend twice — the exposure caps govern it where it
   * sits.
   */
  private async readEquity(
    exchange: ReturnType<typeof exchangeProvider.fromAccount>,
    symbols: string[],
  ): Promise<number | null> {
    const quotes = new Set(symbols.map((symbol) => symbol.split("/")[1]).filter(Boolean));
    if (quotes.size === 0) return null;

    try {
      const assets = await exchange.accountAssets();

      let total = 0;
      let seen = false;
      for (const asset of assets) {
        if (!quotes.has(asset.currency)) continue;
        total += asset.availableBalance;
        seen = true;
      }

      return seen ? total : null;
    } catch (error) {
      // Debug, not warn: this runs every pass, and an account endpoint that is
      // merely slow is not an incident. The fallback is the policy ceiling.
      logger.debug(
        `[Head] Equity unreadable, using the policy ceiling (${error instanceof Error ? error.message : String(error)})`,
      );
      return null;
    }
  }

  /**
   * Put the decision on the dashboard.
   *
   * Trades are always reported — they are rare, they move real money, and every
   * one is worth seeing. A hold is reported only when it is a *change*: the head
   * re-decides every minute, and a bot that has been patiently holding all
   * morning would otherwise write four hundred identical bubbles and bury the
   * one minute it acted.
   */
  private report(plan: HeadPlan, config: AutopilotConfig, executed: boolean, failure: string | null): void {
    const fingerprint = decisionFingerprint(plan);
    const changed = this.lastReported.get(plan.symbol) !== fingerprint;
    this.lastReported.set(plan.symbol, fingerprint);

    if (plan.action === "hold" && !changed) return;

    if (failure) {
      /*
       * A failure shows the first time it happens and then heartbeats, the
       * same deal holds get. A head blocked by the journal gate (or refused
       * at the door for the same reason every pass) would otherwise write
       * identical denied bubbles at loop rate — 1,440 a day per symbol — and
       * bury the feed the way the hold flood did. A *different* failure
       * changes the plan's fingerprint and reports immediately, as before.
       */
      const shownAt = this.lastFailureAt.get(plan.symbol) ?? 0;
      const shownNow = Date.now();
      if (!changed && shownNow - shownAt < HOLD_HEARTBEAT_MS) return;
      this.lastFailureAt.set(plan.symbol, shownNow);

      recordAiAction({
        chip: "denied",
        severity: "warning",
        title: `${plan.action.replace(/_/g, " ")} failed on ${plan.symbol}`,
        detail: failure,
        symbol: plan.symbol,
        botId: config.botId,
        autonomous: true,
      });

      return;
    }

    const observing = plan.action !== "hold" && !executed;

    recordAiAction({
      chip: observing ? "analysis" : CHIP[plan.action],
      severity: observing ? "info" : (SEVERITY[plan.action] ?? "info"),
      title: observing ? `Would ${plan.action.replace(/_/g, " ")} ${plan.symbol}` : `Head: ${plan.action.replace(/_/g, " ")} ${plan.symbol}`,
      detail: observing ? `Observing only, nothing placed. ${plan.reason}` : plan.reason,
      symbol: plan.symbol,
      botId: config.botId,
      smartTradeId: plan.smartTradeId,
      autonomous: true,
    });
  }

  /**
   * Run continuously.
   *
   * Passes never overlap: a slow exchange or a slow model delays the next pass
   * rather than stacking a second one on top of it, because two heads deciding
   * from the same book at once would both size against the same headroom. The
   * gate lives in `runOnce`, so `runNow` obeys it too.
   */
  start(): void {
    const tick = async () => {
      try {
        const result = await this.runOnce();

        // The gate answered rather than the pass: a slow previous pass is
        // still deciding, and policy and housekeeping wait for it as they
        // always did.
        if (result.reason === PASS_BUSY) {
          logger.debug("[Head] Previous pass still running; skipping this tick");
          return;
        }

        if (result.ran && result.executed > 0) {
          logger.info(`[Head] Pass complete: ${result.executed} of ${result.considered} markets acted on`);
        }

        // The interval is policy, and policy changes without a restart. Checked
        // whether or not the pass ran: a disarmed head still has to notice the
        // moment its interval — or its arming — changes.
        await this.retimeIfNeeded();

        // Housekeeping, off the decision path and on its own slow clock.
        const now = Date.now();
        if (now - this.lastPrunedAt >= PRUNE_INTERVAL_MS) {
          this.lastPrunedAt = now;
          await pruneJournal();
        }
      } catch (error) {
        // A failure here must never take the daemon down. The positions the
        // head holds keep their resting exits, and the next pass tries again.
        // The single-flight gate releases itself whether this throws or not.
        logger.warn(`[Head] Pass failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    this.schedule(DEFAULT_INTERVAL_MS, tick);
    // One first pass, not two. Kicking off a separate policy read alongside it
    // had both racing to seed the singleton row on a cold start, and the loser
    // reported its unique-constraint failure as a missing table. The pass
    // retimes itself when it finishes.
    void tick();

    logger.info("[Head] Trading head started");
  }

  private tickFn: (() => Promise<void>) | null = null;

  private schedule(intervalMs: number, tick: () => Promise<void>): void {
    if (this.timer) clearInterval(this.timer);

    this.tickFn = tick;
    this.intervalMs = intervalMs;
    this.timer = setInterval(() => void tick(), intervalMs);
    // Never hold the process open just for the trading loop.
    this.timer.unref?.();
  }

  /** Adopt the interval the policy asks for, when it differs from the current one. */
  private async retimeIfNeeded(tick = this.tickFn): Promise<void> {
    if (!tick) return;

    const config = await loadAutopilotPolicy();
    if (!config || config.intervalMs === this.intervalMs) return;

    this.schedule(config.intervalMs, tick);
    logger.info(`[Head] Now deciding every ${(config.intervalMs / 1000).toFixed(0)}s`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    logger.info("[Head] Trading head stopped");
  }

  /** What the head is currently holding and reading, for the health view. */
  status() {
    return { intervalMs: this.intervalMs, running: this.pass.busy(), intel: this.desk.status() };
  }
}

/** The daemon's single head. */
export const tradingHead = new TradingHead();
