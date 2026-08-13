import { describe, expect, it } from "vitest";
import { canClearRef, holdsPosition, shouldCancelOnStop } from "./stop-policy.js";

const order = (entityType: string, status: string) => ({ entityType, status });

/** A grid level waiting to buy: nothing bought, exit not needed yet. */
const waitingToBuy = [order("EntryOrder", "Placed"), order("TakeProfitOrder", "Idle")];

/** A grid level holding stock with its exit resting on the exchange. */
const holding = [order("EntryOrder", "Filled"), order("TakeProfitOrder", "Placed")];

/** A completed cycle: bought and sold. */
const completed = [order("EntryOrder", "Filled"), order("TakeProfitOrder", "Filled")];

/** A DCA position averaged down, still open. */
const dcaHolding = [
  order("EntryOrder", "Filled"),
  order("SafetyOrder", "Filled"),
  order("SafetyOrder", "Placed"),
  order("TakeProfitOrder", "Placed"),
];

describe("holdsPosition", () => {
  it("is false while the entry has not filled", () => {
    expect(holdsPosition(waitingToBuy)).toBe(false);
  });

  it("is true once the entry filled and nothing has closed it", () => {
    expect(holdsPosition(holding)).toBe(true);
  });

  it("is false once an exit filled", () => {
    expect(holdsPosition(completed)).toBe(false);
  });

  it("counts a filled safety order as holding", () => {
    expect(holdsPosition([order("SafetyOrder", "Filled"), order("TakeProfitOrder", "Placed")])).toBe(true);
  });

  it("treats a stop loss as an exit", () => {
    expect(holdsPosition([order("EntryOrder", "Filled"), order("StopLossOrder", "Filled")])).toBe(false);
  });
});

describe("shouldCancelOnStop", () => {
  it("cancels an entry that never filled", () => {
    // No position was opened, so pulling the order leaves nothing behind.
    expect(shouldCancelOnStop(order("EntryOrder", "Placed"), waitingToBuy)).toBe(true);
  });

  it("cancels the exit of a level that never bought", () => {
    // The exit is idle behind an unfilled entry; there is nothing to protect.
    expect(shouldCancelOnStop(order("TakeProfitOrder", "Idle"), waitingToBuy)).toBe(true);
  });

  it("leaves the exit working when the position is held", () => {
    // This is the bug being fixed: cancelling here strands the position.
    expect(shouldCancelOnStop(order("TakeProfitOrder", "Placed"), holding)).toBe(false);
  });

  it("leaves a stop loss working when the position is held", () => {
    const withStop = [order("EntryOrder", "Filled"), order("StopLossOrder", "Placed")];

    expect(shouldCancelOnStop(order("StopLossOrder", "Placed"), withStop)).toBe(false);
  });

  it("still cancels a resting safety order while holding", () => {
    // A safety order would buy MORE of an asset the bot is no longer managing.
    expect(shouldCancelOnStop(order("SafetyOrder", "Placed"), dcaHolding)).toBe(true);
  });

  it("keeps the take profit of a held DCA position", () => {
    expect(shouldCancelOnStop(order("TakeProfitOrder", "Placed"), dcaHolding)).toBe(false);
  });

  it("cancels everything once the cycle completed", () => {
    for (const o of completed) expect(shouldCancelOnStop(o, completed)).toBe(true);
  });
});

describe("canClearRef", () => {
  it("allows clearing when nothing is held", () => {
    expect(canClearRef(waitingToBuy)).toBe(true);
    expect(canClearRef(completed)).toBe(true);
  });

  it("refuses to clear while a position is held", () => {
    // Clearing the ref is what made orphaning permanent: a bot finds its trades
    // by ref, so a cleared ref means the position can never be re-adopted.
    expect(canClearRef(holding)).toBe(false);
    expect(canClearRef(dcaHolding)).toBe(false);
  });
});

describe("the stranding scenario end to end", () => {
  it("a stopped bot no longer leaves a position without an exit", () => {
    const orders = holding;
    const survivors = orders.filter((o) => !shouldCancelOnStop(o, orders));

    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.entityType).toBe("TakeProfitOrder");
    expect(canClearRef(orders)).toBe(false);
  });

  it("a stopped bot still clears levels that were only bidding", () => {
    const orders = waitingToBuy;
    const survivors = orders.filter((o) => !shouldCancelOnStop(o, orders));

    expect(survivors).toHaveLength(0);
    expect(canClearRef(orders)).toBe(true);
  });
});
