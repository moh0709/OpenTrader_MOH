/**
 * Grid ladder model.
 *
 * A grid bot is a set of price levels, each of which repeatedly buys and sells.
 * Aggregate profit hides which of those levels is actually doing the work, so
 * this projects every order and closed trade back onto the level it belongs to.
 * The result is a ladder you can read top to bottom: which rungs are holding
 * stock, which are waiting to buy, and which have earned anything.
 *
 * Bots get reconfigured, and orders placed under an older grid do not line up
 * with the current one. Those are matched to the nearest level within half a
 * grid step and otherwise reported as off-grid rather than silently dropped.
 */
import type { AnalyticsBot, AnalyticsSmartTrade, OpenPosition, RoundTrip } from "./types.js";
import { EPSILON } from "./types.js";
import { isEntryOrder, isLiveOrder } from "./round-trips.js";

export type GridLine = {
  price: number;
  quantity: number;
};

export type GridLevel = {
  index: number;
  price: number;
  quantity: number;

  /** Entry orders resting at this level, waiting to buy. */
  pendingBuys: number;
  /** Positions bought at this level and not yet sold. */
  holding: number;
  holdingQuantity: number;
  holdingCostBasis: number;
  /** Positions at this level whose exit order was cancelled or revoked. */
  abandoned: number;

  /** Round trips that entered at this level. */
  completedTrades: number;
  realizedPnl: number;

  /** Where this level sits relative to the live price. */
  side: "above" | "below" | "at";
  distancePercent: number | null;
};

export type GridModel = {
  botId: number;
  name: string;
  symbol: string;
  /** False when the bot template is not a grid, in which case levels is empty. */
  isGrid: boolean;

  levels: GridLevel[];
  lowerBound: number | null;
  upperBound: number | null;
  stepAverage: number | null;

  markPrice: number | null;
  /** True when the live price has left the configured grid range. */
  outOfRange: boolean;

  /** Orders and trades that did not line up with any current level. */
  offGridTrades: number;
  offGridPnl: number;

  totals: {
    levels: number;
    levelsWithFills: number;
    /** Percent of levels that have ever closed a trade. */
    fillRate: number;
    pendingBuys: number;
    holding: number;
    abandoned: number;
    completedTrades: number;
    realizedPnl: number;
    bestLevelPrice: number | null;
    bestLevelPnl: number;
  };
};

export function parseGridLines(settings: Record<string, unknown>): GridLine[] {
  const raw = (settings as { gridLines?: unknown }).gridLines;
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((line): line is GridLine => {
      if (!line || typeof line !== "object") return false;
      const candidate = line as Partial<GridLine>;

      return typeof candidate.price === "number" && typeof candidate.quantity === "number";
    })
    .map((line) => ({ price: line.price, quantity: line.quantity }))
    .sort((a, b) => b.price - a.price); // highest level first, so the ladder reads top down
}

/** Average distance between adjacent levels, used as the matching tolerance. */
function averageStep(lines: GridLine[]): number | null {
  if (lines.length < 2) return null;

  let total = 0;
  for (let i = 1; i < lines.length; i += 1) total += Math.abs(lines[i - 1]!.price - lines[i]!.price);

  return total / (lines.length - 1);
}

function nearestLevelIndex(price: number, lines: GridLine[], tolerance: number): number | null {
  let bestIndex: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < lines.length; i += 1) {
    const distance = Math.abs(lines[i]!.price - price);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return bestIndex !== null && bestDistance <= tolerance ? bestIndex : null;
}

export function buildGridModel(
  bot: AnalyticsBot,
  trades: AnalyticsSmartTrade[],
  roundTrips: RoundTrip[],
  openPositions: OpenPosition[],
  markPrice: number | null,
): GridModel {
  const lines = parseGridLines(bot.settings);
  const step = averageStep(lines);
  // Half a step means every price belongs to at most one level.
  const tolerance = step !== null ? step / 2 : Number.POSITIVE_INFINITY;

  const levels: GridLevel[] = lines.map((line, index) => ({
    index,
    price: line.price,
    quantity: line.quantity,
    pendingBuys: 0,
    holding: 0,
    holdingQuantity: 0,
    holdingCostBasis: 0,
    abandoned: 0,
    completedTrades: 0,
    realizedPnl: 0,
    side: markPrice === null ? "at" : line.price > markPrice ? "above" : line.price < markPrice ? "below" : "at",
    distancePercent:
      markPrice !== null && markPrice > EPSILON ? ((line.price - markPrice) / markPrice) * 100 : null,
  }));

  let offGridTrades = 0;
  let offGridPnl = 0;

  // Resting entry orders - the levels currently waiting to buy.
  for (const trade of trades) {
    for (const order of trade.orders) {
      if (!isEntryOrder(order) || !isLiveOrder(order) || order.price === null) continue;

      const index = nearestLevelIndex(order.price, lines, tolerance);
      if (index !== null) levels[index]!.pendingBuys += 1;
    }
  }

  // Positions currently holding stock bought at a level.
  for (const position of openPositions) {
    const index = nearestLevelIndex(position.entryPrice, lines, tolerance);
    if (index === null) continue;

    const level = levels[index]!;
    level.holding += 1;
    level.holdingQuantity += position.quantity;
    level.holdingCostBasis += position.costBasis;
    if (position.exitState !== "live") level.abandoned += 1;
  }

  // Realised profit, attributed to the level the trade entered at.
  for (const roundTrip of roundTrips) {
    const index = nearestLevelIndex(roundTrip.entryPrice, lines, tolerance);

    if (index === null) {
      offGridTrades += 1;
      offGridPnl += roundTrip.netPnl;
      continue;
    }

    levels[index]!.completedTrades += 1;
    levels[index]!.realizedPnl += roundTrip.netPnl;
  }

  const prices = lines.map((l) => l.price);
  const lowerBound = prices.length > 0 ? Math.min(...prices) : null;
  const upperBound = prices.length > 0 ? Math.max(...prices) : null;
  const levelsWithFills = levels.filter((l) => l.completedTrades > 0).length;
  const best = levels.reduce<GridLevel | null>(
    (acc, level) => (acc === null || level.realizedPnl > acc.realizedPnl ? level : acc),
    null,
  );

  return {
    botId: bot.id,
    name: bot.name,
    symbol: bot.symbol,
    isGrid: lines.length > 0,

    levels,
    lowerBound,
    upperBound,
    stepAverage: step,

    markPrice,
    outOfRange:
      markPrice !== null && lowerBound !== null && upperBound !== null
        ? markPrice < lowerBound || markPrice > upperBound
        : false,

    offGridTrades,
    offGridPnl,

    totals: {
      levels: levels.length,
      levelsWithFills,
      fillRate: levels.length > 0 ? (levelsWithFills / levels.length) * 100 : 0,
      pendingBuys: levels.reduce((sum, l) => sum + l.pendingBuys, 0),
      holding: levels.reduce((sum, l) => sum + l.holding, 0),
      abandoned: levels.reduce((sum, l) => sum + l.abandoned, 0),
      completedTrades: levels.reduce((sum, l) => sum + l.completedTrades, 0),
      realizedPnl: levels.reduce((sum, l) => sum + l.realizedPnl, 0),
      bestLevelPrice: best && best.realizedPnl > EPSILON ? best.price : null,
      bestLevelPnl: best?.realizedPnl ?? 0,
    },
  };
}
