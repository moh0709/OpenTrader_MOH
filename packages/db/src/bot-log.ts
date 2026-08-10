/**
 * What a bot log entry stores, and how long it is kept.
 *
 * A log entry used to persist the whole `MarketData` context, and `MarketData`
 * carries the entire candle history the strategy was warmed with. On a one
 * minute DCA bot that meant serialising ~5,000 candles - over 200 KB - every
 * single minute. One bot produced 729 MB, which was 99.9% of the database, and
 * made every query touching the table read hundreds of megabytes.
 *
 * The history is not what a log entry is for. To understand a run you need to
 * know which candle triggered it and what the market looked like at that moment,
 * not to replay the warm-up window. So the context is summarised: the triggering
 * candle, the ticker and the trade are kept in full, and the history is reduced
 * to a count and its time span. That is roughly 1000x smaller and strictly more
 * readable.
 */
import type { MarketData } from "@opentrader/types";

/** The stored shape of a log context. */
export type BotLogContext = {
  candle?: MarketData["candle"];
  ticker?: MarketData["ticker"];
  trade?: MarketData["trade"];
  /**
   * The candle history is summarised rather than stored. `count` is how many
   * candles the strategy had available; `from`/`to` are their epoch ms bounds.
   */
  candles?: { count: number; from: number | null; to: number | null };
  /** Best bid and ask only; a full order book is unbounded and never read back. */
  orderbook?: { bids: number; asks: number; bestBid: number | null; bestAsk: number | null };
};

/**
 * Reduce market data to what a log entry actually needs.
 *
 * Returns undefined for undefined input, so `JSON.stringify` keeps producing
 * the same value it did before for entries logged without a context.
 */
export function summarizeMarketData(market: MarketData | undefined): BotLogContext | undefined {
  if (!market) return undefined;

  const summary: BotLogContext = {};

  if (market.candle) summary.candle = market.candle;
  if (market.ticker) summary.ticker = market.ticker;
  if (market.trade) summary.trade = market.trade;

  if (Array.isArray(market.candles) && market.candles.length > 0) {
    const candles = market.candles;
    summary.candles = {
      count: candles.length,
      from: candles[0]?.timestamp ?? null,
      to: candles[candles.length - 1]?.timestamp ?? null,
    };
  }

  if (market.orderbook) {
    const { bids, asks } = market.orderbook;
    summary.orderbook = {
      bids: bids?.length ?? 0,
      asks: asks?.length ?? 0,
      bestBid: bids?.[0]?.[0] ?? null,
      bestAsk: asks?.[0]?.[0] ?? null,
    };
  }

  return summary;
}

/**
 * How long bot logs are kept, in days.
 *
 * Configurable so an install that wants a longer audit trail can have one, and
 * so it can be switched off entirely. Zero or negative disables pruning.
 */
export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BOT_LOG_RETENTION_DAYS);

  return Number.isFinite(raw) ? raw : 30;
}

/** The cutoff timestamp for a retention window, or null when pruning is off. */
export function retentionCutoff(days: number, now: number): Date | null {
  if (days <= 0) return null;

  return new Date(now - days * 86_400_000);
}
