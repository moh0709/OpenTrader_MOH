import { describe, expect, it } from "vitest";
import { convene, DEFAULT_WEIGHTS, tallyVotes } from "./council.js";
import { DEFAULT_RISK_LIMITS, type AgentOpinion, type Candle, type MarketSnapshot, type PortfolioState } from "./types.js";

function opinion(agent: string, signal: AgentOpinion["signal"], confidence: number): AgentOpinion {
  return { agent, signal, confidence, rationale: "test", source: "deterministic" };
}

export function candlesFromCloses(values: number[]): Candle[] {
  return values.map((close, i) => ({
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    volume: 1,
    timestamp: 1_700_000_000_000 + i * 60_000,
  }));
}

const healthy: PortfolioState = {
  openExposureQuote: 0,
  realizedPnlToday: 0,
  consecutiveLosses: 0,
  equityQuote: 10_000,
};

function snapshot(closes: number[]): MarketSnapshot {
  const candles = candlesFromCloses(closes);
  return { symbol: "BTC/USDT", price: closes[closes.length - 1], candles, arb: null };
}

describe("tallyVotes", () => {
  it("reaches full confidence when every seat agrees at full conviction", () => {
    const result = tallyVotes(
      [opinion("market-analyst", "buy", 1), opinion("quant-analyst", "buy", 1), opinion("arbitrage-scout", "buy", 1)],
      { "market-analyst": 1, "quant-analyst": 1, "arbitrage-scout": 1 },
    );

    expect(result.signal).toBe("buy");
    expect(result.confidence).toBeCloseTo(1, 6);
  });

  it("cancels to no signal when the council is evenly split", () => {
    const result = tallyVotes([opinion("market-analyst", "buy", 1), opinion("quant-analyst", "sell", 1)], {
      "market-analyst": 1,
      "quant-analyst": 1,
    });

    expect(result.signal).toBe("hold");
    expect(result.confidence).toBe(0);
  });

  it("lets the stronger side win but discounts for the disagreement", () => {
    const result = tallyVotes([opinion("market-analyst", "buy", 1.0), opinion("quant-analyst", "sell", 0.4)], {
      "market-analyst": 1,
      "quant-analyst": 1,
    });

    expect(result.signal).toBe("buy");
    // (1.0 - 0.4) / 2 seats
    expect(result.confidence).toBeCloseTo(0.3, 6);
    expect(result.confidence).toBeLessThan(1);
  });

  it("weights the arbitrage scout above a single indicator agent", () => {
    const result = tallyVotes([opinion("arbitrage-scout", "buy", 1), opinion("market-analyst", "sell", 1)], DEFAULT_WEIGHTS);

    expect(result.signal).toBe("buy");
  });

  it("discounts a lone voice when the rest of the council abstains", () => {
    const alone = tallyVotes([opinion("market-analyst", "buy", 1), opinion("quant-analyst", "hold", 0)], {
      "market-analyst": 1,
      "quant-analyst": 1,
    });

    // Full agreement among those who voted, discounted for thin coverage.
    expect(alone.signal).toBe("buy");
    expect(alone.confidence).toBeCloseTo(Math.sqrt(0.5), 6);
    expect(alone.confidence).toBeLessThan(1);
  });

  it("rates two agreeing agents above one agent speaking alone", () => {
    const weights = { "market-analyst": 1, "quant-analyst": 1 };

    const alone = tallyVotes([opinion("market-analyst", "buy", 1), opinion("quant-analyst", "hold", 0)], weights);
    const together = tallyVotes([opinion("market-analyst", "buy", 1), opinion("quant-analyst", "buy", 1)], weights);

    expect(together.confidence).toBeGreaterThan(alone.confidence);
    expect(together.confidence).toBeCloseTo(1, 6);
  });

  it("does not let abstentions dilute the agents that did vote", () => {
    // Two agents agree; a third abstains. Agreement stays high rather than
    // being dragged toward the floor by silence.
    const result = tallyVotes(
      [opinion("market-analyst", "buy", 1), opinion("quant-analyst", "buy", 1), opinion("arbitrage-scout", "hold", 0)],
      { "market-analyst": 1, "quant-analyst": 1, "arbitrage-scout": 1 },
    );

    expect(result.signal).toBe("buy");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("returns no signal when everyone abstains", () => {
    const result = tallyVotes([opinion("market-analyst", "hold", 0), opinion("quant-analyst", "hold", 0)]);

    expect(result.signal).toBe("hold");
    expect(result.confidence).toBe(0);
  });

  it("handles an empty council without dividing by zero", () => {
    expect(tallyVotes([])).toEqual({ signal: "hold", confidence: 0 });
  });
});

describe("convene", () => {
  const rising = Array.from({ length: 40 }, (_, i) => 100 + i);

  it("returns a verdict carrying every seat's opinion", async () => {
    const verdict = await convene(snapshot(rising), DEFAULT_RISK_LIMITS, healthy);

    const agents = verdict.opinions.map((o) => o.agent);
    expect(agents).toContain("market-analyst");
    expect(agents).toContain("quant-analyst");
    expect(agents).toContain("arbitrage-scout");
    expect(agents).toContain("risk-analyst");
  });

  it("short-circuits to a veto when the kill switch is on", async () => {
    const verdict = await convene(snapshot(rising), { ...DEFAULT_RISK_LIMITS, killSwitch: true }, healthy);

    expect(verdict.vetoed).toBe(true);
    expect(verdict.signal).toBe("hold");
    expect(verdict.confidence).toBe(0);
    expect(verdict.vetoReason).toContain("kill switch");
  });

  it("includes the LLM member when it answers", async () => {
    const verdict = await convene(snapshot(rising), DEFAULT_RISK_LIMITS, healthy, {
      llmAnalyst: async () => ({
        agent: "llm-strategist",
        signal: "buy",
        confidence: 0.9,
        rationale: "test",
        source: "llm",
      }),
    });

    expect(verdict.opinions.map((o) => o.agent)).toContain("llm-strategist");
    expect(verdict.opinions.find((o) => o.agent === "llm-strategist")?.source).toBe("llm");
  });

  // The degradation path: a null from the LLM member must be invisible to the
  // rest of the system beyond the missing seat.
  it("proceeds with a complete council when the LLM is unavailable", async () => {
    const verdict = await convene(snapshot(rising), DEFAULT_RISK_LIMITS, healthy, {
      llmAnalyst: async () => null,
    });

    expect(verdict.opinions.map((o) => o.agent)).not.toContain("llm-strategist");
    expect(verdict.opinions.length).toBe(4);
    expect(verdict.vetoed).toBe(false);
  });

  it("excludes the risk analyst from the directional vote", async () => {
    // The risk analyst always returns "hold"; if it were counted it would drag
    // every verdict toward no-signal.
    const withRisk = await convene(snapshot(rising), DEFAULT_RISK_LIMITS, healthy);
    const votingSeats = withRisk.opinions.filter((o) => o.agent !== "risk-analyst");

    const expected = tallyVotes(votingSeats, DEFAULT_WEIGHTS);
    expect(withRisk.signal).toBe(expected.signal);
    expect(withRisk.confidence).toBeCloseTo(expected.confidence, 6);
  });
});
