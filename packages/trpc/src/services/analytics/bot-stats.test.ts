import { beforeEach, describe, expect, it } from "vitest";
import { buildLeaderboard, computeAllBotStats, computeBotStats, computeFleetTotals, groupTradesByBot, tickerLookup } from "./bot-stats.js";
import { toRoundTrips } from "./round-trips.js";
import { toOpenPositions, toPendingEntries } from "./positions.js";
import { makeBot, makeClosedTrade, makeOpenTrade, resetFixtureIds } from "./test-fixtures.js";

beforeEach(resetFixtureIds);

const NOW = 1_786_362_000_000;
const noTickers = tickerLookup([]);
const btc = tickerLookup([
  { symbol: "BTC/USD", last: 65_010, bid: 65_009, ask: 65_011, timestamp: NOW, fetchedAt: NOW, ageMs: 0, stale: false, error: null },
]);

describe("computeBotStats", () => {
  it("combines realised profit with what the open book is worth", () => {
    const trades = [
      makeClosedTrade({ entryPrice: 65_000, exitPrice: 65_020, quantity: 1 }),
      makeOpenTrade({ entryPrice: 65_000, targetPrice: 65_020, quantity: 1 }),
    ];

    const stats = computeBotStats(makeBot(), trades, btc, NOW);

    expect(stats.realized.netPnl).toBeCloseTo(20, 10);
    expect(stats.positions.floatingPnl).toBeCloseTo(10, 10);
    expect(stats.totalPnl).toBeCloseTo(30, 10);
  });

  it("leaves the combined total unknown when the book cannot be priced", () => {
    const stats = computeBotStats(makeBot(), [makeOpenTrade({ entryPrice: 65_000, targetPrice: 65_020 })], noTickers, NOW);

    expect(stats.totalPnl).toBeNull();
    expect(stats.tickerStale).toBe(true);
  });

  it("expresses profit as a return on the capital that was cycled", () => {
    const stats = computeBotStats(makeBot(), [makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1 })], btc, NOW);

    expect(stats.realized.volume).toBeCloseTo(100, 10);
    expect(stats.pnlPercent).toBeCloseTo(10, 10);
  });

  it("rates profit against how long the bot has been alive", () => {
    const bot = makeBot({ createdAt: new Date(NOW - 3_600_000) }); // one hour old
    const stats = computeBotStats(bot, [makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1 })], btc, NOW);

    expect(stats.pnlPerHour).toBeCloseTo(10, 6);
  });

  it("reports zeroes for a bot that has never traded", () => {
    const stats = computeBotStats(makeBot(), [], btc, NOW);

    expect(stats.realized.trades).toBe(0);
    expect(stats.realized.winRate).toBeNull();
    expect(stats.pnlPercent).toBe(0);
    expect(stats.lastFillAt).toBeNull();
  });
});

describe("groupTradesByBot", () => {
  it("keeps each bot trades separate and drops orphans", () => {
    const grouped = groupTradesByBot([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, botId: 5 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, botId: 8 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, botId: 5 }),
      { ...makeClosedTrade({ entryPrice: 100, exitPrice: 110 }), botId: null },
    ]);

    expect(grouped.get(5)).toHaveLength(2);
    expect(grouped.get(8)).toHaveLength(1);
    expect(grouped.has(0)).toBe(false);
  });
});

describe("buildLeaderboard", () => {
  // The live fleet: the bot with the most trades is not the one with the most
  // profit, which is exactly why the ranking metric has to be selectable.
  const bots = [
    makeBot({ id: 5, name: "Bronze Dud Bolt" }),
    makeBot({ id: 8, name: "Hermes mini" }),
    makeBot({ id: 9, name: "Idle bot" }),
  ];

  const trades = [
    ...Array.from({ length: 17 }, () => makeClosedTrade({ entryPrice: 100, exitPrice: 100.263, quantity: 1, botId: 5 })),
    ...Array.from({ length: 3 }, () => makeClosedTrade({ entryPrice: 100, exitPrice: 101.583, quantity: 1, botId: 8 })),
  ];

  const stats = () => computeAllBotStats(bots, trades, btc, NOW);

  it("ranks by total profit", () => {
    const board = buildLeaderboard(stats(), "netPnl");

    expect(board[0]!.name).toBe("Hermes mini"); // 4.75 from 3 trades
    expect(board[1]!.name).toBe("Bronze Dud Bolt"); // 4.47 from 17 trades
  });

  it("ranks by trade count, giving a different winner", () => {
    expect(buildLeaderboard(stats(), "trades")[0]!.name).toBe("Bronze Dud Bolt");
  });

  it("ranks by average profit per trade", () => {
    expect(buildLeaderboard(stats(), "averagePnl")[0]!.name).toBe("Hermes mini");
  });

  it("sorts bots with no closed trades last rather than treating them as zero", () => {
    const board = buildLeaderboard(stats(), "winRate");

    expect(board[board.length - 1]!.name).toBe("Idle bot");
    expect(board[board.length - 1]!.value).toBeNull();
  });

  it("numbers the ranks from one", () => {
    expect(buildLeaderboard(stats(), "netPnl").map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it("breaks ties by name so the order does not flicker between refreshes", () => {
    const tied = [makeBot({ id: 1, name: "Zulu" }), makeBot({ id: 2, name: "Alpha" })];
    const board = buildLeaderboard(computeAllBotStats(tied, [], btc, NOW), "netPnl");

    expect(board.map((e) => e.name)).toEqual(["Alpha", "Zulu"]);
  });
});

describe("computeFleetTotals", () => {
  it("derives fleet win rate from all trades, not by averaging bot averages", () => {
    // Bot A wins 1 of 1, bot B wins 1 of 3. Averaging the rates gives 66%;
    // the truth across four trades is 50%.
    const trades = [
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, botId: 5 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1, botId: 8 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 90, quantity: 1, botId: 8 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 90, quantity: 1, botId: 8 }),
    ];

    const totals = computeFleetTotals(
      [makeBot({ id: 5 }), makeBot({ id: 8 })],
      toRoundTrips(trades),
      [],
      [],
    );

    expect(totals.realized.trades).toBe(4);
    expect(totals.realized.winRate).toBeCloseTo(50, 10);
  });

  it("counts enabled bots and the symbols in play", () => {
    const totals = computeFleetTotals(
      [makeBot({ id: 5, symbol: "BTC/USD" }), makeBot({ id: 9, symbol: "PAXG/USD", enabled: false })],
      [],
      [],
      [],
    );

    expect(totals.bots).toBe(2);
    expect(totals.enabledBots).toBe(1);
    expect(totals.symbols).toEqual(["BTC/USD", "PAXG/USD"]);
  });

  it("adds floating profit to realised for the headline figure", () => {
    const closed = [makeClosedTrade({ entryPrice: 100, exitPrice: 110, quantity: 1 })];
    const open = [makeOpenTrade({ entryPrice: 65_000, targetPrice: 65_020, quantity: 1 })];

    const totals = computeFleetTotals(
      [makeBot()],
      toRoundTrips(closed),
      toOpenPositions(open, btc, NOW),
      toPendingEntries(open, btc, NOW),
    );

    expect(totals.totalPnl).toBeCloseTo(20, 10); // 10 realised + 10 floating
  });
});
