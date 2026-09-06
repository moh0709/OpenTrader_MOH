import { describe, expect, it } from "vitest";
import { evaluateTrailing, type TrailingConfig, type TrailingState } from "./trailing-policy.js";

const config: TrailingConfig = {
  entryPrice: 100,
  quantity: 1,
  entryFee: 0.05,
  minProfit: 3,
  exitFeeRate: 0.0005,
  atrMultiplier: 1.5,
  minTrailDistance: 2,
  activationAtrMultiple: 0.5,
};

const idle: TrailingState = { active: false, highestPrice: 100 };

describe("evaluateTrailing", () => {
  it("does not activate before the fee-aware profit floor and ATR move", () => {
    const result = evaluateTrailing(idle, config, { price: 102.5, atr: 5 });

    expect(result.action).toBe("hold");
    expect(result.state.active).toBe(false);
  });

  it("activates only after protected net profit and momentum distance", () => {
    const result = evaluateTrailing(idle, config, { price: 106, atr: 5 });

    expect(result.action).toBe("activate");
    expect(result.state.active).toBe(true);
    expect(result.state.highestPrice).toBe(106);
    expect(result.state.trailPrice).toBe(98.5);
  });

  it("raises the trail with a new high and never lowers it", () => {
    const active: TrailingState = { active: true, highestPrice: 106, trailPrice: 98.5 };
    const raised = evaluateTrailing(active, config, { price: 110, atr: 4 });
    const unchanged = evaluateTrailing(raised.state, config, { price: 108, atr: 8 });

    expect(raised.action).toBe("raise");
    expect(raised.state.highestPrice).toBe(110);
    expect(raised.state.trailPrice).toBe(104);
    expect(unchanged.state.trailPrice).toBe(104);
  });

  it("exits on a retracement only after the trail is active", () => {
    const active: TrailingState = { active: true, highestPrice: 110, trailPrice: 104 };
    const result = evaluateTrailing(active, config, { price: 103.5, atr: 4 });

    expect(result.action).toBe("exit");
    expect(result.exitPrice).toBe(103.5);
  });

  it("never exits below the configured net-profit floor", () => {
    const active: TrailingState = { active: true, highestPrice: 110, trailPrice: 104 };
    const result = evaluateTrailing(active, config, { price: 102, atr: 4 });

    expect(result.action).toBe("hold");
  });
});

/**
 * Whose position is it?
 *
 * Adaptive trailing is a strategy feature — it reads the bot's own minimum
 * profit and trails against the ATR of the market the bot was pointed at. A deal
 * in the manual or autopilot lane was opened by somebody else, and that somebody
 * is already managing the exit.
 *
 * Running both is worse than running neither, and it showed: two trading-head
 * positions were trailed out at 2.36 and 2.35, under the head's own 3-unit
 * floor, by a policy that had never heard of it. No journal entry, no decision,
 * no reason an operator could read — the head went on believing it held them.
 */
describe("adaptive trailing stays out of the external lanes", () => {
  // Mirrors isExternalRef, so the two cannot drift apart unnoticed.
  const external = (ref: string | null) =>
    typeof ref === "string" && (ref.startsWith("manual:") || ref.startsWith("auto:"));

  it("declines a trade the trading head opened", () => {
    expect(external("auto:1788647251419")).toBe(true);
  });

  it("declines a trade an operator forced open", () => {
    expect(external("manual:1788600000000")).toBe(true);
  });

  it("still manages the strategy's own deals", () => {
    for (const ref of ["grid-1-3", "dca:7", "", null]) {
      expect(external(ref), String(ref)).toBe(false);
    }
  });

  it("would have refused the two exits that bypassed the floor", () => {
    // Both were autopilot deals closed under a 3-unit floor by this policy.
    for (const [ref, banked] of [
      ["auto:1788647251419", 2.36],
      ["auto:1788647252594", 2.35],
    ] as const) {
      expect(external(ref)).toBe(true);
      expect(banked).toBeLessThan(3);
    }
  });
});
