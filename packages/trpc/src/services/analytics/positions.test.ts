import { beforeEach, describe, expect, it } from "vitest";
import { summarizePositions, toOpenPositions, toPendingEntries } from "./positions.js";
import { tickerLookup } from "./bot-stats.js";
import type { AnalyticsTicker } from "./types.js";
import { makeClosedTrade, makeOpenTrade, makePendingTrade, resetFixtureIds } from "./test-fixtures.js";

beforeEach(resetFixtureIds);

const NOW = 1_786_362_000_000;

function ticker(symbol: string, last: number | null, overrides: Partial<AnalyticsTicker> = {}): AnalyticsTicker {
  return {
    symbol,
    last,
    bid: last,
    ask: last,
    timestamp: NOW,
    fetchedAt: NOW,
    ageMs: 0,
    stale: false,
    error: null,
    ...overrides,
  };
}

const at = (tickers: AnalyticsTicker[]) => tickerLookup(tickers);

describe("toOpenPositions", () => {
  it("marks an open position to the live price", () => {
    const positions = toOpenPositions(
      [makeOpenTrade({ entryPrice: 65_000, targetPrice: 65_020, quantity: 0.01 })],
      at([ticker("BTC/USD", 65_010)]),
      NOW,
    );

    expect(positions).toHaveLength(1);
    expect(positions[0]!.costBasis).toBeCloseTo(650, 10);
    expect(positions[0]!.floatingPnl).toBeCloseTo(0.1, 10);
    expect(positions[0]!.underwater).toBe(false);
    expect(positions[0]!.exitState).toBe("live");
  });

  it("shows red when the price is below the entry", () => {
    const positions = toOpenPositions(
      [makeOpenTrade({ entryPrice: 65_000, targetPrice: 65_020, quantity: 0.01 })],
      at([ticker("BTC/USD", 64_900)]),
      NOW,
    );

    expect(positions[0]!.floatingPnl).toBeCloseTo(-1, 10);
    expect(positions[0]!.floatingPnlPercent).toBeCloseTo(-0.1538, 3);
    expect(positions[0]!.underwater).toBe(true);
  });

  it("treats a cancelled exit as abandoned, not live", () => {
    // This is what a bot restart does to resting take profits: the position is
    // still held but nothing will sell it.
    const positions = toOpenPositions(
      [makeOpenTrade({ entryPrice: 65_000, targetPrice: 65_020, exitStatus: "Canceled" })],
      at([ticker("BTC/USD", 65_010)]),
      NOW,
    );

    expect(positions[0]!.exitState).toBe("abandoned");
    expect(positions[0]!.exitStatus).toBe("Canceled");
  });

  it("treats a revoked exit as abandoned", () => {
    const positions = toOpenPositions(
      [makeOpenTrade({ entryPrice: 65_000, targetPrice: 65_020, exitStatus: "Revoked" })],
      at([ticker("BTC/USD", 65_010)]),
      NOW,
    );

    expect(positions[0]!.exitState).toBe("abandoned");
  });

  it("reports the profit an abandoned exit would have earned", () => {
    const positions = toOpenPositions(
      [makeOpenTrade({ entryPrice: 65_000, targetPrice: 65_020, quantity: 0.01, exitStatus: "Canceled" })],
      at([ticker("BTC/USD", 65_010)]),
      NOW,
    );

    expect(positions[0]!.potentialPnl).toBeCloseTo(0.2, 10);
  });

  it("excludes trades that already closed", () => {
    expect(
      toOpenPositions([makeClosedTrade({ entryPrice: 65_000, exitPrice: 65_020 })], at([ticker("BTC/USD", 65_010)]), NOW),
    ).toHaveLength(0);
  });

  it("excludes entries that never filled", () => {
    expect(toOpenPositions([makePendingTrade({ price: 64_800 })], at([ticker("BTC/USD", 65_010)]), NOW)).toHaveLength(0);
  });

  it("degrades to a null mark when the symbol cannot be priced", () => {
    const positions = toOpenPositions([makeOpenTrade({ entryPrice: 65_000, targetPrice: 65_020 })], at([]), NOW);

    expect(positions[0]!.markPrice).toBeNull();
    expect(positions[0]!.floatingPnl).toBeNull();
    expect(positions[0]!.underwater).toBe(false);
    expect(positions[0]!.costBasis).toBeGreaterThan(0); // realised facts still available
  });

  it("computes how far the price must move to reach the target", () => {
    const positions = toOpenPositions(
      [makeOpenTrade({ entryPrice: 100, targetPrice: 110 })],
      at([ticker("BTC/USD", 100)]),
      NOW,
    );

    expect(positions[0]!.distanceToTargetPercent).toBeCloseTo(10, 10);
  });
});

