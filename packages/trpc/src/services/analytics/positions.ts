/**
 * Position analysis: what is still open, what it is worth right now, and what
 * was walked away from.
 *
 * A grid bot takes profit above its entry by construction, so realised losses
 * are close to impossible and a bare win rate reads 100% forever. The honest
 * picture needs two more lenses, both of which live here:
 *
 *  - floating   - the entry filled and the exit is still resting. Marked to the
 *                 live price, this is where red actually shows up.
 *  - abandoned  - the entry filled but the exit was cancelled or revoked, which
 *                 is what happens to resting take profits when a bot is stopped.
 *                 The capital is still committed and the profit that exit would
 *                 have earned is gone unless the bot is put back on that level.
 */
import type {
  AnalyticsSmartTrade,
  AnalyticsTicker,
  OpenPosition,
  PendingEntry,
} from "./types.js";
import { EPSILON } from "./types.js";
import { aggregateFills, filledEntries, filledExits, isDeadOrder, isEntryOrder, isExitOrder, isLiveOrder } from "./round-trips.js";

export type TickerLookup = (symbol: string) => AnalyticsTicker | undefined;

const markPriceOf = (ticker: AnalyticsTicker | undefined) => {
  if (!ticker) return null;

  return ticker.last ?? ticker.bid ?? ticker.ask ?? null;
};

/**
 * Positions whose entry filled and which have not been closed.
 *
 * Trades that already produced a round trip are excluded by the filled-exit
 * check, so a position appears in exactly one of the two views.
 */
export function toOpenPositions(
  trades: AnalyticsSmartTrade[],
  tickerFor: TickerLookup,
  now: number,
): OpenPosition[] {
  const positions: OpenPosition[] = [];

  for (const trade of trades) {
    const entries = filledEntries(trade);
    if (entries.length === 0) continue;
    if (filledExits(trade).length > 0) continue; // already closed - it is a round trip

    const entry = aggregateFills(entries);
    if (entry.quantity <= EPSILON) continue;

    const direction = entries[0]!.side === "Buy" ? 1 : -1;
    const exitOrders = trade.orders.filter(isExitOrder);
    const liveExit = exitOrders.find(isLiveOrder);
    const deadExit = exitOrders.find(isDeadOrder);

    const exitState: OpenPosition["exitState"] = liveExit ? "live" : deadExit ? "abandoned" : "missing";
    const exitOrder = liveExit ?? deadExit ?? null;
    const targetPrice = exitOrder?.price ?? null;

    const ticker = tickerFor(trade.symbol);
    const markPrice = markPriceOf(ticker);

    const costBasis = entry.averagePrice * entry.quantity;
    const marketValue = markPrice !== null ? markPrice * entry.quantity : null;
    const floatingPnl = markPrice !== null ? (markPrice - entry.averagePrice) * entry.quantity * direction : null;

    positions.push({
      smartTradeId: trade.id,
      botId: trade.botId,
      symbol: trade.symbol,
      direction: entries[0]!.side,
      quantity: entry.quantity,
      entryPrice: entry.averagePrice,
      costBasis,
      entryAt: entry.firstAt,
      ageMs: Math.max(0, now - entry.firstAt),

      markPrice,
      marketValue,
      floatingPnl,
      floatingPnlPercent: floatingPnl !== null && costBasis > EPSILON ? (floatingPnl / costBasis) * 100 : null,

      targetPrice,
      potentialPnl:
        targetPrice !== null ? (targetPrice - entry.averagePrice) * entry.quantity * direction : null,
      distanceToTargetPercent:
        targetPrice !== null && markPrice !== null && markPrice > EPSILON
          ? ((targetPrice - markPrice) / markPrice) * 100
          : null,

      exitState,
      exitStatus: exitOrder?.status ?? null,
      underwater: floatingPnl !== null && floatingPnl < -EPSILON,
    });
  }

  return positions.sort((a, b) => b.entryAt - a.entryAt);
}

/**
 * Entry orders that are resting but have not filled. No capital is committed
 * yet, so these are tracked separately from open positions.
 */
