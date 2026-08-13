import { describe, expect, it } from "vitest";
import { evaluateDirection } from "./spread.js";
import { DEFAULT_ARBITRAGE_CONFIG, type ArbitrageConfig, type BookLevel, type VenueQuote } from "./types.js";

const NOW = 1_700_000_000_000;

function quote(venue: string, asks: BookLevel[], bids: BookLevel[], overrides: Partial<VenueQuote> = {}): VenueQuote {
  return {
    venue,
    symbol: "BTC/USDT",
    takerFeeBps: 10,
    book: { asks, bids, timestamp: NOW, symbol: "BTC/USDT" },
    ...overrides,
  };
}

const config: ArbitrageConfig = { ...DEFAULT_ARBITRAGE_CONFIG, tradeQty: 1, transferCostBps: 0 };

describe("evaluateDirection", () => {
  it("accepts a genuinely profitable spread", () => {
    const buy = quote("A", [{ price: 100, quantity: 10 }], [{ price: 99.9, quantity: 10 }]);
    const sell = quote("B", [{ price: 100.7, quantity: 10 }], [{ price: 100.6, quantity: 10 }]);

    const result = evaluateDirection(buy, sell, config, NOW);

    expect(result.grossSpreadBps).toBeCloseTo(60, 6);
    // 60 bps gross, 20 bps of taker fees across both legs
    expect(result.netSpreadBps).toBeCloseTo(39.94, 1);
    expect(result.netProfitQuote).toBeCloseTo(0.3994, 3);
    expect(result.executable).toBe(true);
    expect(result.rejections).toEqual([]);
  });

  it("rejects a spread that fees turn negative", () => {
    // 10 bps gross cannot survive 10 bps of taker fee on each leg.
    const buy = quote("A", [{ price: 100, quantity: 10 }], [{ price: 99.9, quantity: 10 }]);
    const sell = quote("B", [{ price: 100.2, quantity: 10 }], [{ price: 100.1, quantity: 10 }]);

    const result = evaluateDirection(buy, sell, config, NOW);

    expect(result.grossSpreadBps).toBeCloseTo(10, 6);
    expect(result.netSpreadBps).toBeLessThan(0);
    expect(result.executable).toBe(false);
    expect(result.rejections).toContain("NEGATIVE_AFTER_COSTS");
  });

  it("exposes a phantom spread that only exists at the top of the book", () => {
    // Top of book shows +50 bps, but there is only 0.1 of size there.
    // Filling 1 unit walks deep into the book and the trade is a big loser.
    const buy = quote(
      "A",
      [
        { price: 100, quantity: 0.1 },
        { price: 101, quantity: 100 },
      ],
      [{ price: 99.9, quantity: 10 }],
    );
    const sell = quote(
      "B",
      [{ price: 100.6, quantity: 10 }],
      [
        { price: 100.5, quantity: 0.1 },
        { price: 99.5, quantity: 100 },
      ],
    );

    const result = evaluateDirection(buy, sell, config, NOW);

    // The naive number every basic scanner would report.
    expect(result.topOfBookSpreadBps).toBeCloseTo(50, 6);
    // What actually happens once you pay for real size.
    expect(result.buyAvgPrice).toBeCloseTo(100.9, 6);
    expect(result.sellAvgPrice).toBeCloseTo(99.6, 6);
    expect(result.grossSpreadBps).toBeLessThan(-100);
    expect(result.executable).toBe(false);
    expect(result.rejections).toContain("NEGATIVE_AFTER_COSTS");
  });

  it("flags books that are too thin to fill the requested size", () => {
    const buy = quote("A", [{ price: 100, quantity: 0.2 }], [{ price: 99.9, quantity: 10 }]);
    const sell = quote("B", [{ price: 100.7, quantity: 10 }], [{ price: 100.6, quantity: 0.2 }]);

    const result = evaluateDirection(buy, sell, config, NOW);

    expect(result.rejections).toContain("INSUFFICIENT_DEPTH");
    expect(result.executable).toBe(false);
  });

  it("rejects stale books", () => {
    const buy = quote("A", [{ price: 100, quantity: 10 }], [{ price: 99.9, quantity: 10 }], {
      book: { asks: [{ price: 100, quantity: 10 }], bids: [{ price: 99.9, quantity: 10 }], timestamp: NOW - 60_000, symbol: "BTC/USDT" },
    });
    const sell = quote("B", [{ price: 100.7, quantity: 10 }], [{ price: 100.6, quantity: 10 }]);

    const result = evaluateDirection(buy, sell, config, NOW);

    expect(result.rejections).toContain("STALE_BOOK");
    expect(result.executable).toBe(false);
    expect(result.bookAgeMs).toBe(60_000);
  });

  it("skips the staleness check when the venue supplies no timestamp", () => {
    const buy = quote("A", [], [], {
      book: { asks: [{ price: 100, quantity: 10 }], bids: [{ price: 99.9, quantity: 10 }], timestamp: 0, symbol: "BTC/USDT" },
    });
    const sell = quote("B", [{ price: 100.7, quantity: 10 }], [{ price: 100.6, quantity: 10 }]);

    const result = evaluateDirection(buy, sell, config, NOW);

    expect(result.rejections).not.toContain("STALE_BOOK");
    expect(result.executable).toBe(true);
  });

  it("rejects a crossed book as broken data", () => {
    // bid >= ask on the same venue is impossible in a real book
    const buy = quote("A", [{ price: 100, quantity: 10 }], [{ price: 100.5, quantity: 10 }]);
    const sell = quote("B", [{ price: 100.7, quantity: 10 }], [{ price: 100.6, quantity: 10 }]);

    const result = evaluateDirection(buy, sell, config, NOW);

    expect(result.rejections).toContain("CROSSED_BOOK");
    expect(result.executable).toBe(false);
  });

  it("treats an implausibly wide spread as bad data rather than free money", () => {
    const buy = quote("A", [{ price: 100, quantity: 10 }], [{ price: 99.9, quantity: 10 }]);
    const sell = quote("B", [{ price: 200.1, quantity: 10 }], [{ price: 200, quantity: 10 }]);

    const result = evaluateDirection(buy, sell, config, NOW);

    expect(result.topOfBookSpreadBps).toBeGreaterThan(config.maxPlausibleSpreadBps);
    expect(result.rejections).toContain("IMPLAUSIBLE_SPREAD");
    expect(result.executable).toBe(false);
  });

  it("refuses to arbitrage a venue against itself", () => {
    const a = quote("A", [{ price: 100, quantity: 10 }], [{ price: 99.9, quantity: 10 }]);

    const result = evaluateDirection(a, a, config, NOW);

    expect(result.rejections).toEqual(["SAME_VENUE"]);
  });

  it("rejects a positive-but-too-small edge", () => {
    const buy = quote("A", [{ price: 100, quantity: 10 }], [{ price: 99.9, quantity: 10 }]);
    const sell = quote("B", [{ price: 100.32, quantity: 10 }], [{ price: 100.25, quantity: 10 }]);

    const result = evaluateDirection(buy, sell, { ...config, minNetSpreadBps: 20 }, NOW);

    expect(result.netSpreadBps).toBeGreaterThan(0);
    expect(result.netSpreadBps).toBeLessThan(20);
    expect(result.rejections).toContain("BELOW_MIN_PROFIT");
    expect(result.executable).toBe(false);
  });

  it("charges transfer cost against the edge", () => {
    const buy = quote("A", [{ price: 100, quantity: 10 }], [{ price: 99.9, quantity: 10 }]);
    const sell = quote("B", [{ price: 100.7, quantity: 10 }], [{ price: 100.6, quantity: 10 }]);

    const free = evaluateDirection(buy, sell, config, NOW);
    const costly = evaluateDirection(buy, sell, { ...config, transferCostBps: 30 }, NOW);

    expect(free.netSpreadBps - costly.netSpreadBps).toBeCloseTo(30, 6);
    expect(costly.executable).toBe(true);
    expect(costly.netSpreadBps).toBeCloseTo(9.94, 1);
  });
});
