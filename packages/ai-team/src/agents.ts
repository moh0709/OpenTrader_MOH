import { atrPercent, closes, rsi, slopePercent, sma } from "./indicators.js";
import { clampConfidence, type AgentOpinion, type MarketSnapshot, type PortfolioState, type Regime, type RiskLimits } from "./types.js";

/**
 * The deterministic half of the AI Team.
 *
 * Every agent here runs offline with no API dependency. When the LLM layer is
 * unavailable — no key, timeout, rate limit, refusal — these still produce a
 * complete council, so the system degrades in quality rather than stopping.
 */

/** An agent that had nothing to work with — excluded from the vote entirely. */
const UNAVAILABLE = (agent: string, rationale: string): AgentOpinion => ({
  agent,
  signal: "hold",
  confidence: 0,
  rationale,
  source: "deterministic",
  available: false,
});

/**
 * Trend and regime. Reads the relationship between a fast and slow moving
 * average, confirmed by the slope of recent closes.
 */
export function marketAnalyst(snapshot: MarketSnapshot, fastPeriod = 10, slowPeriod = 30): AgentOpinion {
  const price = closes(snapshot.candles);
  const fast = sma(price, fastPeriod);
  const slow = sma(price, slowPeriod);
  const slope = slopePercent(price, Math.min(fastPeriod, price.length));

  if (fast === null || slow === null || slow <= 0) {
    return UNAVAILABLE("market-analyst", `Need ${slowPeriod} candles, have ${price.length}`);
  }

  // Separation between the averages, as a percentage of the slow average.
  const separationPct = ((fast - slow) / slow) * 100;

  // Measure that separation in units of the market's own typical bar range
  // rather than in absolute percent. A 0.3% gap is a strong trend on a quiet
  // market and pure noise on a volatile one; an absolute threshold gets this
  // wrong on every asset it was not tuned for. One ATR of separation is treated
  // as full conviction.
  const volatility = Math.max(atrPercent(snapshot.candles) ?? 1, 0.05);
  const normalized = separationPct / volatility;

  const regime: Regime = Math.abs(normalized) < 0.25 ? "ranging" : normalized > 0 ? "trending_up" : "trending_down";

  const strength = clampConfidence(Math.abs(normalized));
  const slopeAgrees = slope !== null && Math.sign(slope) === Math.sign(separationPct);
  const confidence = clampConfidence(slopeAgrees ? strength : strength * 0.5);

  if (regime === "ranging") {
    return {
      agent: "market-analyst",
      signal: "hold",
      confidence: 0,
      rationale: `Ranging: fast/slow separation ${separationPct.toFixed(3)}% is inside the noise band`,
      source: "deterministic",
      evidence: { fast, slow, separationPct, slope, regime },
    };
  }

  return {
    agent: "market-analyst",
    signal: regime === "trending_up" ? "buy" : "sell",
    confidence,
    rationale:
      `${regime} — SMA${fastPeriod} is ${separationPct > 0 ? "above" : "below"} SMA${slowPeriod} ` +
      `by ${Math.abs(separationPct).toFixed(3)}% (${Math.abs(normalized).toFixed(2)} ATR), ` +
      `slope ${slopeAgrees ? "confirms" : "diverges"}`,
    source: "deterministic",
    evidence: { fast, slow, separationPct, normalized, volatility, slope, regime },
  };
}

/**
 * Mean reversion on RSI. Deliberately opposes the trend follower at extremes;
 * disagreement between the two is signal, not noise.
 */
