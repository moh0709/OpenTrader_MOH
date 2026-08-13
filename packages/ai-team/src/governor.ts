import type { CouncilVerdict, PortfolioState, RiskLimits, TradeDecision } from "./types.js";

/**
 * The deterministic risk governor.
 *
 * This is the enforcement layer, and it is the reason an LLM is safe to have in
 * the loop at all. It runs *after* the council votes and obeys one invariant:
 *
 *   The governor can only ever reduce or refuse. Nothing a council member
 *   returns — however confident, however well argued — can raise a limit,
 *   enlarge a position, or lift a halt.
 *
 * Every clamp is recorded in `riskNotes` so a decision can be audited after the
 * fact without re-running it.
 */
export function applyRiskGovernor(
  verdict: CouncilVerdict,
  limits: RiskLimits,
  state: PortfolioState,
): TradeDecision {
  const riskNotes: string[] = [];
  const hasExposure = state.openExposureQuote > 0;

  const refuse = (reason: string, breach = false): TradeDecision => {
    riskNotes.push(reason);

    // Only ask for a liquidation when there is something to liquidate, so a
    // flat bot sitting behind a tripped limit does not emit exit orders forever.
    const liquidate = breach && limits.liquidateOnBreach && hasExposure;
    if (liquidate) riskNotes.push("liquidating open position");

    return {
      signal: "hold",
      sizeQuote: 0,
      confidence: verdict.confidence,
      riskNotes,
      approved: false,
      liquidate,
      liquidateReason: liquidate ? reason : undefined,
      verdict,
    };
  };

  // Ordered from the most absolute halt outward, so the recorded reason is the
  // most fundamental one rather than whichever check happened to run first.
  //
  // The kill switch is a pause, not a panic: it blocks new trades but does not
  // force an exit. The loss limits are the opposite — they exist to stop losing
  // money, which means getting out of what is already losing.
  if (limits.killSwitch) return refuse("kill switch engaged");

  if (state.realizedPnlToday <= -limits.maxDailyLossQuote) {
    return refuse(`daily loss limit reached (${state.realizedPnlToday.toFixed(2)} vs -${limits.maxDailyLossQuote})`, true);
  }

  if (state.consecutiveLosses >= limits.maxConsecutiveLosses) {
    return refuse(`consecutive loss limit reached (${state.consecutiveLosses}/${limits.maxConsecutiveLosses})`, true);
  }

  if (verdict.vetoed) return refuse(`risk analyst veto: ${verdict.vetoReason}`);

  if (verdict.signal === "hold") return refuse("council reached no directional consensus");

  if (verdict.confidence < limits.minConfidence) {
    return refuse(`confidence ${verdict.confidence.toFixed(3)} below the ${limits.minConfidence} floor`);
  }

  // Treat an existing position as "this idea is already expressed". The sell
  // side stays open so the council can always close what it opened.
  const positionEpsilon = limits.maxPositionQuote * 1e-6;
  if (verdict.signal === "buy" && !limits.allowPyramiding && state.openExposureQuote > positionEpsilon) {
    return refuse(`already long ${state.openExposureQuote.toFixed(2)}; pyramiding disabled`);
  }

  // Conviction scales size, but only downward from the cap — full confidence
  // buys exactly the maximum position and never more.
  let sizeQuote = limits.maxPositionQuote * verdict.confidence;

  if (sizeQuote > limits.maxPositionQuote) {
    sizeQuote = limits.maxPositionQuote;
    riskNotes.push(`clamped to per-position cap ${limits.maxPositionQuote}`);
  }

  const headroom = limits.maxTotalExposureQuote - state.openExposureQuote;
  if (headroom <= 0) return refuse(`no exposure headroom (${state.openExposureQuote}/${limits.maxTotalExposureQuote})`);

  if (sizeQuote > headroom) {
    riskNotes.push(`reduced from ${sizeQuote.toFixed(2)} to remaining exposure headroom ${headroom.toFixed(2)}`);
    sizeQuote = headroom;
  }

  // Never stake more than the account actually holds, whatever the caps say.
  if (sizeQuote > state.equityQuote) {
    riskNotes.push(`reduced from ${sizeQuote.toFixed(2)} to available equity ${state.equityQuote.toFixed(2)}`);
    sizeQuote = state.equityQuote;
  }

  if (sizeQuote <= 0) return refuse("position size resolved to zero after limits");

  return {
    signal: verdict.signal,
    sizeQuote,
    confidence: verdict.confidence,
    riskNotes,
    approved: true,
    liquidate: false,
    verdict,
  };
}

/**
 * One-line audit record for a decision. Written on every tick, including the
 * no-trade ones — a log that only records trades hides the reasoning that
 * mattered most.
 */
export function describeDecision(decision: TradeDecision, symbol: string): string {
  const head = decision.approved
    ? `${decision.signal.toUpperCase()} ${symbol} size=${decision.sizeQuote.toFixed(2)} conf=${decision.confidence.toFixed(3)}`
    : decision.liquidate
      ? `LIQUIDATE ${symbol} — ${decision.liquidateReason}`
      : `NO-TRADE ${symbol} conf=${decision.confidence.toFixed(3)}`;

  const notes = decision.riskNotes.length > 0 ? ` | risk: ${decision.riskNotes.join("; ")}` : "";
  return `${head} | ${decision.verdict.rationale}${notes}`;
}
