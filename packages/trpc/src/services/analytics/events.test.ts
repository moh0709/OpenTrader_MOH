import { beforeEach, describe, expect, it } from "vitest";
import { botLogEvents, mergeEvents, nextCursor, tradeClosedEvents } from "./events.js";
import { toRoundTrips } from "./round-trips.js";
import { makeClosedTrade, resetFixtureIds } from "./test-fixtures.js";

beforeEach(resetFixtureIds);

const names = new Map([
  [5, "Bronze Dud Bolt"],
  [8, "Hermes mini"],
]);

describe("tradeClosedEvents", () => {
  it("describes a winning close with amount and percent", () => {
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 65_005.35, exitPrice: 65_027.34, exitAt: 5_000 }),
    ]);

    const [event] = tradeClosedEvents(roundTrips, names, 0);

    expect(event!.type).toBe("tradeClosed");
    expect(event!.severity).toBe("success");
    expect(event!.title).toBe("Deal closed - win");
    expect(event!.message).toContain("Bronze Dud Bolt");
    expect(event!.message).toContain("BTC/USD");
    expect(event!.message).toContain("+0.26");
    expect(event!.message).toContain("(+0.03%)");
  });

  it("marks a losing close as danger", () => {
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 90, quantity: 1, exitAt: 5_000, exitEntityType: "StopLossOrder" }),
    ]);

    const [event] = tradeClosedEvents(roundTrips, names, 0);

    expect(event!.severity).toBe("danger");
    expect(event!.title).toBe("Deal closed - loss");
    expect(event!.message).toContain("-10.00");
  });

  it("returns only trades that closed after the cursor", () => {
    const roundTrips = toRoundTrips([
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, exitAt: 1_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, exitAt: 2_000 }),
      makeClosedTrade({ entryPrice: 100, exitPrice: 110, exitAt: 3_000 }),
    ]);

    expect(tradeClosedEvents(roundTrips, names, 1_500)).toHaveLength(2);
  });

  it("never re-emits a trade already seen, so a reload does not replay toasts", () => {
    const roundTrips = toRoundTrips([makeClosedTrade({ entryPrice: 100, exitPrice: 110, exitAt: 2_000 })]);
    const first = tradeClosedEvents(roundTrips, names, 0);
    const cursor = nextCursor(first, 0);

    expect(first).toHaveLength(1);
    expect(tradeClosedEvents(roundTrips, names, cursor)).toHaveLength(0);
  });

  it("falls back to the bot id when the name is unknown", () => {
    const roundTrips = toRoundTrips([makeClosedTrade({ entryPrice: 100, exitPrice: 110, botId: 99, exitAt: 1_000 })]);

    expect(tradeClosedEvents(roundTrips, names, 0)[0]!.message).toContain("Bot 99");
  });
});

describe("botLogEvents", () => {
  const log = (overrides: Partial<{ id: number; botId: number; action: string; error: string | null; createdAt: Date }>) => ({
    id: 1,
    botId: 5,
    action: "start",
    error: null,
    createdAt: new Date(5_000),
    ...overrides,
  });

  it("reports a bot starting", () => {
    const [event] = botLogEvents([log({})], names, 0);

    expect(event!.type).toBe("botStarted");
    expect(event!.message).toBe("Bronze Dud Bolt");
  });

  it("explains the consequence of stopping a bot", () => {
    // Stopping cancels resting take profits, which strands any open position.
    const [event] = botLogEvents([log({ action: "stop" })], names, 0);

    expect(event!.type).toBe("botStopped");
    expect(event!.severity).toBe("warning");
    expect(event!.message).toContain("without a sell order");
  });

  it("surfaces errors ahead of the action that produced them", () => {
    const [event] = botLogEvents([log({ action: "process", error: "Exchange rejected order" })], names, 0);

    expect(event!.type).toBe("botError");
    expect(event!.severity).toBe("danger");
    expect(event!.message).toContain("Exchange rejected order");
  });

  it("truncates a long error instead of flooding the feed", () => {
    const [event] = botLogEvents([log({ action: "process", error: "x".repeat(500) })], names, 0);

    expect(event!.message.length).toBeLessThan(200);
    expect(event!.message).toContain("...");
  });

  it("ignores routine processing entries", () => {
    expect(botLogEvents([log({ action: "process" })], names, 0)).toHaveLength(0);
  });

  it("respects the cursor", () => {
    expect(botLogEvents([log({ createdAt: new Date(1_000) })], names, 2_000)).toHaveLength(0);
  });
});

describe("mergeEvents", () => {
  const event = (at: number) => ({
    id: `e${at}`, type: "tradeClosed" as const, at, botId: 5, botName: "b", symbol: "BTC/USD",
    title: "t", message: "m", severity: "success" as const, pnl: 1, pnlPercent: 1, smartTradeId: 1,
  });

  it("orders events oldest first so toasts appear in sequence", () => {
    expect(mergeEvents([[event(3_000), event(1_000)], [event(2_000)]]).map((e) => e.at)).toEqual([1_000, 2_000, 3_000]);
  });

  it("keeps the newest events when a client returns after a long absence", () => {
    const many = Array.from({ length: 100 }, (_, i) => event(i));
    const merged = mergeEvents([many], 10);

    expect(merged).toHaveLength(10);
    expect(merged[0]!.at).toBe(90);
    expect(merged[9]!.at).toBe(99);
  });
});

describe("nextCursor", () => {
  it("advances to the newest event", () => {
    const event = (at: number) => ({
      id: `e${at}`, type: "tradeClosed" as const, at, botId: null, botName: null, symbol: null,
      title: "t", message: "m", severity: "info" as const, pnl: null, pnlPercent: null, smartTradeId: null,
    });

    expect(nextCursor([event(1_000), event(5_000), event(3_000)], 0)).toBe(5_000);
  });

  it("never moves backwards when there is nothing new", () => {
    expect(nextCursor([], 9_000)).toBe(9_000);
  });
});
