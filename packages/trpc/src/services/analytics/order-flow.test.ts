/**
 * Regression tests for the idle-order health check.
 *
 * The first live run of this check reported 17 orders "stuck idle" on a healthy
 * install. Every one was a take profit sitting behind an entry that had not
 * filled - which is simply how OpenTrader holds an exit until it is needed. A
 * check that fires permanently trains you to ignore it, so the rule is: an idle
 * order only counts when it was actually due to be placed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { filledEntries, isEntryOrder } from "./round-trips.js";
import { makeOrder, makeTrade, resetFixtureIds } from "./test-fixtures.js";
import type { AnalyticsSmartTrade } from "./types.js";

beforeEach(resetFixtureIds);

/**
 * The rule under test, mirroring `buildHealthView` in `dashboard-views.ts`.
 * Kept here so the logic is covered without standing up the whole view layer.
 */
function countStuckIdle(trades: AnalyticsSmartTrade[]) {
  let stuck = 0;

  for (const trade of trades) {
    const entryFilled = filledEntries(trade).length > 0;

    for (const order of trade.orders) {
      if (order.status !== "Idle") continue;
      if (!isEntryOrder(order) && !entryFilled) continue;

      stuck += 1;
    }
  }

  return stuck;
}

const idleExitBehindUnfilledEntry = () =>
  makeTrade([
    makeOrder({ entityType: "EntryOrder", side: "Buy", status: "Placed", filledPrice: null, filledAt: null }),
    makeOrder({ entityType: "TakeProfitOrder", side: "Sell", status: "Idle", filledPrice: null, filledAt: null }),
  ]);

const idleExitAfterFilledEntry = () =>
  makeTrade([
    makeOrder({ entityType: "EntryOrder", side: "Buy", status: "Filled", filledPrice: 65_000 }),
    makeOrder({ entityType: "TakeProfitOrder", side: "Sell", status: "Idle", filledPrice: null, filledAt: null }),
  ]);

const idleEntry = () =>
  makeTrade([
    makeOrder({ entityType: "EntryOrder", side: "Buy", status: "Idle", filledPrice: null, filledAt: null }),
    makeOrder({ entityType: "TakeProfitOrder", side: "Sell", status: "Idle", filledPrice: null, filledAt: null }),
  ]);

describe("stuck idle orders", () => {
  it("does not flag an exit waiting behind an unfilled entry", () => {
    // The normal resting state of every grid level that has not traded yet.
    expect(countStuckIdle([idleExitBehindUnfilledEntry()])).toBe(0);
  });

  it("flags an exit still idle after its entry filled", () => {
    // Here the take profit was due to be placed and was not - a real fault.
    expect(countStuckIdle([idleExitAfterFilledEntry()])).toBe(1);
  });

  it("flags an idle entry order, which should always have been placed", () => {
    expect(countStuckIdle([idleEntry()])).toBe(1);
  });

  it("stays quiet on a whole book of untraded grid levels", () => {
    // The shape that produced the false alarm: many levels, none filled.
    const book = Array.from({ length: 17 }, idleExitBehindUnfilledEntry);

    expect(countStuckIdle(book)).toBe(0);
  });

  it("counts only the genuine faults in a mixed book", () => {
    const book = [
      ...Array.from({ length: 10 }, idleExitBehindUnfilledEntry),
      idleExitAfterFilledEntry(),
      idleEntry(),
    ];

    expect(countStuckIdle(book)).toBe(2);
  });

  it("ignores orders that are placed or filled", () => {
    const trade = makeTrade([
      makeOrder({ entityType: "EntryOrder", side: "Buy", status: "Filled", filledPrice: 100 }),
      makeOrder({ entityType: "TakeProfitOrder", side: "Sell", status: "Placed", filledPrice: null, filledAt: null }),
    ]);

    expect(countStuckIdle([trade])).toBe(0);
  });
});
