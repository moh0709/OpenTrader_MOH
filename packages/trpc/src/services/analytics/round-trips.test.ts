import { beforeEach, describe, expect, it } from "vitest";
import { aggregateFills, classifyOutcome, summarizeRoundTrips, toRoundTrip, toRoundTrips } from "./round-trips.js";
import { makeClosedTrade, makeOpenTrade, makeOrder, makePendingTrade, makeTrade, resetFixtureIds } from "./test-fixtures.js";

beforeEach(resetFixtureIds);

describe("toRoundTrip", () => {
  it("computes profit for a completed grid cycle", () => {
    // SmartTrade 359 from the live install: bought 0.012 BTC at 65005.35, sold at 65027.34.
    const roundTrip = toRoundTrip(makeClosedTrade({ entryPrice: 65_005.35, exitPrice: 65_027.34 }));

    expect(roundTrip).not.toBeNull();
    expect(roundTrip!.entryPrice).toBe(65_005.35);
    expect(roundTrip!.exitPrice).toBe(65_027.34);
    expect(roundTrip!.grossPnl).toBeCloseTo(0.26388, 6);
    expect(roundTrip!.netPnl).toBeCloseTo(0.26388, 6);
    expect(roundTrip!.outcome).toBe("win");
    expect(roundTrip!.exitKind).toBe("takeProfit");
  });

  it("reports profit as a percent of capital deployed, not of price", () => {
    const roundTrip = toRoundTrip(makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 2 }))!;

    expect(roundTrip.costBasis).toBe(200);
    expect(roundTrip.grossPnl).toBe(20);
    expect(roundTrip.pnlPercent).toBeCloseTo(10, 10);
  });

  it("subtracts fees from the realised result", () => {
    const roundTrip = toRoundTrip(makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, fee: 0.5 }))!;

    expect(roundTrip.grossPnl).toBe(10);
    expect(roundTrip.fees).toBe(1); // one on each leg
    expect(roundTrip.netPnl).toBe(9);
  });

  it("classifies a stop loss below the entry as a loss", () => {
    const roundTrip = toRoundTrip(
      makeClosedTrade({ entryPrice: 65_000, exitPrice: 64_000, exitEntityType: "StopLossOrder" }),
    )!;

    expect(roundTrip.exitKind).toBe("stopLoss");
    expect(roundTrip.netPnl).toBeLessThan(0);
    expect(roundTrip.outcome).toBe("loss");
  });

  it("weights a DCA entry by quantity across its safety orders", () => {
    // Buy 1 at 100 then 3 at 60: the average entry is 70, not 80.
    const trade = makeTrade([
      makeOrder({ entityType: "EntryOrder", side: "Buy", price: 100, filledPrice: 100, quantity: 1 }),
      makeOrder({ entityType: "SafetyOrder", side: "Buy", price: 60, filledPrice: 60, quantity: 3 }),
      makeOrder({ entityType: "TakeProfitOrder", side: "Sell", price: 80, filledPrice: 80, quantity: 4 }),
    ]);

    const roundTrip = toRoundTrip(trade)!;

    expect(roundTrip.entryPrice).toBeCloseTo(70, 10);
    expect(roundTrip.quantity).toBe(4);
    expect(roundTrip.grossPnl).toBeCloseTo(40, 10);
    expect(roundTrip.entryFillCount).toBe(2);
  });

  it("averages a ladder exit across its fills", () => {
    const trade = makeTrade([
      makeOrder({ entityType: "EntryOrder", side: "Buy", price: 100, filledPrice: 100, quantity: 2 }),
      makeOrder({ entityType: "TakeProfitOrder", side: "Sell", price: 110, filledPrice: 110, quantity: 1 }),
      makeOrder({ entityType: "TakeProfitOrder", side: "Sell", price: 130, filledPrice: 130, quantity: 1 }),
    ]);

    const roundTrip = toRoundTrip(trade)!;

    expect(roundTrip.exitPrice).toBeCloseTo(120, 10);
    expect(roundTrip.grossPnl).toBeCloseTo(40, 10);
    expect(roundTrip.fullyClosed).toBe(true);
  });

  it("only counts the quantity that actually round-tripped", () => {
    const trade = makeTrade([
      makeOrder({ entityType: "EntryOrder", side: "Buy", price: 100, filledPrice: 100, quantity: 10 }),
      makeOrder({ entityType: "TakeProfitOrder", side: "Sell", price: 110, filledPrice: 110, quantity: 4 }),
    ]);

    const roundTrip = toRoundTrip(trade)!;

    expect(roundTrip.quantity).toBe(4);
    expect(roundTrip.grossPnl).toBeCloseTo(40, 10);
    expect(roundTrip.fullyClosed).toBe(false);
  });

  it("inverts the sign for a short cycle", () => {
    const trade = makeTrade([
      makeOrder({ entityType: "EntryOrder", side: "Sell", price: 100, filledPrice: 100, quantity: 1 }),
      makeOrder({ entityType: "TakeProfitOrder", side: "Buy", price: 90, filledPrice: 90, quantity: 1 }),
    ]);

    const roundTrip = toRoundTrip(trade)!;

    expect(roundTrip.grossPnl).toBeCloseTo(10, 10);
    expect(roundTrip.outcome).toBe("win");
  });

  it("measures hold time from first entry fill to last exit fill", () => {
    const roundTrip = toRoundTrip(
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, entryAt: 1_000_000, exitAt: 1_900_000 }),
    )!;

    expect(roundTrip.holdMs).toBe(900_000);
  });

  it("returns null while a position is still open", () => {
    expect(toRoundTrip(makeOpenTrade({ entryPrice: 65_000, targetPrice: 65_020 }))).toBeNull();
  });

  it("returns null when the entry never filled", () => {
    expect(toRoundTrip(makePendingTrade({ price: 64_800 }))).toBeNull();
  });

  it("ignores an exit that was cancelled rather than filled", () => {
    expect(toRoundTrip(makeOpenTrade({ entryPrice: 65_000, targetPrice: 65_020, exitStatus: "Canceled" }))).toBeNull();
  });
});

