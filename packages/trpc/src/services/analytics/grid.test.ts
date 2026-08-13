import { beforeEach, describe, expect, it } from "vitest";
import { buildGridModel, parseGridLines } from "./grid.js";
import { toRoundTrips } from "./round-trips.js";
import { toOpenPositions } from "./positions.js";
import { tickerLookup } from "./bot-stats.js";
import { makeBot, makeClosedTrade, makeGridSettings, makeOpenTrade, makePendingTrade, resetFixtureIds } from "./test-fixtures.js";

beforeEach(resetFixtureIds);

const NOW = 1_786_362_000_000;
const noTickers = tickerLookup([]);

// A four-rung grid, 20 apart, modelled on the live Bronze Dud Bolt settings.
const GRID = [64_960, 64_980, 65_000, 65_020];

describe("parseGridLines", () => {
  it("sorts levels highest first so the ladder reads top down", () => {
    expect(parseGridLines(makeGridSettings([100, 300, 200])).map((l) => l.price)).toEqual([300, 200, 100]);
  });

  it("returns nothing for a bot with no grid", () => {
    expect(parseGridLines({})).toEqual([]);
    expect(parseGridLines({ gridLines: "nope" })).toEqual([]);
  });

  it("drops malformed entries rather than throwing", () => {
    expect(parseGridLines({ gridLines: [{ price: 100, quantity: 1 }, { price: "x" }, null] })).toHaveLength(1);
  });
});

describe("buildGridModel", () => {
  it("attributes realised profit to the level the trade entered at", () => {
    const trades = [
      makeClosedTrade({ entryPrice: 65_000, exitPrice: 65_020, quantity: 1 }),
      makeClosedTrade({ entryPrice: 65_000, exitPrice: 65_020, quantity: 1 }),
      makeClosedTrade({ entryPrice: 64_980, exitPrice: 65_000, quantity: 1 }),
    ];

    const model = buildGridModel(
      makeBot({ settings: makeGridSettings(GRID) }),
      trades,
      toRoundTrips(trades),
      [],
      65_010,
    );

    const at65000 = model.levels.find((l) => l.price === 65_000)!;
    const at64980 = model.levels.find((l) => l.price === 64_980)!;

    expect(at65000.completedTrades).toBe(2);
    expect(at65000.realizedPnl).toBeCloseTo(40, 10);
    expect(at64980.completedTrades).toBe(1);
    expect(model.totals.bestLevelPrice).toBe(65_000);
  });

  it("reports which levels are holding stock and which are waiting to buy", () => {
    const trades = [
      makeOpenTrade({ entryPrice: 65_000, targetPrice: 65_020, quantity: 1 }),
      makePendingTrade({ price: 64_960 }),
    ];
    const positions = toOpenPositions(trades, noTickers, NOW);

    const model = buildGridModel(makeBot({ settings: makeGridSettings(GRID) }), trades, [], positions, 64_990);

    expect(model.levels.find((l) => l.price === 65_000)!.holding).toBe(1);
    expect(model.levels.find((l) => l.price === 64_960)!.pendingBuys).toBe(1);
    expect(model.totals.holding).toBe(1);
    expect(model.totals.pendingBuys).toBe(1);
  });

  it("flags levels holding stock with no exit order", () => {
    const trades = [makeOpenTrade({ entryPrice: 65_000, targetPrice: 65_020, exitStatus: "Canceled" })];
    const model = buildGridModel(
      makeBot({ settings: makeGridSettings(GRID) }),
      trades,
      [],
      toOpenPositions(trades, noTickers, NOW),
      64_990,
    );

    expect(model.levels.find((l) => l.price === 65_000)!.abandoned).toBe(1);
    expect(model.totals.abandoned).toBe(1);
  });

  it("keeps trades from a previous grid configuration visible as off-grid", () => {
    // Bots get reconfigured. A trade entered at 64943.015 belongs to no current
    // level, and must not be silently dropped from the profit total.
    const trades = [makeClosedTrade({ entryPrice: 64_943.015, exitPrice: 64_974.57, quantity: 1 })];

    const model = buildGridModel(
      makeBot({ settings: makeGridSettings(GRID) }),
      trades,
      toRoundTrips(trades),
      [],
      65_000,
    );

    expect(model.offGridTrades).toBe(1);
    expect(model.offGridPnl).toBeCloseTo(31.555, 3);
    expect(model.totals.completedTrades).toBe(0);
  });

  it("matches a fill within half a grid step to its level", () => {
    // Fills land near the level, not exactly on it.
    const trades = [makeClosedTrade({ entryPrice: 65_001.5, exitPrice: 65_021, quantity: 1 })];

    const model = buildGridModel(
      makeBot({ settings: makeGridSettings(GRID) }),
      trades,
      toRoundTrips(trades),
      [],
      65_010,
    );

    expect(model.levels.find((l) => l.price === 65_000)!.completedTrades).toBe(1);
    expect(model.offGridTrades).toBe(0);
  });

  it("reports the share of levels that have ever earned", () => {
    const trades = [makeClosedTrade({ entryPrice: 65_000, exitPrice: 65_020, quantity: 1 })];

    const model = buildGridModel(
      makeBot({ settings: makeGridSettings(GRID) }),
      trades,
      toRoundTrips(trades),
      [],
      65_010,
    );

    expect(model.totals.levels).toBe(4);
    expect(model.totals.levelsWithFills).toBe(1);
    expect(model.totals.fillRate).toBeCloseTo(25, 10);
  });

  it("warns when the price has left the configured range", () => {
    const bot = makeBot({ settings: makeGridSettings(GRID) });

    expect(buildGridModel(bot, [], [], [], 65_010).outOfRange).toBe(false);
    expect(buildGridModel(bot, [], [], [], 70_000).outOfRange).toBe(true);
    expect(buildGridModel(bot, [], [], [], 60_000).outOfRange).toBe(true);
  });

  it("positions each level relative to the live price", () => {
    const model = buildGridModel(makeBot({ settings: makeGridSettings(GRID) }), [], [], [], 64_990);

    expect(model.levels.find((l) => l.price === 65_020)!.side).toBe("above");
    expect(model.levels.find((l) => l.price === 64_960)!.side).toBe("below");
  });

  it("handles a non-grid bot without pretending it has levels", () => {
    const model = buildGridModel(makeBot({ template: "dca", settings: {} }), [], [], [], 100);

    expect(model.isGrid).toBe(false);
    expect(model.levels).toEqual([]);
    expect(model.totals.fillRate).toBe(0);
  });

  it("does not crash without a live price", () => {
    const model = buildGridModel(makeBot({ settings: makeGridSettings(GRID) }), [], [], [], null);

    expect(model.outOfRange).toBe(false);
    expect(model.levels[0]!.distancePercent).toBeNull();
  });
});
