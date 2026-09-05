import { convene, type CouncilOptions } from "../council.js";
import {
  isEntry,
  isExit,
  planPosition,
  type HeadAction,
  type HeadLimits,
  type HeadPortfolio,
  type OpenPosition,
} from "../head.js";
import { DEFAULT_RISK_LIMITS, type Candle, type CouncilVerdict, type MarketSnapshot } from "../types.js";
import { DEFAULT_PAPER_CONFIG, type PaperConfig } from "./simulator.js";

/**
 * Replaying the trading head over history.
 *
 * `replay()` in `simulator.ts` walks candles through `convene()` and
 * `applyRiskGovernor()`. That is the *strategy* path — a bot that buys and sells
 * on the council's vote alone. It is not what the head does, and it never was.
 *
 * The head runs `planPosition`, which holds the take profit, the trail, the
 * stop, the dead-money rule, the minimum hold and the cooldown. Those rules
 * decide every outcome the desk actually books, and until now not one of them
 * had been run against a single historical candle. The whole evidence base for
 * the system was four live trades.
 *
 * So this replays the real planner, on real candles, charging real costs. It
 * mirrors `head.service.ts` deliberately and in detail — the lifted council
 * limits, the peak reconstructed from candle highs, the UTC-day rollover of the
 * loss budget and the streak — because a backtest that models a slightly
 * different system measures a system nobody is running.
 *
 * What it deliberately does not model: partial fills, order rejection, and the
 * delay between deciding and filling. Exits fill at the next observed price, so
 * `exitRequestedAt` stays null here and the in-flight guard never fires. That
 * makes this optimistic about execution and honest about strategy, which is the
 * right bias for deciding whether an edge exists at all.
 */

/** One completed round trip, as the desk would book it. */
export type HeadTrade = {
  symbol: string;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  /** Notional committed at entry, in quote currency. */
  notional: number;
  entryFee: number;
  exitFee: number;
  /** Realised profit after both fees. The number that has to clear the floor. */
  netPnl: number;
  /** Which rule closed it. */
  exitAction: HeadAction;
  /** Council confidence at entry. */
  confidence: number;
  holdMs: number;
};

export type HeadReplayStats = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  feesPaid: number;
  avgWin: number;
  avgLoss: number;
  /** Gross profit over gross loss. Above 1 is a system that makes money. */
  profitFactor: number;
  /** Net profit per trade taken. The single most useful number here. */
  expectancy: number;
  /** Winning trades that banked less than the floor. The audit's core metric. */
  winsUnderFloor: number;
  winsAtOrOverFloor: number;
  /** Worst peak-to-trough on realised equity. */
  maxDrawdown: number;
  /** How each rule contributed, keyed by the action that closed the trade. */
  byExit: Record<string, { count: number; netPnl: number }>;
};

export type HeadReplayResult = {
  symbol: string;
  candles: number;
  decisions: number;
  trades: HeadTrade[];
  stats: HeadReplayStats;
  /** Still open when the data ran out, marked to the last close. */
  openAtEnd: { entryPrice: number; quantity: number; unrealisedPnl: number } | null;
  /** Buy and hold over the same window, in percent, for comparison. */
  buyHoldReturnPct: number;
};

export type HeadReplayOptions = {
  limits: HeadLimits;
  paper?: PaperConfig;
  council?: CouncilOptions;
  /** Candles required before the council may vote. Must warm the slowest indicator. */
  warmup?: number;
  /**
   * The profit floor a winning trade is measured against, in quote currency.
   * Reporting only — it does not change any decision.
   */
  profitFloorQuote?: number;
};

/** UTC midnight for an epoch, matching the day boundary `summariseBook` uses. */
function startOfDay(at: number): number {
  const d = new Date(at);

  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Highest high since the position opened — the reconstruction `positions.ts` does. */
function peakSince(candles: Candle[], openedAt: number, entryPrice: number): number {
  let peak = entryPrice;

  for (const candle of candles) {
    if (candle.timestamp < openedAt) continue;
    if (candle.high > peak) peak = candle.high;
  }

  return peak;
}

/**
 * The council limits the head hands to `convene`.
 *
 * Copied from `head.service.ts` rather than imported, because that module pulls
 * in Prisma and the whole daemon. Every portfolio-derived veto is lifted so the
 * council votes on direction only and the planner enforces the real budget —
 * the long comment at that call site explains why.
 */
function councilLimits() {
  return {
    ...DEFAULT_RISK_LIMITS,
    maxDailyLossQuote: Number.MAX_SAFE_INTEGER,
    maxConsecutiveLosses: Number.MAX_SAFE_INTEGER,
    maxTotalExposureQuote: Number.MAX_SAFE_INTEGER,
    killSwitch: false,
  };
}

function summarise(trades: HeadTrade[], floor: number): HeadReplayStats {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);

  const grossProfit = wins.reduce((sum, t) => sum + t.netPnl, 0);
  const grossLoss = losses.reduce((sum, t) => sum - t.netPnl, 0);
  const netPnl = trades.reduce((sum, t) => sum + t.netPnl, 0);

  const byExit: HeadReplayStats["byExit"] = {};
  for (const trade of trades) {
    const bucket = (byExit[trade.exitAction] ??= { count: 0, netPnl: 0 });
    bucket.count += 1;
    bucket.netPnl += trade.netPnl;
  }

  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of trades) {
    running += trade.netPnl;
    if (running > peak) peak = running;
    const drawdown = peak - running;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    netPnl,
    grossProfit,
    grossLoss,
    feesPaid: trades.reduce((sum, t) => sum + t.entryFee + t.exitFee, 0),
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    // A run with no losing trade has an undefined ratio, not an infinite one.
    // Reporting Infinity would poison every average taken across symbols.
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    expectancy: trades.length > 0 ? netPnl / trades.length : 0,
    winsUnderFloor: wins.filter((t) => t.netPnl < floor).length,
    winsAtOrOverFloor: wins.filter((t) => t.netPnl >= floor).length,
    maxDrawdown,
    byExit,
  };
}

