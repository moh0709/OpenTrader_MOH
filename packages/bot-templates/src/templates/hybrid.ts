import {
  applyRiskGovernor,
  convene,
  createLlmAnalyst,
  describeDecision,
  llmConfigFromEnv,
  recordAiAction,
  type AgentOpinion,
  type Candle,
  type CouncilVerdict,
  type MarketSnapshot,
  type PortfolioState,
  type RiskLimits,
  type Signal,
} from "@opentrader/ai-team";
import { buy, cancelSmartTrade, sell, type IBotConfiguration, type TBotContext } from "@opentrader/bot-processor";
import { logger } from "@opentrader/logger";
import type { ICandlestick } from "@opentrader/types";
import { z } from "zod";
import { bestArbitrage, collectVenueQuotes } from "../utils/hybrid-market.js";

/**
 * Hybrid Trader — an AI team of specialist agents deciding trades together,
 * on top of OpenTrader's execution engine.
 *
 * Each tick:
 *   1. Build one market snapshot every agent reasons over.
 *   2. Score cross-venue spreads against real order-book depth and fees.
 *   3. Convene the council; the LLM strategist joins when it is reachable.
 *   4. Pass the verdict through the deterministic risk governor.
 *   5. Execute only what the governor approves.
 *
 * The governor is the load-bearing safety property: it runs after the vote and
 * can only reduce or refuse, so no agent — LLM included — can widen a limit.
 */

// One client for the process, not one per tick.
let llmAnalyst: ((snapshot: MarketSnapshot) => Promise<AgentOpinion | null>) | null = null;

function getLlmAnalyst(enabled: boolean) {
  if (!enabled) return undefined;
  if (!llmAnalyst) llmAnalyst = createLlmAnalyst(llmConfigFromEnv());
  return llmAnalyst;
}

function toCandles(candles: ICandlestick[]): Candle[] {
  return candles.map((c) => ({
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    timestamp: c.timestamp,
  }));
}

