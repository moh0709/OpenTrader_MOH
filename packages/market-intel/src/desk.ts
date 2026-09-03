import { logger } from "@opentrader/logger";
import { fetchSentiment, sentimentOptionsFromEnv, type SentimentOptions } from "./sentiment.js";
import { fetchTechnicalRatings, tradingViewOptionsFromEnv, type TradingViewOptions } from "./tradingview.js";
import type { MarketIntel, SentimentReading, TechnicalRating } from "./types.js";

/**
 * The intelligence desk: one place that knows how often each source is worth
 * asking, and what to serve while an answer is in flight.
 *
 * The trading head ticks once a minute. The sources it reads do not change that
 * fast — TradingView recomputes its aggregate on the bar, and the fear and
 * greed index publishes once a day — so polling them at loop speed would be
 * rude to a free service and would buy nothing. Each reading is therefore held
 * for its own lifetime and re-fetched only when it goes stale.
 *
 * A stale reading is still served while the refresh is failing. That is the
 * point of holding it: a vendor having a bad five minutes should not blank the
 * desk's view of the market. The age travels with the reading, and the head
 * decides what is too old to act on.
 */

/** TradingView recomputes on the bar; a minute of staleness costs nothing. */
export const TECHNICAL_TTL_MS = 5 * 60 * 1000;

/** The index publishes daily. Half an hour is already far more often than it changes. */
export const SENTIMENT_TTL_MS = 30 * 60 * 1000;

/**
 * Past this, a reading is not served at all.
 *
 * Distinct from the TTL, which only decides when to refresh. This is the point
 * at which a source has been down long enough that its last answer is no longer
 * evidence about the present.
 */
export const TECHNICAL_MAX_AGE_MS = 60 * 60 * 1000;
export const SENTIMENT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export type DeskOptions = {
  tradingView?: TradingViewOptions | null;
  sentiment?: SentimentOptions | null;
  technicalTtlMs?: number;
  sentimentTtlMs?: number;
  now?: () => number;
};

/**
 * Build desk options from the environment.
 *
 * Either source can be switched off with `TRADINGVIEW=0` / `SENTIMENT=0`. An
 * operator who does not want the daemon reaching public endpoints at all gets
 * that with two variables rather than by editing code.
 */
export function deskOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): DeskOptions {
  return {
    tradingView: env.TRADINGVIEW === "0" ? null : tradingViewOptionsFromEnv(env),
    sentiment: env.SENTIMENT === "0" ? null : sentimentOptionsFromEnv(env),
  };
}

type Cached<T> = { value: T; fetchedAt: number };

export class IntelDesk {
  private technical = new Map<string, Cached<TechnicalRating>>();
  private sentiment: Cached<SentimentReading> | null = null;
  /** In-flight refreshes, so a slow vendor cannot stack up duplicate calls. */
  private technicalInFlight: Promise<void> | null = null;
  private sentimentInFlight: Promise<void> | null = null;

  constructor(private options: DeskOptions = deskOptionsFromEnv()) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /**
   * Refresh whatever has gone stale, then answer for every symbol asked about.
   *
   * Both sources are refreshed concurrently — they are unrelated services and
   * one being slow should not delay the other.
   */
  async gather(symbols: string[]): Promise<Map<string, MarketIntel>> {
    await Promise.all([this.refreshTechnical(symbols), this.refreshSentiment()]);

    const now = this.now();
    const sentiment =
      this.sentiment && now - this.sentiment.fetchedAt <= SENTIMENT_MAX_AGE_MS ? this.sentiment.value : null;

    const out = new Map<string, MarketIntel>();

    for (const symbol of symbols) {
      const cached = this.technical.get(symbol);
      const technical = cached && now - cached.fetchedAt <= TECHNICAL_MAX_AGE_MS ? cached.value : null;

      out.set(symbol, { symbol, technical, sentiment });
    }

    return out;
  }

  private async refreshTechnical(symbols: string[]): Promise<void> {
    const options = this.options.tradingView;
    if (!options) return;

    const ttl = this.options.technicalTtlMs ?? TECHNICAL_TTL_MS;
    const now = this.now();
    const stale = symbols.filter((symbol) => {
      const cached = this.technical.get(symbol);
      return !cached || now - cached.fetchedAt > ttl;
    });

    if (stale.length === 0) return;
    if (this.technicalInFlight) return this.technicalInFlight;

    this.technicalInFlight = (async () => {
      try {
        const ratings = await fetchTechnicalRatings(stale, options);
        const fetchedAt = this.now();

        for (const [symbol, value] of ratings) {
          this.technical.set(symbol, { value, fetchedAt });
        }

        // A symbol asked about but not answered keeps its previous reading and
        // ages out naturally. Deleting it here would drop a good reading
        // because of one bad request.
        const missing = stale.filter((symbol) => !ratings.has(symbol));
        if (missing.length > 0) {
          logger.debug(`[Intel] TradingView had nothing for ${missing.join(", ")}`);
        }
      } finally {
        this.technicalInFlight = null;
      }
    })();

    return this.technicalInFlight;
  }

  private async refreshSentiment(): Promise<void> {
    const options = this.options.sentiment;
    if (!options) return;

    const ttl = this.options.sentimentTtlMs ?? SENTIMENT_TTL_MS;
    if (this.sentiment && this.now() - this.sentiment.fetchedAt <= ttl) return;
    if (this.sentimentInFlight) return this.sentimentInFlight;

    this.sentimentInFlight = (async () => {
      try {
        const reading = await fetchSentiment(options);
        if (reading) this.sentiment = { value: reading, fetchedAt: this.now() };
      } finally {
        this.sentimentInFlight = null;
      }
    })();

    return this.sentimentInFlight;
  }

  /** What the desk currently holds, for the health view. */
  status(): { technical: number; sentiment: SentimentReading | null; sources: string[] } {
    const sources: string[] = [];
    if (this.options.tradingView) sources.push("tradingview");
    if (this.options.sentiment) sources.push("alternative.me");

    return { technical: this.technical.size, sentiment: this.sentiment?.value ?? null, sources };
  }
}
