/**
 * Round-trip extraction: turning raw orders into closed trades with realised P&L.
 *
 * A round trip is one full cycle of a SmartTrade - the entry fills, then a take
 * profit or stop loss fills against it. The profit formula matches the one the
 * platform already uses for backtesting reports
 * (`packages/backtesting/src/backtesting-report.ts`), generalised so it also
 * handles DCA safety orders and ladder entries/exits, where a single cycle is
 * made up of several fills at different prices.
 */
import type { AnalyticsOrder, AnalyticsSmartTrade, ExitKind, RoundTrip, TradeOutcome } from "./types.js";
import { DEAD_ORDER_STATUSES, ENTRY_ENTITY_TYPES, EPSILON, EXIT_ENTITY_TYPES, LIVE_ORDER_STATUSES } from "./types.js";

const isFilled = (order: AnalyticsOrder) => order.status === "Filled" && order.filledPrice !== null;

export const isEntryOrder = (order: AnalyticsOrder) =>
  (ENTRY_ENTITY_TYPES as readonly string[]).includes(order.entityType);

export const isExitOrder = (order: AnalyticsOrder) =>
  (EXIT_ENTITY_TYPES as readonly string[]).includes(order.entityType);

export const isLiveOrder = (order: AnalyticsOrder) =>
  (LIVE_ORDER_STATUSES as readonly string[]).includes(order.status);

export const isDeadOrder = (order: AnalyticsOrder) =>
  (DEAD_ORDER_STATUSES as readonly string[]).includes(order.status);

export const filledEntries = (trade: AnalyticsSmartTrade) => trade.orders.filter((o) => isEntryOrder(o) && isFilled(o));
export const filledExits = (trade: AnalyticsSmartTrade) => trade.orders.filter((o) => isExitOrder(o) && isFilled(o));

/**
 * Quantity-weighted average fill price and totals for a set of filled orders.
 * Weighting matters for DCA and ladder trades, where one cycle has several fills
 * at different prices.
 */
export function aggregateFills(orders: AnalyticsOrder[]) {
  let quantity = 0;
  let notional = 0;
  let fees = 0;
  let firstAt = Number.POSITIVE_INFINITY;
  let lastAt = Number.NEGATIVE_INFINITY;

  for (const order of orders) {
    quantity += order.quantity;
    notional += order.filledPrice! * order.quantity;
    fees += order.fee ?? 0;

    const at = (order.filledAt ?? order.updatedAt).getTime();
    if (at < firstAt) firstAt = at;
    if (at > lastAt) lastAt = at;
  }

  return {
    count: orders.length,
    quantity,
    notional,
    fees,
    averagePrice: quantity > EPSILON ? notional / quantity : 0,
    firstAt: Number.isFinite(firstAt) ? firstAt : 0,
    lastAt: Number.isFinite(lastAt) ? lastAt : 0,
  };
}

export function classifyOutcome(netPnl: number): TradeOutcome {
  if (netPnl > EPSILON) return "win";
  if (netPnl < -EPSILON) return "loss";
  return "breakeven";
}

/**
 * Build a round trip from a SmartTrade, or null when the cycle has not closed.
 *
 * "Closed" means at least one exit order filled - the same rule the platform
 * `bot.completedSmartTrades` endpoint already uses.
 */
export function toRoundTrip(trade: AnalyticsSmartTrade): RoundTrip | null {
  const entries = filledEntries(trade);
  const exits = filledExits(trade);

  if (entries.length === 0 || exits.length === 0) return null;

  const entry = aggregateFills(entries);
  const exit = aggregateFills(exits);

  // Long cycles buy then sell, short cycles do the reverse. Grid and DCA bots are
  // long-only today, but the sign is derived rather than assumed.
  const entrySide = entries[0]!.side;
  const direction = entrySide === "Buy" ? 1 : -1;

  // Only the quantity present on both legs has actually round-tripped.
  const matchedQuantity = Math.min(entry.quantity, exit.quantity);
  const costBasis = entry.averagePrice * matchedQuantity;
  const proceeds = exit.averagePrice * matchedQuantity;

  const grossPnl = (exit.averagePrice - entry.averagePrice) * matchedQuantity * direction;
  const fees = entry.fees + exit.fees;
  const netPnl = grossPnl - fees;

  const exitKind: ExitKind = exits.some((o) => o.entityType === "StopLossOrder") ? "stopLoss" : "takeProfit";

  return {
    smartTradeId: trade.id,
    botId: trade.botId,
    symbol: trade.symbol,
    tradeType: trade.type,
    direction: entrySide,
    exitKind,

    quantity: matchedQuantity,
    entryPrice: entry.averagePrice,
    exitPrice: exit.averagePrice,
    costBasis,
    proceeds,

    entryFillCount: entry.count,
    exitFillCount: exit.count,
    fullyClosed: exit.quantity + EPSILON >= entry.quantity,

    grossPnl,
    fees,
    netPnl,
    pnlPercent: costBasis > EPSILON ? (grossPnl / costBasis) * 100 : 0,

    entryAt: entry.firstAt,
    exitAt: exit.lastAt,
    holdMs: Math.max(0, exit.lastAt - entry.firstAt),

    outcome: classifyOutcome(netPnl),
  };
}

