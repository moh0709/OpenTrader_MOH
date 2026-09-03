/**
 * What the desk can learn about a market from outside its own candles.
 *
 * Two sources today — TradingView's technical ratings and the crypto fear and
 * greed index — behind one shape, because the trading head reasons about
 * "evidence with an age and a confidence", not about which website it came from.
 *
 * Everything here is optional information. A source that is unreachable, rate
 * limited, or has started returning nonsense resolves to `null`, and the head
 * decides with what it has. Nothing in this package may ever throw into a
 * trading loop.
 */

/** Where a reading came from, kept so a degraded run is visible in the audit log. */
export type IntelSource = "tradingview" | "alternative.me";

export type RatingLabel = "strong_sell" | "sell" | "neutral" | "buy" | "strong_buy";

/**
 * TradingView's timeframes, in the codes its scanner uses.
 *
 * Minutes as bare numbers, days and weeks with a letter. The base column with
 * no suffix is the daily one, which is why "1D" is not requested separately.
 */
export type Timeframe = "5" | "15" | "60" | "240" | "1D" | "1W";

export const TIMEFRAMES: readonly Timeframe[] = ["5", "15", "60", "240", "1D", "1W"];

/**
 * How TradingView buckets its aggregate recommendation, which runs -1..1.
 *
 * These are the thresholds the site itself paints, so a reading described as
 * "strong buy" here is the same one a human would see on the chart.
 */
export function ratingLabel(rating: number): RatingLabel {
  if (rating <= -0.5) return "strong_sell";
  if (rating <= -0.1) return "sell";
  if (rating < 0.1) return "neutral";
  if (rating < 0.5) return "buy";
  return "strong_buy";
}

/** A multi-timeframe technical read of one market. */
export type TechnicalRating = {
  source: IntelSource;
  /** The symbol as the bots know it, e.g. "BTC/USDT". */
  symbol: string;
  /** The vendor's own identifier, e.g. "BINANCE:BTCUSDT". */
  ticker: string;
  /** Aggregate recommendation on the primary timeframe, -1..1. */
  rating: number;
  label: RatingLabel;
  /** Aggregate recommendation per timeframe. Absent where the vendor had none. */
  byTimeframe: Partial<Record<Timeframe, number>>;
  /**
   * Share of reporting timeframes that lean the same way as `rating`, 0..1.
   *
   * This is the number worth acting on. A market that is a buy on the 5-minute
   * and a sell on the day is not a weak buy — it is a disagreement, and sizing
   * into it is how a desk gets chopped up. One timeframe reporting scores 1 by
   * arithmetic, so callers weigh `timeframes` alongside it.
   */
  alignment: number;
  /** How many timeframes actually reported. */
  timeframes: number;
  rsi: number | null;
  adx: number | null;
  close: number | null;
  /** Session change, in percent. */
  changePercent: number | null;
  /** Epoch ms this reading was taken. */
  asOf: number;
};

/** A market-wide sentiment reading. Not per symbol — the whole asset class. */
export type SentimentReading = {
  source: IntelSource;
  /** 0 (extreme fear) .. 100 (extreme greed). */
  value: number;
  /** The vendor's own words, e.g. "Extreme Fear". */
  label: string;
  asOf: number;
};

/** Everything gathered for one symbol on one pass. Fields are independently optional. */
export type MarketIntel = {
  symbol: string;
  technical: TechnicalRating | null;
  sentiment: SentimentReading | null;
};
