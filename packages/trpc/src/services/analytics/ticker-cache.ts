/**
 * Shared, throttled ticker cache.
 *
 * The dashboard refreshes every few seconds and marks every open position to
 * market, but the exchange must not be hit once per position, per client, per
 * tick. This fetches each symbol at most once per TTL and hands the same reading
 * to everyone, so the exchange load stays flat no matter how many browser tabs
 * or agents are watching.
 *
 * Prices are never allowed to fail loudly: a symbol that cannot be priced is
 * reported with an error and a null price, and the widgets degrade to showing
 * realised figures only.
 */
import type { AnalyticsTicker } from "./types.js";

export type TickerFetcher = (
  exchangeCode: string,
  symbol: string,
) => Promise<{ last: number | null; bid: number | null; ask: number | null; timestamp: number | null }>;

export type TickerRequest = {
  exchangeCode: string;
  symbol: string;
};

type CacheEntry = {
  exchangeCode: string;
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  timestamp: number;
  fetchedAt: number;
  error: string | null;
  consecutiveFailures: number;
};

export const DEFAULT_TICKER_TTL_MS = 10_000;
/** How long a reading may be served past its TTL when a refresh is failing. */
export const DEFAULT_TICKER_MAX_AGE_MS = 120_000;

export class TickerCache {
  private entries = new Map<string, CacheEntry>();
  /** In-flight fetches, so concurrent requests share one exchange call. */
  private inflight = new Map<string, Promise<void>>();

  constructor(
    private fetcher: TickerFetcher,
    private ttlMs: number = DEFAULT_TICKER_TTL_MS,
    private maxAgeMs: number = DEFAULT_TICKER_MAX_AGE_MS,
    private now: () => number = Date.now,
  ) {}

  private key(exchangeCode: string, symbol: string) {
    return `${exchangeCode}:${symbol}`;
  }

  /**
   * Refresh any requested symbol whose reading has aged past the TTL.
   * Resolves once every needed fetch has settled; failures are recorded, not thrown.
   */
  async refresh(requests: TickerRequest[]): Promise<void> {
    const now = this.now();
    const pending: Array<Promise<void>> = [];
    const seen = new Set<string>();

    for (const request of requests) {
      const key = this.key(request.exchangeCode, request.symbol);
      if (seen.has(key)) continue;
      seen.add(key);

      const entry = this.entries.get(key);
      if (entry && now - entry.fetchedAt < this.ttlMs) continue;

      const existing = this.inflight.get(key);
      if (existing) {
        pending.push(existing);
        continue;
      }

      const task = this.fetchOne(request, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, task);
      pending.push(task);
    }

    await Promise.all(pending);
  }

  private async fetchOne(request: TickerRequest, key: string): Promise<void> {
    const previous = this.entries.get(key);

    try {
      const ticker = await this.fetcher(request.exchangeCode, request.symbol);
      const now = this.now();

      this.entries.set(key, {
        exchangeCode: request.exchangeCode,
        symbol: request.symbol,
        last: ticker.last,
        bid: ticker.bid,
        ask: ticker.ask,
        timestamp: ticker.timestamp ?? now,
        fetchedAt: now,
        error: null,
        consecutiveFailures: 0,
      });
    } catch (error) {
      const now = this.now();
      const message = error instanceof Error ? error.message : String(error);

      // Keep the last good price so the UI can show it as stale rather than blank,
      // but only until it is too old to be meaningful.
      const keepPrevious = previous && now - previous.timestamp < this.maxAgeMs;

      this.entries.set(key, {
        exchangeCode: request.exchangeCode,
        symbol: request.symbol,
        last: keepPrevious ? previous!.last : null,
        bid: keepPrevious ? previous!.bid : null,
        ask: keepPrevious ? previous!.ask : null,
        timestamp: keepPrevious ? previous!.timestamp : now,
        fetchedAt: now,
        error: message,
        consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      });
    }
  }

  /** Snapshot of every cached symbol, with ages computed at call time. */
  list(): AnalyticsTicker[] {
    const now = this.now();

    return [...this.entries.values()].map((entry) => {
      const ageMs = Math.max(0, now - entry.timestamp);

      return {
        symbol: entry.symbol,
        last: entry.last,
        bid: entry.bid,
        ask: entry.ask,
        timestamp: entry.timestamp,
        fetchedAt: entry.fetchedAt,
        ageMs,
        stale: entry.error !== null || ageMs > this.maxAgeMs,
        error: entry.error,
      } satisfies AnalyticsTicker;
    });
  }

  /**
   * Readings keyed by symbol alone.
   *
   * Positions are matched to prices by symbol, because a SmartTrade records the
   * pair but not the venue. On an install trading the same pair on two exchanges
   * the first reading wins; the prices would differ only marginally, and this is
   * used for marking to market rather than for execution.
   */
  bySymbol(): Map<string, AnalyticsTicker> {
    const map = new Map<string, AnalyticsTicker>();

    for (const ticker of this.list()) {
      if (!map.has(ticker.symbol)) map.set(ticker.symbol, ticker);
    }

    return map;
  }

  clear() {
    this.entries.clear();
    this.inflight.clear();
  }
}
