import { describe, expect, it } from "vitest";
import { fetchSentiment } from "./sentiment.js";
import { fetchTechnicalRatings } from "./tradingview.js";

/**
 * Live verification against the real endpoints.
 *
 * Skipped unless `INTEL_LIVE=1`, exactly like the arbitrage engine's live lane:
 * these are public, unauthenticated services that change without notice, and a
 * CI run should not fail because someone else's rate limiter had an opinion.
 *
 * Run it when the parser changes, or when the desk reports a source as quiet:
 *
 *   INTEL_LIVE=1 npx vitest run --root packages/market-intel src/live.test.ts
 */

const live = process.env.INTEL_LIVE === "1";

describe.skipIf(!live)("live market intelligence", () => {
  it("reads real TradingView ratings across timeframes", async () => {
    const ratings = await fetchTechnicalRatings(["BTC/USDT", "ETH/USDT"]);

    expect(ratings.size).toBeGreaterThan(0);

    for (const [symbol, rating] of ratings) {
      console.log(
        `${symbol}: ${rating.rating.toFixed(3)} (${rating.label}), ` +
          `${rating.timeframes} timeframes, ${Math.round(rating.alignment * 100)}% aligned, ` +
          `RSI ${rating.rsi?.toFixed(1) ?? "n/a"}, ADX ${rating.adx?.toFixed(1) ?? "n/a"}, ` +
          `close ${rating.close ?? "n/a"}`,
      );

      // The scale is fixed by the vendor; a reading outside it means the column
      // moved and the parser is reading the wrong number.
      expect(rating.rating).toBeGreaterThanOrEqual(-1);
      expect(rating.rating).toBeLessThanOrEqual(1);
      expect(rating.timeframes).toBeGreaterThan(0);
      expect(rating.alignment).toBeGreaterThanOrEqual(0);
      expect(rating.alignment).toBeLessThanOrEqual(1);
      // A crypto major always has a price; a null here means the row shifted.
      expect(rating.close).toBeGreaterThan(0);
    }
  }, 30_000);

  it("reads the real fear and greed index", async () => {
    const sentiment = await fetchSentiment();

    expect(sentiment).not.toBeNull();
    console.log(`sentiment: ${sentiment!.value}/100 — ${sentiment!.label}`);

    expect(sentiment!.value).toBeGreaterThanOrEqual(0);
    expect(sentiment!.value).toBeLessThanOrEqual(100);
  }, 30_000);
});