describe("toPendingEntries", () => {
  it("lists resting buy orders with the distance to their fill price", () => {
    const pending = toPendingEntries([makePendingTrade({ price: 64_000 })], at([ticker("BTC/USD", 65_000)]), NOW);

    expect(pending).toHaveLength(1);
    expect(pending[0]!.price).toBe(64_000);
    expect(pending[0]!.distanceToFillPercent).toBeCloseTo(-1.538, 3);
  });

  it("ignores trades whose entry already filled", () => {
    expect(toPendingEntries([makeOpenTrade({ entryPrice: 100, targetPrice: 110 })], at([]), NOW)).toHaveLength(0);
  });
});

describe("summarizePositions", () => {
  it("separates capital that is working from capital that is stranded", () => {
    // The shape of the live install: a few positions still working, many more
    // left without an exit after bot restarts.
    const positions = toOpenPositions(
      [
        makeOpenTrade({ entryPrice: 100, targetPrice: 110, quantity: 1 }),
        makeOpenTrade({ entryPrice: 100, targetPrice: 110, quantity: 1, exitStatus: "Canceled" }),
        makeOpenTrade({ entryPrice: 100, targetPrice: 110, quantity: 1, exitStatus: "Revoked" }),
      ],
      at([ticker("BTC/USD", 105)]),
      NOW,
    );

    const stats = summarizePositions(positions);

    expect(stats.open).toBe(3);
    expect(stats.live).toBe(1);
    expect(stats.abandoned).toBe(2);
    expect(stats.costBasis).toBeCloseTo(300, 10);
    expect(stats.liveCostBasis).toBeCloseTo(100, 10);
    expect(stats.abandonedCostBasis).toBeCloseTo(200, 10);
    expect(stats.pendingProfit).toBeCloseTo(10, 10);
    expect(stats.abandonedProfit).toBeCloseTo(20, 10);
    expect(stats.floatingPnl).toBeCloseTo(15, 10);
  });

  it("sums only the losing positions into drawdown", () => {
    const positions = toOpenPositions(
      [
        makeOpenTrade({ entryPrice: 100, targetPrice: 110, quantity: 1 }),
        makeOpenTrade({ entryPrice: 120, targetPrice: 130, quantity: 1 }),
      ],
      at([ticker("BTC/USD", 110)]),
      NOW,
    );

    const stats = summarizePositions(positions);

    expect(stats.floatingPnl).toBeCloseTo(0, 10); // +10 and -10 cancel out
    expect(stats.floatingDrawdown).toBeCloseTo(-10, 10); // the loss is still visible
    expect(stats.underwater).toBe(1);
  });

  it("refuses to report a total when any position is unpriced", () => {
    const positions = toOpenPositions(
      [
        makeOpenTrade({ entryPrice: 100, targetPrice: 110, quantity: 1, symbol: "BTC/USD" }),
        makeOpenTrade({ entryPrice: 100, targetPrice: 110, quantity: 1, symbol: "PAXG/USD" }),
      ],
      at([ticker("BTC/USD", 105)]),
      NOW,
    );

    const stats = summarizePositions(positions);

    expect(stats.marked).toBe(false);
    expect(stats.floatingPnl).toBeNull();
    expect(stats.costBasis).toBeCloseTo(200, 10); // cost basis needs no price
  });

  it("returns zeroes for an empty book", () => {
    const stats = summarizePositions([]);

    expect(stats.open).toBe(0);
    expect(stats.floatingPnl).toBe(0);
    expect(stats.oldestAgeMs).toBeNull();
  });
});