export function* hybrid(ctx: HybridContext) {
  const {
    config: { settings: params, symbol },
    state,
    market,
    markets,
  } = ctx;

  if (ctx.onStart) {
    logger.info(params, `[Hybrid] AI trading team started on ${symbol}`);
    return;
  }

  if (ctx.onStop) {
    logger.info("[Hybrid] AI trading team stopped");
    yield cancelSmartTrade();
    return;
  }

  // Reset the daily loss budget when the calendar day rolls over.
  const today = new Date().toISOString().slice(0, 10);
  if (state.day !== today) {
    state.day = today;
    state.realizedPnlToday = 0;
    logger.info(`[Hybrid] New trading day ${today}; daily loss budget reset`);
  }

  state.openExposureQuote ??= 0;
  state.consecutiveLosses ??= 0;
  state.realizedPnlToday ??= 0;

  const candles = toCandles(market.candles);
  if (candles.length < params.minCandles) {
    logger.info(`[Hybrid] Warming up: ${candles.length}/${params.minCandles} candles`);
    return;
  }

  const price = candles[candles.length - 1].close;
  const now = Date.now();

  const venueQuotes = collectVenueQuotes(markets, symbol, params.takerFeeBps);
  const arb = bestArbitrage(venueQuotes, params.arbTradeQty, params.minNetSpreadBps, now);

  if (venueQuotes.length > 0) {
    logger.info(`[Hybrid] Scanned ${venueQuotes.length} venue(s): ${venueQuotes.map((q) => q.venue).join(", ")}`);
  }

  const snapshot: MarketSnapshot = { symbol, price, candles, arb };

  const limits: RiskLimits = {
    maxPositionQuote: params.maxPositionQuote,
    maxTotalExposureQuote: params.maxTotalExposureQuote,
    maxDailyLossQuote: params.maxDailyLossQuote,
    maxConsecutiveLosses: params.maxConsecutiveLosses,
    minConfidence: params.minConfidence,
    allowPyramiding: params.allowPyramiding,
    liquidateOnBreach: params.liquidateOnBreach,
    killSwitch: params.killSwitch,
  };

  const portfolio: PortfolioState = {
    openExposureQuote: state.openExposureQuote,
    realizedPnlToday: state.realizedPnlToday,
    consecutiveLosses: state.consecutiveLosses,
    equityQuote: params.equityQuote,
  };

  // The runner awaits yielded promises, so the council can call the LLM here.
  // Worst-case wall time is bounded by the SDK timeout and retry count.
  const verdict: CouncilVerdict = yield convene(snapshot, limits, portfolio, {
    llmAnalyst: getLlmAnalyst(params.useLlm),
  });

  for (const opinion of verdict.opinions) {
    logger.info(`[Hybrid]   ${opinion.agent} (${opinion.source}) -> ${opinion.signal}@${opinion.confidence.toFixed(2)}: ${opinion.rationale}`);
  }

  const decision = applyRiskGovernor(verdict, limits, portfolio);
  logger.info(`[Hybrid] ${describeDecision(decision, symbol)}`);

  const botId = ctx.config.id;
  const percent = (value: number) => `${Math.round(value * 100)}%`;

  /*
   * Report to the dashboard's AI feed.
   *
   * Only *changes* are recorded here, never every tick. The council re-states
   * its view on every candle close, so a bot that has been holding all morning
   * would otherwise write hundreds of identical "council says hold" entries and
   * bury the one tick where it actually did something. A change of mind is
   * news; repeating yourself is not.
   *
   * Orders and force-exits below are recorded unconditionally — those are rare,
   * they move real money, and every one of them is worth seeing.
   */
  const voted = verdict.opinions.filter((opinion) => opinion.available !== false);
  const agreeing = voted.filter((opinion) => opinion.signal === verdict.signal).length;

  if (verdict.signal !== state.lastCouncilSignal) {
    state.lastCouncilSignal = verdict.signal;

    recordAiAction({
      chip: "analysis",
      title: `Council: ${verdict.signal.toUpperCase()} ${symbol}`,
      detail: `${agreeing} of ${voted.length} agents agree at ${percent(verdict.confidence)} confidence. ${verdict.rationale}`,
      botId,
      symbol,
    });
  }

  // Being held back is worth seeing, but the governor repeats its objection for
  // as long as the condition lasts, so it is recorded once per distinct reason.
  const riskNote = decision.riskNotes.join("; ");

  if (!decision.approved && verdict.signal !== "hold" && riskNote !== state.lastRiskNote) {
    state.lastRiskNote = riskNote;

    recordAiAction({
      chip: "risk",
      title: `Trade blocked on ${symbol}`,
      detail: `Council wanted to ${verdict.signal}. ${riskNote}`,
      botId,
      symbol,
    });
  }

  // A trade got through, so whatever was blocking is over: forget it, or the
  // next block for the same reason would be swallowed as a repeat.
  if (decision.approved) state.lastRiskNote = undefined;

  // A tripped loss limit means get flat, not just stop buying. `sell` targets
  // this bot's own smart trade and is a no-op if an exit is already working, so
  // repeating it on later ticks cannot stack up duplicate orders.
  if (decision.liquidate) {
    const quantity = state.openExposureQuote / price;

    logger.warn(
      `[Hybrid] Force-exiting ${quantity.toFixed(8)} ${symbol} (~${state.openExposureQuote.toFixed(2)} quote): ${decision.liquidateReason}`,
    );

    recordAiAction({
      chip: "risk",
      severity: "danger",
      title: `Force-exit ${symbol}`,
      detail: decision.liquidateReason ?? "A loss limit tripped while a position was open.",
      botId,
      symbol,
    });

    state.openExposureQuote = 0;
    yield sell({ quantity, orderType: "Market" });
    return;
  }

  if (!decision.approved) return;

  const quantity = decision.sizeQuote / price;
  if (quantity <= 0) {
    logger.warn("[Hybrid] Computed quantity is zero; skipping");
    return;
  }

  if (decision.signal === "buy") {
    logger.info(`[Hybrid] BUY ${quantity.toFixed(8)} ${symbol} (~${decision.sizeQuote.toFixed(2)} quote)`);
    state.openExposureQuote += decision.sizeQuote;

    recordAiAction({
      chip: "open",
      title: `Opened ${symbol}`,
      detail: `Bought about ${decision.sizeQuote.toFixed(2)} quote at market on ${percent(decision.confidence)} council confidence.`,
      botId,
      symbol,
    });

    yield buy({ quantity, orderType: "Market" });
  } else {
    logger.info(`[Hybrid] SELL ${quantity.toFixed(8)} ${symbol} (~${decision.sizeQuote.toFixed(2)} quote)`);
    state.openExposureQuote = Math.max(0, state.openExposureQuote - decision.sizeQuote);

    recordAiAction({
      chip: "close",
      title: `Closed ${symbol}`,
      detail: `Sold about ${decision.sizeQuote.toFixed(2)} quote at market on ${percent(decision.confidence)} council confidence.`,
      botId,
      symbol,
    });

    yield sell({ quantity, orderType: "Market" });
  }
}