/**
 * Walk one symbol's candles through the real planner.
 *
 * At step i the council sees candles[0..i] and nothing later, so there is no
 * look-ahead. Fills are charged the configured fee and adverse slippage on both
 * sides: buys lift, sells hit.
 */
export async function replayHead(
  symbol: string,
  candles: Candle[],
  options: HeadReplayOptions,
): Promise<HeadReplayResult> {
  const paper = options.paper ?? DEFAULT_PAPER_CONFIG;
  const limits = options.limits;
  const warmup = options.warmup ?? 35;
  const floor = options.profitFloorQuote ?? 3;
  const slip = paper.slippageBps / 10_000;
  const feeRate = paper.feeBps / 10_000;

  const trades: HeadTrade[] = [];

  let position: OpenPosition | null = null;
  let entryConfidence = 0;

  let realizedPnlToday = 0;
  let openedNotionalToday = 0;
  let consecutiveLosses = 0;
  let lastActionAt: number | null = null;
  let currentDay = candles.length > 0 ? startOfDay(candles[Math.min(warmup, candles.length - 1)].timestamp) : 0;

  let decisions = 0;

  for (let i = warmup; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const bar = window[window.length - 1];
    const price = bar.close;
    const now = bar.timestamp;

    // The day rolls over exactly where `summariseBook` puts it: UTC midnight.
    // The loss budget, the day's opening allowance and the losing streak clear
    // together, which is what makes a bad day cost a day rather than the install.
    const day = startOfDay(now);
    if (day !== currentDay) {
      currentDay = day;
      realizedPnlToday = 0;
      openedNotionalToday = 0;
      consecutiveLosses = 0;
    }

    const live: OpenPosition | null = position
      ? { ...position, peakPrice: peakSince(window, position.openedAt, position.entryPrice) }
      : null;

    const exposure = live ? live.entryPrice * live.quantity : 0;

    const snapshot: MarketSnapshot = { symbol, price, candles: window };

    const verdict: CouncilVerdict = await convene(
      snapshot,
      councilLimits(),
      { openExposureQuote: exposure, realizedPnlToday: 0, consecutiveLosses: 0, equityQuote: limits.equityQuote },
      options.council ?? {},
    );

    const portfolio: HeadPortfolio = {
      openExposureQuote: exposure,
      openPositions: live ? 1 : 0,
      realizedPnlToday,
      openedNotionalToday,
      consecutiveLosses,
      lastActionAt,
    };

    const plan = planPosition(snapshot, verdict, live, limits, portfolio, now);
    decisions += 1;

    if (plan.action === "hold") continue;

    if (isEntry(plan.action)) {
      // Pyramiding is not modelled: `loadOpenPositions` only ever surfaces one
      // position per symbol, so an `add` would be invisible to the planner on
      // the next pass. Skipping it here keeps the replay honest about that.
      if (live) continue;

      const fillPrice = price * (1 + slip);
      const quantity = plan.sizeQuote / fillPrice;
      if (!(quantity > 0)) continue;

      const notional = quantity * fillPrice;
      const fee = notional * feeRate;

      position = {
        smartTradeId: trades.length + 1,
        symbol,
        quantity,
        entryPrice: fillPrice,
        entryFeeQuote: fee,
        openedAt: now,
        peakPrice: fillPrice,
        takeProfitPrice: null,
        exitRequestedAt: null,
        exitRequestedAction: null,
      };
      entryConfidence = plan.confidence;

      openedNotionalToday += notional;
      lastActionAt = now;

      continue;
    }

    if (isExit(plan.action) && position) {
      const fillPrice = price * (1 - slip);
      const exitFee = position.quantity * fillPrice * feeRate;
      const netPnl = (fillPrice - position.entryPrice) * position.quantity - position.entryFeeQuote - exitFee;

      trades.push({
        symbol,
        openedAt: position.openedAt,
        closedAt: now,
        entryPrice: position.entryPrice,
        exitPrice: fillPrice,
        quantity: position.quantity,
        notional: position.entryPrice * position.quantity,
        entryFee: position.entryFeeQuote,
        exitFee,
        netPnl,
        exitAction: plan.action,
        confidence: entryConfidence,
        holdMs: now - position.openedAt,
      });

      realizedPnlToday += netPnl;
      consecutiveLosses = netPnl < 0 ? consecutiveLosses + 1 : 0;
      lastActionAt = now;
      position = null;
    }
  }

  const lastClose = candles[candles.length - 1]?.close ?? 0;
  const firstClose = candles[Math.min(warmup, candles.length - 1)]?.close ?? lastClose;

  return {
    symbol,
    candles: candles.length,
    decisions,
    trades,
    stats: summarise(trades, floor),
    openAtEnd: position
      ? {
          entryPrice: position.entryPrice,
          quantity: position.quantity,
          unrealisedPnl:
            (lastClose - position.entryPrice) * position.quantity -
            position.entryFeeQuote -
            lastClose * position.quantity * feeRate,
        }
      : null,
    buyHoldReturnPct: firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0,
  };
}

/** Roll several symbols' results into one desk-level view. */
export function aggregate(results: HeadReplayResult[], profitFloorQuote = 3): HeadReplayStats {
  return summarise(
    results.flatMap((r) => r.trades).sort((a, b) => a.closedAt - b.closedAt),
    profitFloorQuote,
  );
}