export function quantAnalyst(snapshot: MarketSnapshot, period = 14, low = 30, high = 70): AgentOpinion {
  const value = rsi(closes(snapshot.candles), period);

  if (value === null) {
    return UNAVAILABLE("quant-analyst", `Need ${period + 1} candles to warm RSI, have ${snapshot.candles.length}`);
  }

  // Confidence ramps from zero at the threshold to full at the extreme.
  if (value < low) {
    return {
      agent: "quant-analyst",
      signal: "buy",
      confidence: clampConfidence((low - value) / low),
      rationale: `RSI ${value.toFixed(1)} is oversold (below ${low})`,
      source: "deterministic",
      evidence: { rsi: value, low, high },
    };
  }

  if (value > high) {
    return {
      agent: "quant-analyst",
      signal: "sell",
      confidence: clampConfidence((value - high) / (100 - high)),
      rationale: `RSI ${value.toFixed(1)} is overbought (above ${high})`,
      source: "deterministic",
      evidence: { rsi: value, low, high },
    };
  }

  return {
    agent: "quant-analyst",
    signal: "hold",
    confidence: 0,
    rationale: `RSI ${value.toFixed(1)} is neutral`,
    source: "deterministic",
    evidence: { rsi: value, low, high },
  };
}

/**
 * Reads the cross-venue scanner. Only speaks when the arbitrage engine found a
 * fully-costed, executable edge — a rejected opportunity is silence, not a
 * weak buy.
 */
export function arbitrageScout(snapshot: MarketSnapshot, targetSpreadBps = 25): AgentOpinion {
  const arb = snapshot.arb;

  if (!arb) {
    return UNAVAILABLE("arbitrage-scout", "No cross-venue scan available this tick");
  }

  if (!arb.executable) {
    // Marked unavailable rather than abstaining, on purpose. The scout answers
    // "is there a risk-free cross-venue edge?", which is a different question
    // from "which way is this market going?". Letting a silent scout count as a
    // dissenting directional voice would penalise every trend and mean-reversion
    // verdict for the unrelated fact that no arbitrage existed. The rejection
    // reasons are still carried here for the audit log.
    return {
      agent: "arbitrage-scout",
      signal: "hold",
      confidence: 0,
      rationale: `Best pair ${arb.buyVenue}->${arb.sellVenue} rejected: ${arb.rejections.join(", ") || "no edge"}`,
      source: "deterministic",
      available: false,
      evidence: { netSpreadBps: arb.netSpreadBps, topOfBookSpreadBps: arb.topOfBookSpreadBps, rejections: arb.rejections },
    };
  }

  return {
    agent: "arbitrage-scout",
    signal: "buy",
    confidence: clampConfidence(arb.netSpreadBps / targetSpreadBps),
    rationale:
      `Executable ${arb.netSpreadBps.toFixed(2)}bps net buying ${arb.buyVenue} and selling ${arb.sellVenue} ` +
      `(top-of-book showed ${arb.topOfBookSpreadBps.toFixed(2)}bps)`,
    source: "deterministic",
    evidence: {
      netSpreadBps: arb.netSpreadBps,
      topOfBookSpreadBps: arb.topOfBookSpreadBps,
      netProfitQuote: arb.netProfitQuote,
      buyVenue: arb.buyVenue,
      sellVenue: arb.sellVenue,
    },
  };
}

export type RiskObjection = {
  opinion: AgentOpinion;
  veto: boolean;
  reason?: string;
};

/**
 * The risk analyst's seat at the table. This is advisory — it argues during
 * deliberation and can veto a trade outright, but it is not the enforcement
 * layer. Hard limits live in the governor, which runs after the vote and
 * cannot be talked out of anything.
 */
