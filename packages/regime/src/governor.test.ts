import { describe, expect, it } from "vitest";
import { applyRegimeGovernor, describeRegimeDecision } from "./governor.js";
import {
  DEFAULT_FLOOR_FACTOR,
  DEFAULT_MAX_AGE_MS,
  REGIME_FLOOR_QUOTE,
  STANCES,
  type Conviction,
  type RegimePolicy,
  type Stance,
} from "./types.js";

const NOW = 1_760_000_000_000;

const policy = (over: Partial<RegimePolicy> = {}): RegimePolicy => ({
  botId: 14,
  baselineMaxCapital: 1000,
  baselineMinProfit: 3,
  armed: true,
  floorFactor: DEFAULT_FLOOR_FACTOR,
  maxAgeMs: DEFAULT_MAX_AGE_MS,
  ...over,
});

const conviction = (over: Partial<Conviction> = {}): Conviction => ({
  symbol: "BTC/USDT",
  stance: "sell",
  confidence: 1,
  asOf: NOW,
  summary: "test",
  ...over,
});

/** The sweep every safety property is asserted over. */
const CONFIDENCES = [0, 0.01, 0.13, 0.25, 0.5, 0.55, 0.75, 0.9, 0.99, 1];
const BASELINES = [0.5, 1, 2, 9.99, 100, 1000, 25_000];

