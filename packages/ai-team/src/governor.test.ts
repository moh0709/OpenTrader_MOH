import { describe, expect, it } from "vitest";
import { applyRiskGovernor } from "./governor.js";
import { DEFAULT_RISK_LIMITS, type CouncilVerdict, type PortfolioState, type RiskLimits, type Signal } from "./types.js";

const limits: RiskLimits = { ...DEFAULT_RISK_LIMITS };

const healthy: PortfolioState = {
  openExposureQuote: 0,
  realizedPnlToday: 0,
  consecutiveLosses: 0,
  equityQuote: 10_000,
};

function verdict(signal: Signal, confidence: number, overrides: Partial<CouncilVerdict> = {}): CouncilVerdict {
  return {
    signal,
    confidence,
    opinions: [],
    rationale: "test",
    vetoed: false,
    ...overrides,
  };
}

describe("applyRiskGovernor", () => {
  it("approves a confident signal and sizes it by conviction", () => {
    const decision = applyRiskGovernor(verdict("buy", 0.8), limits, healthy);

    expect(decision.approved).toBe(true);
    expect(decision.signal).toBe("buy");
    // 0.8 conviction against a 100 cap
    expect(decision.sizeQuote).toBeCloseTo(80, 6);
  });

  // The core safety property: the governor is the only thing that decides size,
  // and no council output can talk it past a limit.
  it("never exceeds the per-position cap, even for an out-of-range confidence", () => {
    const rogue = verdict("buy", 99);

    const decision = applyRiskGovernor(rogue, limits, healthy);

    expect(decision.sizeQuote).toBeLessThanOrEqual(limits.maxPositionQuote);
    expect(decision.riskNotes.join(" ")).toContain("clamped to per-position cap");
  });

  it("refuses everything while the kill switch is engaged", () => {
    const decision = applyRiskGovernor(verdict("buy", 1), { ...limits, killSwitch: true }, healthy);

    expect(decision.approved).toBe(false);
    expect(decision.sizeQuote).toBe(0);
    expect(decision.signal).toBe("hold");
    expect(decision.riskNotes).toContain("kill switch engaged");
  });

  it("honours a risk-analyst veto", () => {
    const decision = applyRiskGovernor(verdict("buy", 1, { vetoed: true, vetoReason: "volatility spike" }), limits, healthy);

    expect(decision.approved).toBe(false);
    expect(decision.riskNotes.join(" ")).toContain("volatility spike");
  });

  it("halts once the daily loss limit is reached", () => {
    const decision = applyRiskGovernor(verdict("buy", 1), limits, { ...healthy, realizedPnlToday: -limits.maxDailyLossQuote });

    expect(decision.approved).toBe(false);
    expect(decision.riskNotes.join(" ")).toContain("daily loss limit");
  });

  it("halts after too many consecutive losses", () => {
    const decision = applyRiskGovernor(verdict("buy", 1), limits, { ...healthy, consecutiveLosses: limits.maxConsecutiveLosses });

    expect(decision.approved).toBe(false);
    expect(decision.riskNotes.join(" ")).toContain("consecutive loss limit");
  });

  describe("liquidation on a tripped loss limit", () => {
    const positioned: PortfolioState = { ...healthy, openExposureQuote: 80 };

    it("demands an exit when the daily loss limit trips while holding a position", () => {
      const decision = applyRiskGovernor(verdict("buy", 1), limits, {
        ...positioned,
        realizedPnlToday: -limits.maxDailyLossQuote,
      });

      expect(decision.approved).toBe(false);
      expect(decision.liquidate).toBe(true);
      expect(decision.liquidateReason).toContain("daily loss limit");
    });

    it("demands an exit after too many consecutive losses", () => {
      const decision = applyRiskGovernor(verdict("buy", 1), limits, {
        ...positioned,
        consecutiveLosses: limits.maxConsecutiveLosses,
      });

      expect(decision.liquidate).toBe(true);
      expect(decision.liquidateReason).toContain("consecutive loss limit");
    });

    // Nothing to sell means no exit order, however bad the risk state is.
    it("does not demand an exit when the bot is already flat", () => {
      const decision = applyRiskGovernor(verdict("buy", 1), limits, {
        ...healthy,
        openExposureQuote: 0,
        realizedPnlToday: -limits.maxDailyLossQuote,
      });

      expect(decision.approved).toBe(false);
      expect(decision.liquidate).toBe(false);
      expect(decision.liquidateReason).toBeUndefined();
    });

    // The kill switch is a pause. Forcing an operator out of the market because
    // they wanted the bot to stop thinking would be its own kind of disaster.
    it("treats the kill switch as a pause, not a liquidation", () => {
      const decision = applyRiskGovernor(verdict("buy", 1), { ...limits, killSwitch: true }, positioned);

      expect(decision.approved).toBe(false);
      expect(decision.liquidate).toBe(false);
    });

    it("can be turned off, leaving the limit as a block-only rule", () => {
      const decision = applyRiskGovernor(verdict("buy", 1), { ...limits, liquidateOnBreach: false }, {
        ...positioned,
        realizedPnlToday: -limits.maxDailyLossQuote,
      });

      expect(decision.approved).toBe(false);
      expect(decision.liquidate).toBe(false);
    });

    it("never asks to liquidate on an ordinary no-trade tick", () => {
      const routine = [
        applyRiskGovernor(verdict("hold", 0.9), limits, positioned),
        applyRiskGovernor(verdict("buy", 0.1), limits, positioned),
        applyRiskGovernor(verdict("buy", 1), limits, positioned), // blocked by pyramiding
      ];

      for (const decision of routine) {
        expect(decision.liquidate).toBe(false);
      }
    });

    it("never asks to liquidate on an approved trade", () => {
      const decision = applyRiskGovernor(verdict("buy", 0.8), limits, healthy);

      expect(decision.approved).toBe(true);
      expect(decision.liquidate).toBe(false);
    });
  });

  it("refuses a signal below the confidence floor", () => {
    const decision = applyRiskGovernor(verdict("buy", limits.minConfidence - 0.01), limits, healthy);

    expect(decision.approved).toBe(false);
    expect(decision.riskNotes.join(" ")).toContain("below the");
  });

  it("refuses when the council reached no consensus", () => {
    const decision = applyRiskGovernor(verdict("hold", 0.9), limits, healthy);

    expect(decision.approved).toBe(false);
    expect(decision.riskNotes).toContain("council reached no directional consensus");
  });

  it("refuses to add to a position that is already open", () => {
    const decision = applyRiskGovernor(verdict("buy", 1), limits, { ...healthy, openExposureQuote: 40 });

    expect(decision.approved).toBe(false);
    expect(decision.riskNotes.join(" ")).toContain("pyramiding disabled");
  });

  it("still allows closing an open position", () => {
    const decision = applyRiskGovernor(verdict("sell", 1), limits, { ...healthy, openExposureQuote: 40 });

    expect(decision.approved).toBe(true);
    expect(decision.signal).toBe("sell");
  });

  it("allows adding to a position when pyramiding is explicitly enabled", () => {
    const decision = applyRiskGovernor(verdict("buy", 1), { ...limits, allowPyramiding: true }, { ...healthy, openExposureQuote: 40 });

    expect(decision.approved).toBe(true);
  });

  it("reduces the position to the remaining exposure headroom", () => {
    // 470 of the 500 cap is already committed, so only 30 is available.
    // Pyramiding is enabled here so the headroom clamp is what gets exercised.
    const scaling = { ...limits, allowPyramiding: true };
    const decision = applyRiskGovernor(verdict("buy", 1), scaling, { ...healthy, openExposureQuote: 470 });

    expect(decision.approved).toBe(true);
    expect(decision.sizeQuote).toBeCloseTo(30, 6);
    expect(decision.riskNotes.join(" ")).toContain("remaining exposure headroom");
  });

  it("refuses when exposure is already at the cap", () => {
    const scaling = { ...limits, allowPyramiding: true };
    const decision = applyRiskGovernor(verdict("buy", 1), scaling, { ...healthy, openExposureQuote: limits.maxTotalExposureQuote });

    expect(decision.approved).toBe(false);
    expect(decision.riskNotes.join(" ")).toContain("no exposure headroom");
  });

  it("never stakes more than the account actually holds", () => {
    const decision = applyRiskGovernor(verdict("buy", 1), limits, { ...healthy, equityQuote: 25 });

    expect(decision.sizeQuote).toBeCloseTo(25, 6);
    expect(decision.riskNotes.join(" ")).toContain("available equity");
  });

  it("keeps sell signals under the same caps as buys", () => {
    const decision = applyRiskGovernor(verdict("sell", 99), limits, healthy);

    expect(decision.signal).toBe("sell");
    expect(decision.sizeQuote).toBeLessThanOrEqual(limits.maxPositionQuote);
  });

  // Property check across the whole confidence range and a spread of portfolio
  // states: no combination of inputs may breach a cap.
  it("holds every limit across the full input range", () => {
    const states: PortfolioState[] = [
      healthy,
      { ...healthy, openExposureQuote: 250 },
      { ...healthy, openExposureQuote: 499 },
      { ...healthy, equityQuote: 10 },
    ];

    // Pyramiding enabled so the sizing and clamping paths are actually reached
    // for buys against a non-zero existing position.
    const scaling = { ...limits, allowPyramiding: true };

    for (const state of states) {
      for (let confidence = 0; confidence <= 2; confidence += 0.05) {
        for (const signal of ["buy", "sell"] as Signal[]) {
          const decision = applyRiskGovernor(verdict(signal, confidence), scaling, state);

          expect(decision.sizeQuote).toBeLessThanOrEqual(limits.maxPositionQuote);
          expect(decision.sizeQuote).toBeLessThanOrEqual(limits.maxTotalExposureQuote - state.openExposureQuote);
          expect(decision.sizeQuote).toBeLessThanOrEqual(state.equityQuote);
          expect(decision.sizeQuote).toBeGreaterThanOrEqual(0);
          if (!decision.approved) expect(decision.sizeQuote).toBe(0);
        }
      }
    }
  });
});
