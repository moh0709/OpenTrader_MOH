import { beforeEach, describe, expect, it } from "vitest";
import {
  buildActivityHeatmap,
  buildEquityCurve,
  buildFeeBreakdown,
  buildHoldTimeDistribution,
  buildPnlDistribution,
  buildSparkline,
  windowTotals,
} from "./history.js";
import { toRoundTrips } from "./round-trips.js";
import { makeClosedTrade, resetFixtureIds } from "./test-fixtures.js";

beforeEach(resetFixtureIds);

const HOUR = 3_600_000;
const BASE = 1_786_000_000_000;

describe("buildEquityCurve", () => {
  it("accumulates profit across buckets", () => {
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: BASE }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 105, quantity: 1, exitAt: BASE + HOUR }),
    ]);

    const curve = buildEquityCurve(roundTrips, "1h");

    expect(curve).toHaveLength(2);
    expect(curve[0]!.cumulative).toBeCloseTo(10, 10);
    expect(curve[1]!.cumulative).toBeCloseTo(15, 10);
  });

  it("emits flat buckets for quiet periods instead of skipping them", () => {
    // Skipping empty buckets would compress a quiet day into a steep-looking climb.
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: BASE }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: BASE + 4 * HOUR }),
    ]);

    const curve = buildEquityCurve(roundTrips, "1h");

    expect(curve).toHaveLength(5);
    expect(curve[2]!.trades).toBe(0);
    expect(curve[2]!.cumulative).toBeCloseTo(10, 10); // holds the running total
  });

  it("sums several trades landing in the same bucket", () => {
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: BASE }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: BASE + 60_000 }),
    ]);

    const curve = buildEquityCurve(roundTrips, "1h");

    expect(curve).toHaveLength(1);
    expect(curve[0]!.trades).toBe(2);
    expect(curve[0]!.pnl).toBeCloseTo(20, 10);
  });

  it("returns nothing when there is nothing to plot", () => {
    expect(buildEquityCurve([], "1h")).toEqual([]);
  });

  it("caps the series so a small bucket over a long range cannot run away", () => {
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: BASE }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: BASE + 400 * 24 * HOUR }),
    ]);

    expect(buildEquityCurve(roundTrips, "5m").length).toBeLessThanOrEqual(2000);
  });
});

describe("buildSparkline", () => {
  it("returns the running total per trade when there are few trades", () => {
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: 1_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: 2_000 }),
    ]);

    expect(buildSparkline(roundTrips)).toEqual([10, 20]);
  });

  it("samples down to the requested width for a long history", () => {
    const roundTrips = toRoundTrips(
      Array.from({ length: 500 }, (_, i) => makeClosedTrade({ entryPrice: 100, exitPrice: 101, quantity: 1, exitAt: 1_000 + i })),
    );

    const sparkline = buildSparkline(roundTrips, 40);

    expect(sparkline).toHaveLength(40);
    expect(sparkline[39]).toBeCloseTo(500, 6); // still ends at the true total
  });

  it("is empty when nothing has closed", () => {
    expect(buildSparkline([])).toEqual([]);
  });
});

describe("buildPnlDistribution", () => {
  it("spreads trades across bins", () => {
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 101, quantity: 1, exitAt: 1 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 105, quantity: 1, exitAt: 2 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: 3 }),
    ]);

    const bins = buildPnlDistribution(roundTrips, 3);

    expect(bins).toHaveLength(3);
    expect(bins.reduce((sum, b) => sum + b.count, 0)).toBe(3);
  });

  it("collapses to one bin when every trade earned the same", () => {
    // Grid bots produce near-identical profits, which would otherwise divide by zero.
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: 1 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: 2 }),
    ]);

    const bins = buildPnlDistribution(roundTrips, 12);

    expect(bins).toHaveLength(1);
    expect(bins[0]!.count).toBe(2);
  });

  it("is empty with no trades", () => {
    expect(buildPnlDistribution([])).toEqual([]);
  });
});

describe("buildHoldTimeDistribution", () => {
  it("buckets trades by how long they were held", () => {
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, entryAt: 0, exitAt: 30_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, entryAt: 0, exitAt: 20 * 60_000 }),
    ]);

    const buckets = buildHoldTimeDistribution(roundTrips);

    expect(buckets.find((b) => b.label === "< 1m")!.count).toBe(1);
    expect(buckets.find((b) => b.label === "15-30m")!.count).toBe(1);
  });

  it("always returns every bucket so the chart axis is stable", () => {
    expect(buildHoldTimeDistribution([])).toHaveLength(8);
  });
});

describe("buildActivityHeatmap", () => {
  it("returns a full week by hour grid", () => {
    expect(buildActivityHeatmap([])).toHaveLength(168);
  });

  it("places a trade in its UTC weekday and hour", () => {
    // 2026-08-10T11:38:48Z is a Monday at 11:00 UTC.
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: Date.UTC(2026, 7, 10, 11, 38, 48) }),
    ]);

    const cell = buildActivityHeatmap(roundTrips).find((c) => c.count > 0)!;

    expect(cell.day).toBe(1);
    expect(cell.hour).toBe(11);
    expect(cell.pnl).toBeCloseTo(10, 10);
  });
});

describe("buildFeeBreakdown", () => {
  it("separates gross from net and reports the fee drag", () => {
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, fee: 0.5, exitAt: 1 }),
    ]);

    const fees = buildFeeBreakdown(roundTrips);

    expect(fees.gross).toBeCloseTo(10, 10);
    expect(fees.fees).toBeCloseTo(1, 10);
    expect(fees.net).toBeCloseTo(9, 10);
    expect(fees.feeRatio).toBeCloseTo(10, 10);
  });

  it("leaves the ratio undefined rather than dividing by zero", () => {
    expect(buildFeeBreakdown([]).feeRatio).toBeNull();
  });
});

describe("windowTotals", () => {
  it("counts only trades inside the window", () => {
    const now = BASE + 10 * HOUR;
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: now - HOUR }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: now - 5 * HOUR }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: now - 48 * HOUR }),
    ]);

    const totals = windowTotals(roundTrips, now, 24 * HOUR);

    expect(totals.trades).toBe(2);
    expect(totals.netPnl).toBeCloseTo(20, 10);
    expect(totals.wins).toBe(2);
  });
});
