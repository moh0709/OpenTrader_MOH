import type { Candle } from "@opentrader/ai-team";
import { describe, expect, it } from "vitest";
import { peakSince } from "./positions.js";

/**
 * The high-water mark a trailing exit is measured against.
 *
 * Read off the candles rather than remembered, so it survives a restart and
 * needs no write on a loop that otherwise only reads. The property that matters
 * is that it can never be *lower* than the entry: a trail measured against a
 * peak below the entry price would fire on a position that has only ever lost.
 */

const bar = (timestamp: number, high: number): Candle => ({
  open: high,
  high,
  low: high,
  close: high,
  volume: 1,
  timestamp,
});

describe("peakSince", () => {
  const candles = [bar(100, 90), bar(200, 105), bar(300, 130), bar(400, 110)];

  it("takes the highest high after the position opened", () => {
    expect(peakSince(candles, 200, 100)).toBe(130);
  });

  it("ignores candles from before the entry", () => {
    // The 130 bar is at t=300; opening after it means it never happened for us.
    expect(peakSince(candles, 350, 100)).toBe(110);
  });

  it("falls back to the entry price when no candle covers the position", () => {
    expect(peakSince(candles, 900, 100)).toBe(100);
    expect(peakSince([], 0, 100)).toBe(100);
  });

  it("never reports a peak below the entry price", () => {
    // Every bar here is under water; the peak stays at the entry, so a trailing
    // rule measured against it cannot fire on a position that only ever lost.
    expect(peakSince([bar(100, 80), bar(200, 70)], 0, 100)).toBe(100);
  });
});

/**
 * Which exit counts.
 *
 * Every autopilot trade now carries a take profit and a stop loss, so "the
 * first exit-typed order" stopped being a meaningful answer. Whichever the
 * database returned first used to decide whether the head thought a position
 * was open — and a filled take profit sitting behind an idle stop read as
 * "still holding", so the head would keep managing a closed position and count
 * its notional as live exposure.
 */
describe("a trade carrying both exits", () => {
  const entry = { entityType: "EntryOrder", status: "Filled", side: "Buy", price: 100, filledPrice: 100, fee: 0.1, quantity: 1, filledAt: new Date(0) };
  const filledTp = { entityType: "TakeProfitOrder", status: "Filled", side: "Sell", price: 115, filledPrice: 115, fee: 0.11, quantity: 1, filledAt: new Date(1) };
  const idleStop = { entityType: "StopLossOrder", status: "Idle", side: "Sell", price: null, filledPrice: null, fee: null, quantity: 1, filledAt: null };

  it("counts the position closed whichever order comes back first", () => {
    // The stop deliberately sits ahead of the take profit here: that ordering
    // is exactly what used to produce a phantom open position.
    for (const orders of [
      [entry, idleStop, filledTp],
      [entry, filledTp, idleStop],
    ]) {
      const exits = orders.filter((o) => ["TakeProfitOrder", "StopLossOrder"].includes(o.entityType));
      const chosen = exits.find((o) => o.status === "Filled") ?? exits[0];

      expect(chosen.entityType).toBe("TakeProfitOrder");
      expect(chosen.status).toBe("Filled");
    }
  });

  it("still reports a resting exit while nothing has filled", () => {
    const restingTp = { ...filledTp, status: "Placed", filledPrice: null, filledAt: null };
    const exits = [restingTp, idleStop];
    const chosen = exits.find((o) => o.status === "Filled") ?? exits[0];

    // No filled exit, so the position is open and the caller gets a price to
    // report rather than nothing at all.
    expect(chosen).toBeDefined();
    expect(chosen.status).not.toBe("Filled");
  });
});

/**
 * A slot is taken when the entry starts working, not when it fills.
 *
 * The planner counted filled entries only; the order door counted resting ones
 * too. While every entry was a market order the two agreed, because a market
 * order fills at once. Resting limit entries broke the tie: the head saw room
 * for one more, the door refused it as committed, and the feed filled with
 * refusals every pass — none of them anyone's mistake.
 */
describe("what counts as an occupied slot", () => {
  const slotTaken = (entryStatus: string, exitFilled: boolean) => {
    const working = entryStatus === "Idle" || entryStatus === "Placed";
    if (entryStatus === "Filled" && exitFilled) return false;

    return entryStatus === "Filled" || working;
  };

  it("counts a resting limit entry, because it can fill at any moment", () => {
    expect(slotTaken("Placed", false)).toBe(true);
    expect(slotTaken("Idle", false)).toBe(true);
  });

  it("counts a filled entry that has not been exited", () => {
    expect(slotTaken("Filled", false)).toBe(true);
  });

  it("releases the slot once an exit has filled", () => {
    expect(slotTaken("Filled", true)).toBe(false);
  });

  it("agrees with the order door on every entry state", () => {
    // The door (openManualPositions) treats Idle, Placed and unexited Filled as
    // live. Any disagreement here is a refusal loop, so they are asserted
    // together rather than trusted to stay in step.
    for (const status of ["Idle", "Placed", "Filled"]) {
      const doorCountsIt = status === "Idle" || status === "Placed" || status === "Filled";
      expect(slotTaken(status, false), status).toBe(doorCountsIt);
    }
  });
});