describe("the ceiling invariant", () => {
  it("never exceeds baseline, and never emits a cap that would remove the limit", () => {
    // This is the property the whole design rests on. `bot-limits.toLimit()`
    // treats <= 0 as "no cap", so an emitted zero would not throttle the bot —
    // it would uncap it. Both halves are asserted together because a violation
    // of either is the same category of failure: more risk, not less.
    for (const stance of STANCES) {
      for (const confidence of CONFIDENCES) {
        for (const baseline of BASELINES) {
          const decision = applyRegimeGovernor(
            policy({ baselineMaxCapital: baseline }),
            conviction({ stance, confidence }),
            NOW,
          );

          expect(decision.maxCapital, `${stance}/${confidence}/${baseline}`).not.toBeNull();
          const cap = decision.maxCapital as number;

          expect(cap, `${stance}@${confidence} on baseline ${baseline} exceeded its ceiling`).toBeLessThanOrEqual(
            baseline,
          );
          expect(cap, `${stance}@${confidence} on baseline ${baseline} emitted a cap-removing value`).toBeGreaterThan(
            0,
          );
          expect(decision.factor).toBeGreaterThan(0);
          expect(decision.factor).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("holds even when the baseline is smaller than the floor", () => {
    // The floor must never win over the ceiling. A 0.5 baseline is below
    // REGIME_FLOOR_QUOTE, so a naive Math.max would raise the cap above what
    // the operator set — turning a throttle into a loosening.
    const decision = applyRegimeGovernor(
      policy({ baselineMaxCapital: 0.5 }),
      conviction({ stance: "strong_sell", confidence: 1 }),
      NOW,
    );

    expect(decision.maxCapital).toBeLessThanOrEqual(0.5);
    expect(REGIME_FLOOR_QUOTE).toBeGreaterThan(0.5); // guards the premise of this test
  });
});

describe("bullish and neutral stances are no-ops", () => {
  it("resolves to exactly baseline, at every confidence", () => {
    // The governor is not allowed to express optimism, because expressing
    // optimism means raising a cap. A maximally bullish council gets the same
    // outcome as a silent one.
    for (const stance of ["strong_buy", "buy", "hold"] satisfies Stance[]) {
      for (const confidence of CONFIDENCES) {
        const decision = applyRegimeGovernor(policy(), conviction({ stance, confidence }), NOW);

        expect(decision.maxCapital, `${stance}@${confidence}`).toBe(1000);
        expect(decision.reduced).toBe(false);
        expect(decision.factor).toBe(1);
      }
    }
  });
});

describe("confidence scales depth, never direction", () => {
  it("does nothing at zero confidence, however bearish", () => {
    for (const stance of ["sell", "strong_sell"] satisfies Stance[]) {
      const decision = applyRegimeGovernor(policy(), conviction({ stance, confidence: 0 }), NOW);

      expect(decision.maxCapital).toBe(1000);
      expect(decision.reduced).toBe(false);
    }
  });

  it("reduces monotonically as confidence rises", () => {
    let previous = Number.POSITIVE_INFINITY;

    for (const confidence of CONFIDENCES) {
      const decision = applyRegimeGovernor(policy(), conviction({ stance: "sell", confidence }), NOW);
      const cap = decision.maxCapital as number;

      expect(cap).toBeLessThanOrEqual(previous);
      previous = cap;
    }
  });

  it("cuts harder for strong_sell than for sell at equal confidence", () => {
    const soft = applyRegimeGovernor(policy(), conviction({ stance: "sell", confidence: 0.8 }), NOW);
    const hard = applyRegimeGovernor(policy(), conviction({ stance: "strong_sell", confidence: 0.8 }), NOW);

    expect(hard.maxCapital as number).toBeLessThan(soft.maxCapital as number);
  });

  it("halves capital on a fully confident sell", () => {
    const decision = applyRegimeGovernor(policy(), conviction({ stance: "sell", confidence: 1 }), NOW);

    expect(decision.maxCapital).toBe(500);
    expect(decision.reduced).toBe(true);
  });
});

describe("every degraded path falls back to baseline", () => {
  // Collectively these are the fail-safe proof: if anything about the research
  // side is missing, broken, or out of date, the fleet behaves exactly as it
  // did before this layer existed.

  it("passes through when disarmed, however bearish the council", () => {
    const decision = applyRegimeGovernor(
      policy({ armed: false }),
      conviction({ stance: "strong_sell", confidence: 1 }),
      NOW,
    );

    expect(decision.maxCapital).toBe(1000);
    expect(decision.reduced).toBe(false);
    expect(decision.notes.join(" ")).toContain("disarmed");
  });

  it("passes through when there is no conviction at all", () => {
    const decision = applyRegimeGovernor(policy(), null, NOW);

    expect(decision.maxCapital).toBe(1000);
    expect(decision.notes.join(" ")).toContain("no conviction");
  });

  it("passes through once the conviction is stale", () => {
    const stale = conviction({ stance: "strong_sell", confidence: 1, asOf: NOW - DEFAULT_MAX_AGE_MS - 1 });
    const decision = applyRegimeGovernor(policy(), stale, NOW);

    expect(decision.maxCapital).toBe(1000);
    expect(decision.notes.join(" ")).toContain("old");
  });

  it("still acts on a conviction that is old but inside the window", () => {
    const recent = conviction({ stance: "strong_sell", confidence: 1, asOf: NOW - DEFAULT_MAX_AGE_MS + 1000 });
    const decision = applyRegimeGovernor(policy(), recent, NOW);

    expect(decision.reduced).toBe(true);
  });

  it("refuses a conviction dated in the future", () => {
    const skewed = conviction({ stance: "strong_sell", confidence: 1, asOf: NOW + 60_000 });
    const decision = applyRegimeGovernor(policy(), skewed, NOW);

    expect(decision.maxCapital).toBe(1000);
    expect(decision.notes.join(" ")).toContain("future");
  });

  it("leaves an unmanaged bot uncapped rather than inventing a ceiling", () => {
    const decision = applyRegimeGovernor(
      policy({ baselineMaxCapital: null }),
      conviction({ stance: "strong_sell", confidence: 1 }),
      NOW,
    );

    expect(decision.maxCapital).toBeNull();
    expect(decision.reduced).toBe(false);
  });

  it("treats a nonsensical baseline as unmanaged", () => {
    for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = applyRegimeGovernor(
        policy({ baselineMaxCapital: bad }),
        conviction({ stance: "strong_sell", confidence: 1 }),
        NOW,
      );

      expect(decision.reduced, `baseline ${bad}`).toBe(false);
    }
  });

  it("ignores a stance it does not recognise", () => {
    const decision = applyRegimeGovernor(
      policy(),
      conviction({ stance: "moon" as Stance, confidence: 1 }),
      NOW,
    );

    expect(decision.maxCapital).toBe(1000);
    expect(decision.notes.join(" ")).toContain("unrecognised");
  });

  it("treats a non-finite confidence as no confidence", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 5]) {
      const decision = applyRegimeGovernor(
        policy(),
        conviction({ stance: "strong_sell", confidence: bad }),
        NOW,
      );

      const cap = decision.maxCapital as number;
      expect(cap, `confidence ${bad}`).toBeLessThanOrEqual(1000);
      expect(cap, `confidence ${bad}`).toBeGreaterThan(0);
    }
  });
});

describe("reductions do not compound across polls", () => {
  it("returns the same cap when the same conviction is applied repeatedly", () => {
    // The baseline is held in policy rather than read back from Bot.maxCapital
    // precisely so this holds. If the governor ever read its own output as the
    // next baseline, a standing bearish call would ratchet the bot to nothing
    // over a few hours of polling.
    const c = conviction({ stance: "sell", confidence: 0.8 });
    const first = applyRegimeGovernor(policy(), c, NOW);
    const second = applyRegimeGovernor(policy(), c, NOW + 300_000);
    const third = applyRegimeGovernor(policy(), c, NOW + 600_000);

    expect(second.maxCapital).toBe(first.maxCapital);
    expect(third.maxCapital).toBe(first.maxCapital);
  });

  it("returns straight to baseline when the council turns neutral", () => {
    const throttled = applyRegimeGovernor(policy(), conviction({ stance: "strong_sell" }), NOW);
    expect(throttled.reduced).toBe(true);

    const released = applyRegimeGovernor(policy(), conviction({ stance: "hold" }), NOW);
    expect(released.maxCapital).toBe(1000);
    expect(released.reduced).toBe(false);
  });
});

describe("audit trail", () => {
  it("records a reason on every decision, acted on or not", () => {
    const acted = applyRegimeGovernor(policy(), conviction({ stance: "sell" }), NOW);
    const skipped = applyRegimeGovernor(policy(), null, NOW);

    expect(acted.notes.length).toBeGreaterThan(0);
    expect(skipped.notes.length).toBeGreaterThan(0);
  });

  it("describes a throttle and a passthrough distinguishably", () => {
    const acted = describeRegimeDecision(applyRegimeGovernor(policy(), conviction({ stance: "sell" }), NOW), "OKX Gold");
    const skipped = describeRegimeDecision(applyRegimeGovernor(policy(), null, NOW), "OKX Gold");

    expect(acted).toContain("THROTTLE");
    expect(acted).toContain("OKX Gold");
    expect(skipped).toContain("BASELINE");
  });

  it("says so when the floor was what stopped it going lower", () => {
    const decision = applyRegimeGovernor(
      policy({ baselineMaxCapital: 5, floorFactor: 0.01 }),
      conviction({ stance: "strong_sell", confidence: 1 }),
      NOW,
    );

    expect(decision.notes.join(" ")).toContain("floor");
  });
});
