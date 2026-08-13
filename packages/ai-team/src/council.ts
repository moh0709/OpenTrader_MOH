import { arbitrageScout, marketAnalyst, quantAnalyst, riskAnalyst } from "./agents.js";
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
};

export type CouncilOptions = {
  weights?: AgentWeights;
  /**
   * Optional LLM member. Returning null (its documented failure mode) simply
   * removes it from the vote.
   */
  llmAnalyst?: (snapshot: MarketSnapshot) => Promise<AgentOpinion | null>;
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

  const risk = riskAnalyst(snapshot, limits, state);
  const opinions: AgentOpinion[] = [marketAnalyst(snapshot), quantAnalyst(snapshot), arbitrageScout(snapshot)];

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