/** Every closed round trip in the given trades, newest close first. */
export function toRoundTrips(trades: AnalyticsSmartTrade[]): RoundTrip[] {
  return trades
    .map(toRoundTrip)
    .filter((rt): rt is RoundTrip => rt !== null)
    .sort((a, b) => b.exitAt - a.exitAt);
}

export type RoundTripStats = {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** Percent of decided trades that won. Null when nothing has closed yet. */
  winRate: number | null;
  grossPnl: number;
  fees: number;
  netPnl: number;
  /** Total capital deployed across all closed trades. */
  volume: number;
  averagePnl: number;
  averagePnlPercent: number;
  bestTrade: number;
  worstTrade: number;
  grossWin: number;
  grossLoss: number;
  /** Gross win divided by gross loss. Null when there are no losses to divide by. */
  profitFactor: number | null;
  averageWin: number;
  averageLoss: number;
  /** Expected net profit per trade. */
  expectancy: number;
  averageHoldMs: number;
  medianHoldMs: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  firstTradeAt: number | null;
  lastTradeAt: number | null;
  /**
   * True when nothing has ever lost. This is the normal state for a grid bot,
   * whose take profit sits above its entry by construction, and it tells the UI
   * that a bare win-rate figure would be misleading on its own.
   */
  losslessSoFar: boolean;
};

export const EMPTY_ROUND_TRIP_STATS: RoundTripStats = {
  trades: 0,
  wins: 0,
  losses: 0,
  breakeven: 0,
  winRate: null,
  grossPnl: 0,
  fees: 0,
  netPnl: 0,
  volume: 0,
  averagePnl: 0,
  averagePnlPercent: 0,
  bestTrade: 0,
  worstTrade: 0,
  grossWin: 0,
  grossLoss: 0,
  profitFactor: null,
  averageWin: 0,
  averageLoss: 0,
  expectancy: 0,
  averageHoldMs: 0,
  medianHoldMs: 0,
  maxConsecutiveWins: 0,
  maxConsecutiveLosses: 0,
  firstTradeAt: null,
  lastTradeAt: null,
  losslessSoFar: false,
};

function median(values: number[]) {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function summarizeRoundTrips(roundTrips: RoundTrip[]): RoundTripStats {
  if (roundTrips.length === 0) return { ...EMPTY_ROUND_TRIP_STATS };

  // Streaks have to be counted in the order the trades actually closed.
  const chronological = [...roundTrips].sort((a, b) => a.exitAt - b.exitAt);

  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let grossPnl = 0;
  let fees = 0;
  let netPnl = 0;
  let volume = 0;
  let pnlPercentSum = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let holdSum = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;

  for (const rt of chronological) {
    grossPnl += rt.grossPnl;
    fees += rt.fees;
    netPnl += rt.netPnl;
    volume += rt.costBasis;
    pnlPercentSum += rt.pnlPercent;
    holdSum += rt.holdMs;

    if (rt.outcome === "win") {
      wins += 1;
      grossWin += rt.netPnl;
      winStreak += 1;
      lossStreak = 0;
      maxConsecutiveWins = Math.max(maxConsecutiveWins, winStreak);
    } else if (rt.outcome === "loss") {
      losses += 1;
      grossLoss += Math.abs(rt.netPnl);
      lossStreak += 1;
      winStreak = 0;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, lossStreak);
    } else {
      breakeven += 1;
      winStreak = 0;
      lossStreak = 0;
    }
  }

  const decided = wins + losses;
  const netPnls = chronological.map((rt) => rt.netPnl);

  return {
    trades: chronological.length,
    wins,
    losses,
    breakeven,
    winRate: decided > 0 ? (wins / decided) * 100 : null,
    grossPnl,
    fees,
    netPnl,
    volume,
    averagePnl: netPnl / chronological.length,
    averagePnlPercent: pnlPercentSum / chronological.length,
    bestTrade: Math.max(...netPnls),
    worstTrade: Math.min(...netPnls),
    grossWin,
    grossLoss,
    profitFactor: grossLoss > EPSILON ? grossWin / grossLoss : null,
    averageWin: wins > 0 ? grossWin / wins : 0,
    averageLoss: losses > 0 ? grossLoss / losses : 0,
    expectancy: netPnl / chronological.length,
    averageHoldMs: holdSum / chronological.length,
    medianHoldMs: median(chronological.map((rt) => rt.holdMs)),
    maxConsecutiveWins,
    maxConsecutiveLosses,
    firstTradeAt: chronological[0]!.exitAt,
    lastTradeAt: chronological[chronological.length - 1]!.exitAt,
    losslessSoFar: losses === 0,
  };
}

/** Round trips whose exit landed inside the window `[from, to]` (epoch ms). */
export function filterByExitWindow(roundTrips: RoundTrip[], from: number | null, to: number | null) {
  return roundTrips.filter((rt) => (from === null || rt.exitAt >= from) && (to === null || rt.exitAt <= to));
}