export function toPendingEntries(
  trades: AnalyticsSmartTrade[],
  tickerFor: TickerLookup,
  now: number,
): PendingEntry[] {
  const pending: PendingEntry[] = [];

  for (const trade of trades) {
    if (filledEntries(trade).length > 0) continue; // entry already filled

    for (const order of trade.orders) {
      if (!isEntryOrder(order) || !isLiveOrder(order)) continue;

      const markPrice = markPriceOf(tickerFor(trade.symbol));

      pending.push({
        smartTradeId: trade.id,
        botId: trade.botId,
        symbol: trade.symbol,
        side: order.side,
        price: order.price,
        quantity: order.quantity,
        status: order.status,
        createdAt: order.createdAt.getTime(),
        ageMs: Math.max(0, now - order.createdAt.getTime()),
        distanceToFillPercent:
          order.price !== null && markPrice !== null && markPrice > EPSILON
            ? ((order.price - markPrice) / markPrice) * 100
            : null,
      });
    }
  }

  return pending.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
}

export type PositionStats = {
  /** Every position whose entry filled and which has not closed. */
  open: number;
  quantity: number;
  costBasis: number;
  marketValue: number | null;
  floatingPnl: number | null;
  floatingPnlPercent: number | null;
  underwater: number;
  /** Sum of the losses only, so a few bad positions are not hidden by good ones. */
  floatingDrawdown: number;

  /** Positions with a live exit order resting on the exchange. */
  live: number;
  liveCostBasis: number;
  /** Profit these positions earn if every resting exit fills at its limit price. */
  pendingProfit: number;

  /** Positions whose exit was cancelled or revoked, plus those with no exit at all. */
  abandoned: number;
  abandonedCostBasis: number;
  /** Profit given up when those exits were cancelled. */
  abandonedProfit: number;

  oldestAgeMs: number | null;
  /** Whether a mark price was available for every position. */
  marked: boolean;
};

export const EMPTY_POSITION_STATS: PositionStats = {
  open: 0,
  quantity: 0,
  costBasis: 0,
  marketValue: 0,
  floatingPnl: 0,
  floatingPnlPercent: 0,
  underwater: 0,
  floatingDrawdown: 0,
  live: 0,
  liveCostBasis: 0,
  pendingProfit: 0,
  abandoned: 0,
  abandonedCostBasis: 0,
  abandonedProfit: 0,
  oldestAgeMs: null,
  marked: true,
};

export function summarizePositions(positions: OpenPosition[]): PositionStats {
  if (positions.length === 0) return { ...EMPTY_POSITION_STATS };

  let quantity = 0;
  let costBasis = 0;
  let marketValue = 0;
  let floatingPnl = 0;
  let underwater = 0;
  let floatingDrawdown = 0;
  let live = 0;
  let liveCostBasis = 0;
  let pendingProfit = 0;
  let abandoned = 0;
  let abandonedCostBasis = 0;
  let abandonedProfit = 0;
  let oldestAgeMs = 0;
  let marked = true;

  for (const position of positions) {
    quantity += position.quantity;
    costBasis += position.costBasis;
    oldestAgeMs = Math.max(oldestAgeMs, position.ageMs);

    if (position.marketValue === null || position.floatingPnl === null) {
      marked = false;
    } else {
      marketValue += position.marketValue;
      floatingPnl += position.floatingPnl;
      if (position.floatingPnl < -EPSILON) floatingDrawdown += position.floatingPnl;
    }

    if (position.underwater) underwater += 1;

    if (position.exitState === "live") {
      live += 1;
      liveCostBasis += position.costBasis;
      pendingProfit += position.potentialPnl ?? 0;
    } else {
      abandoned += 1;
      abandonedCostBasis += position.costBasis;
      abandonedProfit += position.potentialPnl ?? 0;
    }
  }

  return {
    open: positions.length,
    quantity,
    costBasis,
    marketValue: marked ? marketValue : null,
    floatingPnl: marked ? floatingPnl : null,
    floatingPnlPercent: marked && costBasis > EPSILON ? (floatingPnl / costBasis) * 100 : null,
    underwater,
    floatingDrawdown,
    live,
    liveCostBasis,
    pendingProfit,
    abandoned,
    abandonedCostBasis,
    abandonedProfit,
    oldestAgeMs,
    marked,
  };
}
