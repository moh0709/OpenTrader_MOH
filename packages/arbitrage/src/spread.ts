import { sortLevels, walkBook } from "./depth.js";
import type { ArbEvaluation, ArbitrageConfig, RejectReason, VenueQuote } from "./types.js";

const BPS = 10_000;

/**
 * Age of a book in ms. Returns `null` when the venue did not supply a usable
 * timestamp, in which case freshness cannot be asserted either way and the
 * staleness check is skipped rather than guessed at.
 */
export function bookAge(book: { timestamp: number }, now: number): number | null {
  if (!Number.isFinite(book.timestamp) || book.timestamp <= 0) return null;
  return Math.max(0, now - book.timestamp);
}

/**
 * True when a single venue's book is crossed or locked (best bid >= best ask).
 * A real book never crosses; when one does, the feed is broken or mid-update,
 * and any spread computed against it is fiction.
 */
export function isCrossed(quote: VenueQuote): boolean {
  const bestAsk = sortLevels(quote.book.asks, "asks")[0]?.price;
  const bestBid = sortLevels(quote.book.bids, "bids")[0]?.price;
  if (!bestAsk || !bestBid) return false;
  return bestBid >= bestAsk;
}

/**
 * Evaluate buying `qty` on `buySide` and selling it on `sellSide`, fully costed.
 *
 * This is the function that separates a real opportunity from the phantom
 * spreads that naive top-of-book scanners report. It walks both books to the
 * requested size, charges taker fees on both legs, and applies transfer cost,
 * then reports the naive top-of-book number alongside the real one so the
 * difference is visible rather than hidden.
 */
export function evaluateDirection(
  buySide: VenueQuote,
  sellSide: VenueQuote,
  config: ArbitrageConfig,
  now: number = Date.now(),
): ArbEvaluation {
  const rejections: RejectReason[] = [];
  const qty = config.tradeQty;

  const asks = sortLevels(buySide.book.asks, "asks");
  const bids = sortLevels(sellSide.book.bids, "bids");

  const buyAgeRaw = bookAge(buySide.book, now);
  const sellAgeRaw = bookAge(sellSide.book, now);
  const bookAgeMs = Math.max(buyAgeRaw ?? 0, sellAgeRaw ?? 0);

  const base: ArbEvaluation = {
    symbol: buySide.symbol,
    buyVenue: buySide.venue,
    sellVenue: sellSide.venue,
    qty,
    buyAvgPrice: 0,
    sellAvgPrice: 0,
    topOfBookSpreadBps: 0,
    grossSpreadBps: 0,
    netSpreadBps: 0,
    netProfitQuote: 0,
    buySlippageBps: 0,
    sellSlippageBps: 0,
    executable: false,
    rejections,
    bookAgeMs,
  };

  if (buySide.venue === sellSide.venue) {
    rejections.push("SAME_VENUE");
    return base;
  }

  if (asks.length === 0 || bids.length === 0) {
    rejections.push("EMPTY_BOOK");
    return base;
  }

  // Staleness is only assertable when the venue timestamped the book.
  if ((buyAgeRaw !== null && buyAgeRaw > config.maxBookAgeMs) || (sellAgeRaw !== null && sellAgeRaw > config.maxBookAgeMs)) {
    rejections.push("STALE_BOOK");
  }

  if (isCrossed(buySide) || isCrossed(sellSide)) {
    rejections.push("CROSSED_BOOK");
  }

  const bestAsk = asks[0].price;
  const bestBid = bids[0].price;
  base.topOfBookSpreadBps = ((bestBid - bestAsk) / bestAsk) * BPS;

  const buyFill = walkBook(asks, qty);
  const sellFill = walkBook(bids, qty);

  if (!buyFill.complete || !sellFill.complete) {
    rejections.push("INSUFFICIENT_DEPTH");
  }

  if (buyFill.filledQty <= 0 || sellFill.filledQty <= 0) {
    rejections.push("EMPTY_BOOK");
    return base;
  }

  base.buyAvgPrice = buyFill.avgPrice;
  base.sellAvgPrice = sellFill.avgPrice;
  base.buySlippageBps = buyFill.slippageBps;
  base.sellSlippageBps = sellFill.slippageBps;
  base.grossSpreadBps = ((sellFill.avgPrice - buyFill.avgPrice) / buyFill.avgPrice) * BPS;

  // A spread far outside what real markets produce means bad data, not profit.
  if (Math.abs(base.topOfBookSpreadBps) > config.maxPlausibleSpreadBps) {
    rejections.push("IMPLAUSIBLE_SPREAD");
  }

  // Cost both legs at the quantity that actually filled.
  const tradedQty = Math.min(buyFill.filledQty, sellFill.filledQty);
  const buyNotional = buyFill.avgPrice * tradedQty;
  const sellNotional = sellFill.avgPrice * tradedQty;

  const buyFeeBps = Number.isFinite(buySide.takerFeeBps) ? buySide.takerFeeBps : config.defaultTakerFeeBps;
  const sellFeeBps = Number.isFinite(sellSide.takerFeeBps) ? sellSide.takerFeeBps : config.defaultTakerFeeBps;

  const cost = buyNotional * (1 + buyFeeBps / BPS);
  const proceeds = sellNotional * (1 - sellFeeBps / BPS);
  const transferCost = buyNotional * (config.transferCostBps / BPS);

  base.netProfitQuote = proceeds - cost - transferCost;
  base.netSpreadBps = buyNotional > 0 ? (base.netProfitQuote / buyNotional) * BPS : 0;

  if (base.netSpreadBps <= 0) {
    rejections.push("NEGATIVE_AFTER_COSTS");
  } else if (base.netSpreadBps < config.minNetSpreadBps) {
    rejections.push("BELOW_MIN_PROFIT");
  }

  base.executable = rejections.length === 0;
  return base;
}

/**
 * Evaluate both directions between two venues and return them.
 * At most one direction can be profitable at a time.
 */
export function evaluatePair(a: VenueQuote, b: VenueQuote, config: ArbitrageConfig, now = Date.now()): ArbEvaluation[] {
  return [evaluateDirection(a, b, config, now), evaluateDirection(b, a, config, now)];
}
