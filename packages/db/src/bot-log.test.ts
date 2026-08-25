import { describe, expect, it } from "vitest";
import { retentionCutoff, retentionDays, summarizeMarketData } from "./bot-log.js";

const candle = (timestamp: number) => ({ open: 74.22, high: 74.3, low: 74.15, close: 74.2, timestamp, volume: 231.8 });

/** The shape that produced 729 MB: a full warm-up window on every entry. */
const bigMarket = {
  candle: candle(1_785_963_900_000),
  candles: Array.from({ length: 5022 }, (_, i) => candle(1_785_663_900_000 + i * 60_000)),
};

describe("summarizeMarketData", () => {
  it("collapses the candle history to a count and a span", () => {
    const summary = summarizeMarketData(bigMarket as never)!;

    expect(summary.candles).toEqual({
      count: 5022,
      from: 1_785_663_900_000,
      to: 1_785_663_900_000 + 5021 * 60_000,
    });
    expect(Array.isArray(summary.candles)).toBe(false);
  });

  it("shrinks the payload by about three orders of magnitude", () => {
    const before = JSON.stringify(bigMarket).length;
    const after = JSON.stringify(summarizeMarketData(bigMarket as never)).length;

    expect(before).toBeGreaterThan(400_000);
    expect(after).toBeLessThan(500);
    expect(before / after).toBeGreaterThan(500);
  });

  it("keeps the triggering candle in full, since that is what a log is for", () => {
    expect(summarizeMarketData(bigMarket as never)!.candle).toEqual(bigMarket.candle);
  });

  it("keeps ticker and trade untouched", () => {
    const market = { candles: [], ticker: { symbol: "BTC/USD", last: 65_000 }, trade: { id: "1", price: 65_000 } };
    const summary = summarizeMarketData(market as never)!;

    expect(summary.ticker).toEqual(market.ticker);
    expect(summary.trade).toEqual(market.trade);
  });

  it("reduces an order book to its best levels", () => {
    /*
     * Levels are `{ price, quantity }`, not `[price, quantity]`.
     *
     * This fixture used ccxt's raw tuple shape, which never reaches here —
     * `normalizeOrderbook` converts it to objects at the exchange boundary. The
     * `as never` cast let the wrong shape through, and the assertion then locked
     * in the behaviour of production code that read `bids[0][0]` and so logged a
     * null best bid and ask on every real order book it ever saw.
     */
    const market = {
      candles: [],
      orderbook: {
        bids: [
          { price: 64_999, quantity: 1.2 },
          { price: 64_998, quantity: 3 },
        ],
        asks: [
          { price: 65_001, quantity: 0.5 },
          { price: 65_002, quantity: 2 },
        ],
      },
    };

    expect(summarizeMarketData(market as never)!.orderbook).toEqual({
      bids: 2,
      asks: 2,
      bestBid: 64_999,
      bestAsk: 65_001,
    });
  });

  it("omits absent fields rather than writing nulls", () => {
    expect(summarizeMarketData({ candles: [] } as never)).toEqual({});
  });

  it("passes undefined through, so entries logged without context are unchanged", () => {
    expect(summarizeMarketData(undefined)).toBeUndefined();
    expect(JSON.stringify(summarizeMarketData(undefined))).toBe(undefined);
  });
});

describe("retentionDays", () => {
  it("defaults to 30 days", () => {
    expect(retentionDays({} as NodeJS.ProcessEnv)).toBe(30);
  });

  it("reads the environment override", () => {
    expect(retentionDays({ BOT_LOG_RETENTION_DAYS: "7" } as NodeJS.ProcessEnv)).toBe(7);
  });

  it("falls back to the default when the value is not a number", () => {
    expect(retentionDays({ BOT_LOG_RETENTION_DAYS: "forever" } as NodeJS.ProcessEnv)).toBe(30);
  });

  it("allows disabling with zero", () => {
    expect(retentionDays({ BOT_LOG_RETENTION_DAYS: "0" } as NodeJS.ProcessEnv)).toBe(0);
  });
});

describe("retentionCutoff", () => {
  it("returns the start of the window", () => {
    const now = 1_786_000_000_000;

    expect(retentionCutoff(30, now)!.getTime()).toBe(now - 30 * 86_400_000);
  });

  it("returns null when pruning is disabled, so nothing is ever deleted", () => {
    expect(retentionCutoff(0, Date.now())).toBeNull();
    expect(retentionCutoff(-1, Date.now())).toBeNull();
  });
});
