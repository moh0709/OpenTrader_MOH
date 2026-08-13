import type { IOrderbook } from "@opentrader/types";

/**
 * A single price level in an order book.
 * Matches the shape of `IAsk` / `IBid` from `@opentrader/types`.
 */
export type BookLevel = {
  price: number;
  quantity: number;
};

/**
 * Result of walking an order book to fill a target quantity.
 *
 * This is the core of honest spread evaluation: the price you actually get is
 * the volume-weighted average across every level you consume, never the top of
 * the book.
 */
export type FillResult = {
  /** Volume-weighted average price across all consumed levels. */
  avgPrice: number;
  /** Base quantity actually filled (< target when the book is too thin). */
  filledQty: number;
  /** Quote-currency value of the fill, before fees. */
  notional: number;
  /** True when the book had enough depth to fill the full target. */
  complete: boolean;
  /** Number of price levels consumed. */
  levelsConsumed: number;
  /**
   * Cost of walking the book, in basis points relative to the best price.
   * Zero when the whole order fits on the top level.
   */
  slippageBps: number;
};

/**
 * A tradable quote from one venue, with the fee that venue would charge.
 */
export type VenueQuote = {
  /** Exchange identifier, e.g. "BINANCE". */
  venue: string;
  symbol: string;
  book: IOrderbook;
  /** Taker fee in basis points (e.g. 10 = 0.10%). */
  takerFeeBps: number;
};

/**
 * Why a candidate opportunity was rejected. An opportunity may collect several.
 */
export type RejectReason =
  | "SAME_VENUE"
  | "EMPTY_BOOK"
  | "STALE_BOOK"
  | "CROSSED_BOOK"
  | "INSUFFICIENT_DEPTH"
  | "IMPLAUSIBLE_SPREAD"
  | "BELOW_MIN_PROFIT"
  | "NEGATIVE_AFTER_COSTS";

export type ArbitrageConfig = {
  /** Base quantity to evaluate the spread at. Spread is size-dependent. */
  tradeQty: number;
  /** Minimum net spread, after all costs, required to act. */
  minNetSpreadBps: number;
  /** Reject books older than this. Stale books are the #1 source of phantom spreads. */
  maxBookAgeMs: number;
  /**
   * Spreads wider than this are treated as bad data rather than free money.
   * Real cross-venue spreads on liquid pairs are single-digit to low-double-digit bps.
   */
  maxPlausibleSpreadBps: number;
  /**
   * Cost of moving value between venues, in bps. Set to 0 when running
   * pre-funded inventory on both venues (the normal professional setup).
   */
  transferCostBps: number;
  /** Default taker fee applied when a venue does not report one. */
  defaultTakerFeeBps: number;
};

export const DEFAULT_ARBITRAGE_CONFIG: ArbitrageConfig = {
  tradeQty: 0.01,
  minNetSpreadBps: 8,
  maxBookAgeMs: 5_000,
  maxPlausibleSpreadBps: 500,
  transferCostBps: 0,
  defaultTakerFeeBps: 10,
};

/**
 * A fully-costed evaluation of buying on one venue and selling on another.
 */
export type ArbEvaluation = {
  symbol: string;
  buyVenue: string;
  sellVenue: string;
  /** Quantity the evaluation was priced at. */
  qty: number;

  /** VWAP paid on the buy side, walking the asks. */
  buyAvgPrice: number;
  /** VWAP received on the sell side, walking the bids. */
  sellAvgPrice: number;

  /**
   * The naive spread between best ask and best bid. This is the number most
   * arbitrage dashboards display, and it is almost always an illusion.
   */
  topOfBookSpreadBps: number;
  /** Spread on executable VWAPs, before fees. */
  grossSpreadBps: number;
  /** Spread after taker fees on both legs and transfer cost. This is the real one. */
  netSpreadBps: number;
  /** Absolute profit in quote currency after all costs. */
  netProfitQuote: number;

  buySlippageBps: number;
  sellSlippageBps: number;

  /** True only when every validation passed and net spread clears the minimum. */
  executable: boolean;
  rejections: RejectReason[];
  /** Age of the older of the two books, in ms. */
  bookAgeMs: number;
};
