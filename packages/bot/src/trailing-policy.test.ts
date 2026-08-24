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
