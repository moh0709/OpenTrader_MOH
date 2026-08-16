import {
  REGIME_FLOOR_QUOTE,
  STANCE_FACTOR,
  clampConfidence,
  type Conviction,
  type RegimeDecision,
  type RegimePolicy,
} from "./types.js";

/**
 * The deterministic regime governor.
 *
 * This is the enforcement layer between a research council and live money, and
 * it obeys the same invariant as `applyRiskGovernor` in `@opentrader/ai-team`:
 *
 *   The governor can only ever reduce or refuse. Nothing the council returns —
 *   however confident, however well argued — can raise a cap above the
 *   operator's baseline, enlarge a position, or lift a halt.
 *
 * That is what makes it safe to put an LLM research process in front of bots
 * that are trading real money. The worst a wrong conviction can do is leave
 * capital idle; it has no path to committing more of it.
 *
 * Three properties hold for every input, and are swept in the tests:
 *
 *   1. `0 < maxCapital <= baselineMaxCapital` whenever a baseline exists.
 *   2. Anything bullish or neutral resolves to exactly baseline — no-op.
 *   3. Every degraded path (disarmed, missing, stale) resolves to exactly
 *      baseline, so a dead research service leaves the fleet behaving as it
 *      did before this layer existed.
 */
export function applyRegimeGovernor(
  policy: RegimePolicy,
  conviction: Conviction | null,
  now: number,
): RegimeDecision {
  const notes: string[] = [];

  const baseline = policy.baselineMaxCapital;

  /** Every early exit lands here, so "unchanged" is one code path, not five. */
  const passthrough = (reason: string): RegimeDecision => {
    notes.push(reason);

    return { botId: policy.botId, maxCapital: baseline, factor: 1, reduced: false, notes };
  };

  // No ceiling means the bot is not under management. The governor could invent
  // one, and for a bearish call that would even reduce risk — but it would be
  // imposing a limit the operator never chose, on a bot they deliberately left
  // uncapped. Opting in stays an explicit act.
  if (baseline === null) return passthrough("no baseline cap set; bot is not under regime management");

  // A baseline that is not a usable number cannot be scaled from. Treated as
  // unmanaged rather than guessed at.
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return passthrough(`baseline ${baseline} is not a usable cap; leaving untouched`);
  }

  if (!policy.armed) return passthrough("regime governor disarmed");

  // A council that has not reported is not a council that said "hold" — it is
  // no information at all, and no information must never move money.
  if (!conviction) return passthrough("no conviction available");

  const ageMs = now - conviction.asOf;
  if (ageMs > policy.maxAgeMs) {
    const hours = (ageMs / 3_600_000).toFixed(1);

    return passthrough(`conviction is ${hours}h old, past the ${(policy.maxAgeMs / 3_600_000).toFixed(0)}h limit`);
  }

  // A conviction dated in the future means a clock disagreement somewhere. Act
  // on the reading and it could outlive its staleness guard by that margin, so
  // it is refused rather than trusted.
  if (ageMs < 0) return passthrough("conviction is dated in the future; ignoring");

  const stanceFactor = STANCE_FACTOR[conviction.stance];
  if (stanceFactor === undefined) return passthrough(`unrecognised stance "${conviction.stance}"`);

  const confidence = clampConfidence(conviction.confidence);

  // Confidence scales the *depth* of the pullback, never its direction.
  //
  //   factor = 1 - (1 - stanceFactor) * confidence
  //
  // At zero confidence this is exactly 1 — an unsure council changes nothing.
  // At full confidence it is the stance factor. Because `stanceFactor <= 1` and
  // `confidence` is clamped to 0..1, the result can never exceed 1, which is
  // the arithmetic reason the ceiling can never be breached.
  const rawFactor = 1 - (1 - stanceFactor) * confidence;
  const factor = Math.min(1, Math.max(policy.floorFactor, rawFactor));

  if (factor >= 1) {
    return passthrough(
      `${conviction.stance} @ ${confidence.toFixed(2)} confidence — no reduction warranted`,
    );
  }

  const scaled = baseline * factor;

  // Order matters here. Flooring first and clamping to baseline second means a
  // baseline smaller than the floor stays at baseline instead of being raised
  // to meet it — the ceiling wins over the floor, always.
  const floored = Math.max(REGIME_FLOOR_QUOTE, scaled);
  const maxCapital = Math.min(baseline, floored);

  notes.push(
    `${conviction.stance} @ ${confidence.toFixed(2)} confidence — capital reduced to ${(factor * 100).toFixed(0)}% of baseline`,
  );
  notes.push(`cap ${baseline.toFixed(2)} → ${maxCapital.toFixed(2)}`);

  if (floored > scaled) {
    notes.push(`held at the ${REGIME_FLOOR_QUOTE} floor; writing zero would remove the cap entirely`);
  }

  if (maxCapital >= baseline) {
    notes.push("reduction rounded back up to baseline; no effective change");

    return { botId: policy.botId, maxCapital, factor: 1, reduced: false, notes };
  }

  return { botId: policy.botId, maxCapital, factor, reduced: true, notes };
}

/** One-line audit record, written on every change including the no-ops. */
export function describeRegimeDecision(decision: RegimeDecision, botName: string): string {
  const cap = decision.maxCapital === null ? "uncapped" : decision.maxCapital.toFixed(2);
  const head = decision.reduced
    ? `THROTTLE ${botName} cap=${cap} (${(decision.factor * 100).toFixed(0)}% of baseline)`
    : `BASELINE ${botName} cap=${cap}`;

  return `${head} — ${decision.notes.join("; ")}`;
}