export function riskAnalyst(snapshot: MarketSnapshot, limits: RiskLimits, state: PortfolioState, maxAtrPercent = 5): RiskObjection {
  const reasons: string[] = [];

  if (limits.killSwitch) reasons.push("kill switch engaged");
  if (state.realizedPnlToday <= -limits.maxDailyLossQuote) {
    reasons.push(`daily loss ${state.realizedPnlToday.toFixed(2)} reached the ${limits.maxDailyLossQuote} limit`);
  }
  if (state.consecutiveLosses >= limits.maxConsecutiveLosses) {
    reasons.push(`${state.consecutiveLosses} consecutive losses`);
  }
  if (state.openExposureQuote >= limits.maxTotalExposureQuote) {
    reasons.push(`exposure ${state.openExposureQuote.toFixed(2)} is at the ${limits.maxTotalExposureQuote} cap`);
  }

  const volatility = atrPercent(snapshot.candles);
  if (volatility !== null && volatility > maxAtrPercent) {
    reasons.push(`volatility ${volatility.toFixed(2)}% ATR exceeds the ${maxAtrPercent}% ceiling`);
  }

  const veto = reasons.length > 0;
  const reason = veto ? reasons.join("; ") : undefined;

  return {
    veto,
    reason,
    opinion: {
      agent: "risk-analyst",
      signal: "hold",
      confidence: veto ? 1 : 0,
      rationale: veto ? `Blocking: ${reason}` : `Clear — volatility ${volatility?.toFixed(2) ?? "n/a"}% ATR, exposure ${state.openExposureQuote.toFixed(2)}`,
      source: "deterministic",
      evidence: { volatility, reasons, state },
    },
  };
}

/**
 * The outside technical read — TradingView's own multi-timeframe aggregate.
 *
 * The value of this seat is that it did not compute anything from our candles.
 * When it agrees with the trend agent that is genuine corroboration from an
 * independent pipeline; when it disagrees, one of the two is looking at a
 * timeframe the other is not.
 *
 * Alignment across timeframes, not the headline rating, is what sets
 * confidence. A market rated "buy" that is only a buy on the 5-minute is a
 * different proposition from one that is a buy on every bar out to the week,
 * and sizing them the same is how a desk gets caught by a pullback it could see
 * coming.
 */
export function technicalAnalyst(snapshot: MarketSnapshot, maxAgeMs = 60 * 60 * 1000, now = Date.now()): AgentOpinion {
  const read = snapshot.technical;

  if (!read) return UNAVAILABLE("technical-analyst", "No external technical rating this tick");

  const ageMs = now - read.asOf;
  if (ageMs > maxAgeMs) {
    return UNAVAILABLE("technical-analyst", `Rating is ${(ageMs / 3_600_000).toFixed(1)}h old, past the freshness limit`);
  }

  // A single reporting timeframe scores perfect alignment by arithmetic, which
  // would be a lie. Discount by breadth so one bar cannot masquerade as a
  // unanimous board.
  const breadth = Math.min(1, read.timeframes / 4);
  const strength = clampConfidence(Math.abs(read.rating) * read.alignment * breadth);

  if (read.label === "neutral" || strength < 0.05) {
    return {
      agent: "technical-analyst",
      signal: "hold",
      confidence: 0,
      rationale: `${read.source} is ${read.label.replace(/_/g, " ")} on ${read.symbol} (${read.rating.toFixed(2)} across ${read.timeframes} timeframes)`,
      source: "deterministic",
      evidence: { rating: read.rating, label: read.label, alignment: read.alignment, byTimeframe: read.byTimeframe, rsi: read.rsi, adx: read.adx },
    };
  }

  return {
    agent: "technical-analyst",
    signal: read.rating > 0 ? "buy" : "sell",
    confidence: strength,
    rationale:
      `${read.source} rates ${read.symbol} ${read.label.replace(/_/g, " ")} at ${read.rating.toFixed(2)}, ` +
      `${Math.round(read.alignment * 100)}% of ${read.timeframes} timeframes agreeing` +
      `${read.adx !== null ? `, ADX ${read.adx.toFixed(0)}` : ""}`,
    source: "deterministic",
    evidence: { rating: read.rating, label: read.label, alignment: read.alignment, byTimeframe: read.byTimeframe, rsi: read.rsi, adx: read.adx, ageMs },
  };
}

/**
 * The research council's seat — the twice-daily deep research run.
 *
 * This is the slowest and most expensive voice at the table, and the one that
 * has read the news. It cannot time an entry, so its confidence is deliberately
 * damped and decays with age: a conviction from this morning is a standing view
 * of the week, not a reason to buy this minute.
 */