hybrid.displayName = "Hybrid Trader (AI Team)";
hybrid.description =
  "A council of specialist agents — trend, mean-reversion, cross-venue arbitrage, an LLM strategist, and a risk analyst — vote on every trade, with hard risk limits enforced in code after the vote.";

hybrid.schema = z.object({
  // Risk budget. These are enforced deterministically and cannot be overridden
  // by any agent, including the LLM.
  equityQuote: z.number().positive().default(1000).describe("Account equity in quote currency, used as the sizing ceiling"),
  maxPositionQuote: z.number().positive().default(100).describe("Maximum notional for a single position"),
  maxTotalExposureQuote: z.number().positive().default(500).describe("Maximum total open exposure"),
  maxDailyLossQuote: z.number().positive().default(50).describe("Halt trading for the day after this much realised loss"),
  maxConsecutiveLosses: z.number().int().positive().default(3).describe("Halt trading after this many losses in a row"),
  minConfidence: z.number().min(0).max(1).default(0.55).describe("Minimum council confidence required to trade"),
  allowPyramiding: z.boolean().default(false).describe("Allow adding to a position that is already open"),
  liquidateOnBreach: z
    .boolean()
    .default(true)
    .describe("When a loss limit trips, force-exit open positions instead of only blocking new trades"),
  killSwitch: z.boolean().default(false).describe("Operator halt — blocks all trading while true"),

  // Cross-venue arbitrage.
  arbTradeQty: z.number().positive().default(0.01).describe("Base quantity used to price cross-venue spreads"),
  minNetSpreadBps: z.number().positive().default(8).describe("Minimum net spread, after fees and slippage, to act on"),
  takerFeeBps: z.number().min(0).default(10).describe("Assumed taker fee per venue, in basis points"),

  // Council behaviour.
  useLlm: z.boolean().default(true).describe("Include the LLM strategist when credentials are available"),
  minCandles: z.number().int().positive().default(35).describe("Candles required before the council will vote"),
});

hybrid.requiredHistory = 60;
hybrid.timeframe = ({ timeframe }: IBotConfiguration) => timeframe;

hybrid.runPolicy = {
  onCandleClosed: true,
};

hybrid.watchers = {
  watchCandles: ({ symbol }: IBotConfiguration) => symbol,
  // Additional venues are configured per bot; each resolves into `ctx.markets`
  // keyed by `EXCHANGE:BASE/QUOTE`, which is what the arbitrage scan reads.
  watchOrderbook: ({ symbol }: IBotConfiguration) => symbol,
};

/**
 * Bot state, all of it optional.
 *
 * A bot starts with an empty state object and the generator fills it in with
 * `??=` on its first tick, so nothing here is present until then. Declaring the
 * numbers as required said otherwise, and that made `typeof hybrid` incompatible
 * with `BotTemplate<any>` — which is why the strategy registry and the
 * get-strategies handler both failed to typecheck.
 */
type HybridState = {
  day?: string;
  openExposureQuote?: number;
  realizedPnlToday?: number;
  consecutiveLosses?: number;
  /**
   * What the council last said, and what last stopped it. Held only so the AI
   * action feed can report changes rather than restating the same view on every
   * candle; neither takes any part in a trading decision.
   */
  lastCouncilSignal?: Signal;
  lastRiskNote?: string;
};

type HybridSettings = z.infer<typeof hybrid.schema>;
type HybridConfig = IBotConfiguration<HybridSettings>;
type HybridContext = TBotContext<HybridConfig, HybridState>;
