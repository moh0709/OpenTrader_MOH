import type { ArbEvaluation } from "@opentrader/arbitrage";

export type Signal = "buy" | "sell" | "hold";

/** Coarse market regime, as judged by the market analyst. */
export type Regime = "trending_up" | "trending_down" | "ranging" | "volatile";

export type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  timestamp: number;
};

/**
 * Everything the council sees for one decision. Built once per tick so every
 * agent reasons over identical inputs — divergent opinions then reflect
 * genuinely different analysis rather than different data.
 */
export type MarketSnapshot = {
  symbol: string;
  price: number;
  /** Oldest first, newest last. */
  candles: Candle[];
  /** Best cross-venue evaluation for this symbol, when the scanner ran. */
  arb?: ArbEvaluation | null;
};

/**
 * One agent's view. `source` records whether it came from the LLM or the
 * deterministic model, so a degraded run is visible in the logs rather than
 * silently indistinguishable from a healthy one.
 */
export type AgentOpinion = {
  agent: string;
  signal: Signal;
  /** 0..1, clamped on construction. */
  confidence: number;
  rationale: string;
  source: "deterministic" | "llm";
  /**
   * False when the agent had nothing to work with — no cross-venue scan, not
   * enough history to warm an indicator.
   *
   * This is a different thing from abstaining. An agent that examined the market
   * and saw no trade is a real data point and counts toward how much of the
   * council weighed in; an agent that never got to look should not be counted
   * against that at all. Defaults to true.
   */
  available?: boolean;
  evidence?: Record<string, unknown>;
};

/**
 * Hard limits enforced in code after the council votes.
 *
 * Nothing an agent returns — LLM or otherwise — can widen these. The council
 * proposes; the governor disposes.
 */
export type RiskLimits = {
  /** Maximum notional for a single new position, in quote currency. */
  maxPositionQuote: number;
  /** Maximum total open exposure across all positions, in quote currency. */
  maxTotalExposureQuote: number;
  /** Trading halts for the day once realised losses reach this. */
  maxDailyLossQuote: number;
  /** Trading halts after this many losing trades in a row. */
  maxConsecutiveLosses: number;
  /** Council confidence below this is treated as no signal. */
  minConfidence: number;
  /**
   * Whether to add to a position that is already open.
   *
   * Off by default. The council re-states its view on every tick, so a trend it
   * likes produces a buy signal every candle for as long as the trend lasts.
   * Without this gate the bot pyramids into the same idea candle after candle
   * and is maximally exposed exactly when the trend is most extended — which is
   * precisely when it tends to reverse.
   */
  allowPyramiding: boolean;
  /**
   * Whether tripping a loss limit should also exit positions already open.
   *
   * Without this, hitting the daily loss limit only stops the bot opening *new*
   * trades — whatever it already holds keeps riding, which is precisely the
   * position the limit was meant to protect against. On by default.
   *
   * The kill switch deliberately does not trigger this: it means "pause", and an
   * operator flipping it to think should not be forced out of the market.
   */
  liquidateOnBreach: boolean;
  /** Operator kill switch. Blocks new trades; does not force an exit. */
  killSwitch: boolean;
};

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxPositionQuote: 100,
  maxTotalExposureQuote: 500,
  maxDailyLossQuote: 50,
  maxConsecutiveLosses: 3,
  minConfidence: 0.55,
  allowPyramiding: false,
  liquidateOnBreach: true,
  killSwitch: false,
};

export type PortfolioState = {
  /** Notional currently at risk in open positions. */
  openExposureQuote: number;
  /** Realised PnL since the start of the trading day (negative = loss). */
  realizedPnlToday: number;
  consecutiveLosses: number;
  /** Total account equity in quote currency. */
  equityQuote: number;
};

/** The council's proposal, before risk gating. */
export type CouncilVerdict = {
  signal: Signal;
  /** Confidence-weighted agreement, 0..1. */
  confidence: number;
  opinions: AgentOpinion[];
  rationale: string;
  /** True when the risk analyst objected during deliberation. */
  vetoed: boolean;
  vetoReason?: string;
};

/** The final, risk-gated decision. This is the only thing allowed to trade. */
export type TradeDecision = {
  signal: Signal;
  /** Notional to trade, in quote currency. Zero whenever signal is "hold". */
  sizeQuote: number;
  confidence: number;
  /** Every reason the governor clamped, downgraded, or refused. */
  riskNotes: string[];
  approved: boolean;
  /**
   * True when risk state requires exiting positions already open, not merely
   * blocking new ones. Only ever set when there is actual exposure to exit.
   *
   * The governor decides this but does not act on it — it stays a pure function
   * so it can be exhaustively tested. Executing the exit is the strategy's job.
   */
  liquidate: boolean;
  liquidateReason?: string;
  verdict: CouncilVerdict;
};

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
