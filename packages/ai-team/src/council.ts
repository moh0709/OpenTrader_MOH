import {
  arbitrageScout,
  marketAnalyst,
  quantAnalyst,
  researchAnalyst,
  riskAnalyst,
  sentimentAnalyst,
  technicalAnalyst,
} from "./agents.js";
import type { AgentOpinion, CouncilVerdict, MarketSnapshot, PortfolioState, RiskLimits, Signal } from "./types.js";

/**
 * How much each seat counts in the vote.
 *
 * The arbitrage scout and the LLM strategist carry more weight than the two
 * indicator agents for different reasons: an arbitrage edge that cleared depth
 * and fee checks does not depend on predicting direction at all, and the LLM
 * is the only member that can weigh conflicting evidence rather than reading a
 * single number.
 */
export type AgentWeights = Record<string, number>;

export const DEFAULT_WEIGHTS: AgentWeights = {
  "market-analyst": 1.0,
  "quant-analyst": 1.0,
  "arbitrage-scout": 1.5,
  "llm-strategist": 1.5,
  /**
   * The three outside voices.
   *
   * The technical analyst is weighted like the indicator agents rather than
   * above them: it is a second opinion on the same question, computed
   * elsewhere, and corroboration is worth a seat but not a casting vote.
   *
   * The research council is the deepest read at the table and the slowest — it
   * has news and fundamentals the price series cannot carry, and its own agent
   * already decays its confidence with age, so a full weight here does not let
   * a stale view dominate.
   *
   * Sentiment is deliberately the quietest seat. It is context for sizing, not
   * a reason to trade, and it only speaks at all when the crowd is at an
   * extreme.
   */
  "technical-analyst": 1.0,
  "research-council": 1.25,
  "sentiment-analyst": 0.5,
};

export type CouncilOptions = {
  weights?: AgentWeights;
  /**
   * Optional LLM member. Returning null (its documented failure mode) simply
   * removes it from the vote.
   */
  llmAnalyst?: (snapshot: MarketSnapshot) => Promise<AgentOpinion | null>;
  /**
   * Clock for the agents that judge how old their evidence is. Injected so the
   * staleness rules can be tested without waiting a day.
   */
  now?: number;
};

/**
 * Aggregate opinions into a single verdict by confidence-weighted vote.
 *
 * Opposing votes cancel, so a split council yields low confidence rather than
 * an arbitrary winner — which is the behaviour we want, because position size
 * scales with the confidence reported here.
 */
export function tallyVotes(opinions: AgentOpinion[], weights: AgentWeights = DEFAULT_WEIGHTS): { signal: Signal; confidence: number } {
  let buyScore = 0;
  let sellScore = 0;
  let totalWeight = 0;
  let participatingWeight = 0;

  for (const opinion of opinions) {
    // An agent that had no data to work with is not at the table this tick.
    if (opinion.available === false) continue;

    const weight = weights[opinion.agent] ?? 1;
    totalWeight += weight;

    if (opinion.signal === "buy") {
      buyScore += weight * opinion.confidence;
      participatingWeight += weight;
    } else if (opinion.signal === "sell") {
      sellScore += weight * opinion.confidence;
      participatingWeight += weight;
    }
  }

  if (totalWeight === 0 || participatingWeight === 0) return { signal: "hold", confidence: 0 };

  const net = buyScore - sellScore;
  if (net === 0) return { signal: "hold", confidence: 0 };

  // Confidence has two independent parts, kept separate on purpose.
  //
  // `agreement` measures how aligned the agents that actually voted are. It
  // divides by participating weight rather than total weight, because an
  // abstention means "I see nothing here", not "I disagree" — counting silence
  // as dissent made it nearly impossible to clear the confidence floor.
  //
  // `coverage` then discounts a verdict that only part of the council spoke to,
  // so a single voice among abstainers is a weaker signal than two agents
  // agreeing. The square root softens it: thin evidence is discounted, not
  // dismissed.
  const agreement = Math.abs(net) / participatingWeight;
  const coverage = Math.sqrt(participatingWeight / totalWeight);
  const confidence = Math.min(1, agreement * coverage);

  if (confidence === 0) return { signal: "hold", confidence: 0 };
  return { signal: net > 0 ? "buy" : "sell", confidence };
}

/**
 * Convene the full council for one decision.
 *
 * The risk analyst's veto short-circuits the vote: when it objects there is no
 * point weighing the others, and recording the objection makes the reason
 * visible in the trade log.
 */
export async function convene(
  snapshot: MarketSnapshot,
  limits: RiskLimits,
  state: PortfolioState,
  options: CouncilOptions = {},
): Promise<CouncilVerdict> {
  const weights = options.weights ?? DEFAULT_WEIGHTS;

  const now = options.now ?? Date.now();

  const risk = riskAnalyst(snapshot, limits, state);

  /*
   * Six deterministic seats, three of which are usually empty.
   *
   * The three outside agents report themselves unavailable when their evidence
   * is missing or stale, and an unavailable agent is excluded from the tally
   * entirely rather than counted as a dissenting hold. That is what makes this
   * one council rather than two: the same code decides for a strategy running
   * on candles alone and for the trading head running on everything.
   */
  const opinions: AgentOpinion[] = [
    marketAnalyst(snapshot),
    quantAnalyst(snapshot),
    arbitrageScout(snapshot),
    technicalAnalyst(snapshot, undefined, now),
    researchAnalyst(snapshot, undefined, now),
    sentimentAnalyst(snapshot),
  ];

  if (options.llmAnalyst) {
    const llmOpinion = await options.llmAnalyst(snapshot);
    if (llmOpinion) opinions.push(llmOpinion);
  }

  opinions.push(risk.opinion);

  if (risk.veto) {
    return {
      signal: "hold",
      confidence: 0,
      opinions,
      rationale: `Risk analyst vetoed: ${risk.reason}`,
      vetoed: true,
      vetoReason: risk.reason,
    };
  }

  // The risk analyst never votes directionally; it advises and vetoes.
  const voting = opinions.filter((o) => o.agent !== "risk-analyst");
  const { signal, confidence } = tallyVotes(voting, weights);

  const contributing = voting
    .filter((o) => o.signal !== "hold")
    .map((o) => `${o.agent}:${o.signal}@${o.confidence.toFixed(2)}`)
    .join(", ");

  return {
    signal,
    confidence,
    opinions,
    rationale: signal === "hold" ? `No consensus (${contributing || "all abstained"})` : `${signal} by weighted vote (${contributing})`,
    vetoed: false,
  };
}