export function researchAnalyst(
  snapshot: MarketSnapshot,
  maxAgeMs = 26 * 60 * 60 * 1000,
  now = Date.now(),
): AgentOpinion {
  const conviction = snapshot.conviction;

  if (!conviction) return UNAVAILABLE("research-council", "No research conviction on this symbol");

  const ageMs = now - conviction.asOf;

  // A conviction dated in the future means a clock disagreement somewhere.
  // Refused rather than trusted, exactly as the regime governor refuses it.
  if (ageMs < 0) return UNAVAILABLE("research-council", "Conviction is dated in the future; ignoring");

  if (ageMs > maxAgeMs) {
    return UNAVAILABLE("research-council", `Conviction is ${(ageMs / 3_600_000).toFixed(1)}h old, past the ${(maxAgeMs / 3_600_000).toFixed(0)}h limit`);
  }

  // Linear decay to zero at the staleness limit. Yesterday's research is worth
  // something, but less than this morning's.
  const freshness = 1 - ageMs / maxAgeMs;
  const conviction_strength = conviction.stance.startsWith("strong") ? 1 : 0.6;

  if (conviction.stance === "hold") {
    return {
      agent: "research-council",
      signal: "hold",
      confidence: 0,
      rationale: `Research council is neutral on this market: ${conviction.summary || "no directional view"}`,
      source: "deterministic",
      evidence: { stance: conviction.stance, confidence: conviction.confidence, ageHours: ageMs / 3_600_000 },
    };
  }

  const bullish = conviction.stance === "buy" || conviction.stance === "strong_buy";

  return {
    agent: "research-council",
    signal: bullish ? "buy" : "sell",
    confidence: clampConfidence(clampConfidence(conviction.confidence) * conviction_strength * freshness),
    rationale:
      `Research council is ${conviction.stance.replace(/_/g, " ")} at ${Math.round(conviction.confidence * 100)}% ` +
      `(${(ageMs / 3_600_000).toFixed(1)}h old)${conviction.summary ? `: ${conviction.summary.slice(0, 160)}` : ""}`,
    source: "deterministic",
    evidence: { stance: conviction.stance, confidence: conviction.confidence, ageHours: ageMs / 3_600_000, freshness },
  };
}

/**
 * Market-wide sentiment, as a contrarian brake.
 *
 * This agent never votes with the crowd. Extreme greed is a reason to be
 * careful about buying, extreme fear a reason to be careful about selling, and
 * everything in between is silence. It carries the lowest weight at the table
 * on purpose: sentiment is context, not a trade.
 */
export function sentimentAnalyst(snapshot: MarketSnapshot, extreme = 20): AgentOpinion {
  const read = snapshot.sentiment;

  if (!read) return UNAVAILABLE("sentiment-analyst", "No market sentiment reading this tick");

  // Distance from neutral, scaled so that the published "extreme" bands are
  // where this agent starts speaking at all.
  const distance = read.value - 50;

  if (Math.abs(distance) < 50 - extreme) {
    return {
      agent: "sentiment-analyst",
      signal: "hold",
      confidence: 0,
      rationale: `Market sentiment is ${read.label.toLowerCase()} at ${read.value}/100 — nothing extreme to lean against`,
      source: "deterministic",
      evidence: { value: read.value, label: read.label },
    };
  }

  const confidence = clampConfidence((Math.abs(distance) - (50 - extreme)) / extreme);

  return {
    agent: "sentiment-analyst",
    // Deliberately inverted: the crowd at an extreme is the fade.
    signal: distance > 0 ? "sell" : "buy",
    confidence,
    rationale: `Market sentiment is ${read.label.toLowerCase()} at ${read.value}/100 — leaning against the crowd`,
    source: "deterministic",
    evidence: { value: read.value, label: read.label, distance },
  };
}
