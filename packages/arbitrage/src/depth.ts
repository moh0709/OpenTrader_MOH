import type { BookLevel, FillResult } from "./types.js";

const EMPTY_FILL: FillResult = {
  avgPrice: 0,
  filledQty: 0,
  notional: 0,
  complete: false,
  levelsConsumed: 0,
  slippageBps: 0,
};

/**
 * Walk an order book consuming liquidity until `targetQty` is filled.
 *
 * Levels must already be sorted the way the taker consumes them: asks
 * ascending (cheapest first) when buying, bids descending (highest first) when
 * selling. `sortLevels` is provided for callers that cannot guarantee this.
 *
 * The returned `avgPrice` is the volume-weighted average across every level
 * touched, which is the price a market order would actually realise. When the
 * book is too thin, `complete` is false and the caller must not treat the
 * partial VWAP as tradable at the full size.
 */
export function walkBook(levels: BookLevel[], targetQty: number): FillResult {
  if (targetQty <= 0 || levels.length === 0) return { ...EMPTY_FILL };

  const bestPrice = levels[0].price;
  if (!Number.isFinite(bestPrice) || bestPrice <= 0) return { ...EMPTY_FILL };

  let remaining = targetQty;
  let notional = 0;
  let filledQty = 0;
  let levelsConsumed = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    // Defensive: exchanges occasionally emit zero/negative or malformed levels.
    if (!Number.isFinite(level.price) || !Number.isFinite(level.quantity)) continue;
    if (level.price <= 0 || level.quantity <= 0) continue;

    const take = Math.min(remaining, level.quantity);
    notional += take * level.price;
    filledQty += take;
    remaining -= take;
    levelsConsumed++;
  }

  if (filledQty <= 0) return { ...EMPTY_FILL };

  const avgPrice = notional / filledQty;
  // Slippage is unsigned: it measures distance from the best price in the
  // direction that hurts, which is upward for asks and downward for bids.
  const slippageBps = Math.abs((avgPrice - bestPrice) / bestPrice) * 10_000;

  return {
    avgPrice,
    filledQty,
    notional,
    complete: remaining <= 1e-12,
    levelsConsumed,
    slippageBps,
  };
}

/**
 * Total base quantity resting on a book, used for depth sanity checks.
 */
export function totalDepth(levels: BookLevel[]): number {
  return levels.reduce((sum, l) => (Number.isFinite(l.quantity) && l.quantity > 0 ? sum + l.quantity : sum), 0);
}

/**
 * Sort levels into taker-consumption order.
 * Use `"asks"` when buying and `"bids"` when selling.
 */
export function sortLevels(levels: BookLevel[], side: "asks" | "bids"): BookLevel[] {
  const copy = [...levels];
  copy.sort((a, b) => (side === "asks" ? a.price - b.price : b.price - a.price));
  return copy;
}