describe("aggregateFills", () => {
  it("returns zeroes for an empty set rather than NaN", () => {
    const result = aggregateFills([]);

    expect(result.quantity).toBe(0);
    expect(result.averagePrice).toBe(0);
    expect(result.firstAt).toBe(0);
  });
});

describe("classifyOutcome", () => {
  it("treats a vanishingly small result as breakeven", () => {
    expect(classifyOutcome(1e-12)).toBe("breakeven");
    expect(classifyOutcome(0)).toBe("breakeven");
    expect(classifyOutcome(0.01)).toBe("win");
    expect(classifyOutcome(-0.01)).toBe("loss");
  });
});

describe("toRoundTrips", () => {
  it("returns closed trades newest first", () => {
    const trades = [
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, exitAt: 1_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 120, exitAt: 3_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 130, exitAt: 2_000 }),
    ];

    expect(toRoundTrips(trades).map((rt) => rt.exitAt)).toEqual([3_000, 2_000, 1_000]);
  });

  it("skips trades that have not closed", () => {
    const trades = [
      makeClosedTrade({ entryPrice: 100, exitPrice: 110 }),
      makeOpenTrade({ entryPrice: 100, targetPrice: 110 }),
      makePendingTrade({ price: 90 }),
    ];

    expect(toRoundTrips(trades)).toHaveLength(1);
  });
});

describe("summarizeRoundTrips", () => {
  it("reports an all-winning grid fleet honestly", () => {
    // Every grid trade takes profit above its entry, so a 100% win rate is the
    // expected state and the summary flags it rather than implying skill.
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: 1_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 105, quantity: 1, exitAt: 2_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 120, quantity: 1, exitAt: 3_000 }),
    ]);

    const stats = summarizeRoundTrips(roundTrips);

    expect(stats.trades).toBe(3);
    expect(stats.wins).toBe(3);
    expect(stats.losses).toBe(0);
    expect(stats.winRate).toBe(100);
    expect(stats.losslessSoFar).toBe(true);
    expect(stats.profitFactor).toBeNull(); // undefined without losses, not Infinity
    expect(stats.netPnl).toBeCloseTo(35, 10);
    expect(stats.bestTrade).toBeCloseTo(20, 10);
    expect(stats.worstTrade).toBeCloseTo(5, 10);
  });

  it("computes profit factor and streaks once there are losses", () => {
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: 1_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 120, quantity: 1, exitAt: 2_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 90, quantity: 1, exitAt: 3_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 95, quantity: 1, exitAt: 4_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 130, quantity: 1, exitAt: 5_000 }),
    ]);

    const stats = summarizeRoundTrips(roundTrips);

    expect(stats.wins).toBe(3);
    expect(stats.losses).toBe(2);
    expect(stats.winRate).toBeCloseTo(60, 10);
    expect(stats.grossWin).toBeCloseTo(60, 10);
    expect(stats.grossLoss).toBeCloseTo(15, 10);
    expect(stats.profitFactor).toBeCloseTo(4, 10);
    expect(stats.maxConsecutiveWins).toBe(2);
    expect(stats.maxConsecutiveLosses).toBe(2);
    expect(stats.losslessSoFar).toBe(false);
  });

  it("counts streaks in the order trades closed, not the order supplied", () => {
    // Supplied newest first, which is how the API returns them.
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 90, quantity: 1, exitAt: 4_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 90, quantity: 1, exitAt: 3_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, exitAt: 2_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 90, quantity: 1, exitAt: 1_000 }),
    ]);

    const stats = summarizeRoundTrips(roundTrips);

    expect(stats.maxConsecutiveLosses).toBe(2);
    expect(stats.firstTradeAt).toBe(1_000);
    expect(stats.lastTradeAt).toBe(4_000);
  });

  it("returns a zeroed summary rather than NaN when nothing has closed", () => {
    const stats = summarizeRoundTrips([]);

    expect(stats.trades).toBe(0);
    expect(stats.winRate).toBeNull();
    expect(stats.netPnl).toBe(0);
    expect(stats.averagePnl).toBe(0);
    expect(stats.losslessSoFar).toBe(false);
  });

  it("takes the median hold time from an even-sized set", () => {
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, entryAt: 0, exitAt: 100, quantity: 1 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, entryAt: 0, exitAt: 300, quantity: 1 }),
    ]);

    expect(summarizeRoundTrips(roundTrips).medianHoldMs).toBe(200);
  });
});
