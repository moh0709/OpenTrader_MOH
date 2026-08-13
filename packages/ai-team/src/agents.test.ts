import type { ArbEvaluation } from "@opentrader/arbitrage";
import { describe, expect, it } from "vitest";
import { arbitrageScout, marketAnalyst, quantAnalyst, riskAnalyst } from "./agents.js";
import { DEFAULT_RISK_LIMITS, type Candle, type MarketSnapshot, type PortfolioState } from "./types.js";

function candles(values: number[], rangePct = 0.1): Candle[] {
  return values.map((close, i) => ({
    open: close,
    high: close * (1 + rangePct / 100),
    low: close * (1 - rangePct / 100),
    close,
    volume: 1,
    timestamp: 1_700_000_000_000 + i * 60_000,
  }));
}

function snapshot(values: number[], arb: ArbEvaluation | null = null, rangePct = 0.1): MarketSnapshot {
  return {
    symbol: "BTC/USDT",
    price: values[values.length - 1],
    candles: candles(values, rangePct),
    arb,
  };
}

const healthy: PortfolioState = {
  openExposureQuote: 0,
  realizedPnlToday: 0,
  consecutiveLosses: 0,
  equityQuote: 10_000,
};

function arbEvaluation(overrides: Partial<ArbEvaluation> = {}): ArbEvaluation {
  return {
    symbol: "BTC/USDT",
    buyVenue: "BINANCE",
    sellVenue: "OKX",
    qty: 0.01,
    buyAvgPrice: 100,
    sellAvgPrice: 100.5,
    topOfBookSpreadBps: 50,
    grossSpreadBps: 50,
    netSpreadBps: 30,
    netProfitQuote: 0.3,
    buySlippageBps: 0,
    sellSlippageBps: 0,
    executable: true,
    rejections: [],
    bookAgeMs: 100,
    ...overrides,
  };
}

describe("marketAnalyst", () => {
  it("buys a confirmed uptrend", () => {
    const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
    const opinion = marketAnalyst(snapshot(rising));

    expect(opinion.signal).toBe("buy");
    expect(opinion.confidence).toBeGreaterThan(0.5);
    expect(opinion.evidence?.regime).toBe("trending_up");
  });

  it("sells a confirmed downtrend", () => {
    const falling = Array.from({ length: 40 }, (_, i) => 200 - i);
    const opinion = marketAnalyst(snapshot(falling));

    expect(opinion.signal).toBe("sell");
    expect(opinion.confidence).toBeGreaterThan(0.5);
    expect(opinion.evidence?.regime).toBe("trending_down");
  });

  it("abstains in a flat market rather than reading noise as trend", () => {
    const flat = Array.from({ length: 40 }, () => 100);
    const opinion = marketAnalyst(snapshot(flat));

    expect(opinion.signal).toBe("hold");
    expect(opinion.confidence).toBe(0);
    expect(opinion.evidence?.regime).toBe("ranging");
  });

  it("abstains without enough history", () => {
    const opinion = marketAnalyst(snapshot([100, 101, 102]));

    expect(opinion.signal).toBe("hold");
    expect(opinion.rationale).toContain("Need 30 candles");
  });

  it("halves confidence when the slope contradicts the averages", () => {
    // Rises for most of the window, then turns down at the end: the fast average
    // is still above the slow one, but recent direction disagrees.
    const values = [...Array.from({ length: 32 }, (_, i) => 100 + i * 2), 160, 155, 150, 145, 140, 135, 130, 125];
    const opinion = marketAnalyst(snapshot(values));

    expect(opinion.rationale).toContain("diverges");
  });
});

describe("quantAnalyst", () => {
  it("buys an oversold market", () => {
    const falling = Array.from({ length: 30 }, (_, i) => 200 - i * 2);
    const opinion = quantAnalyst(snapshot(falling));

    expect(opinion.signal).toBe("buy");
    expect(opinion.confidence).toBeGreaterThan(0);
    expect(opinion.evidence?.rsi).toBe(0);
  });

  it("sells an overbought market", () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const opinion = quantAnalyst(snapshot(rising));

    expect(opinion.signal).toBe("sell");
    expect(opinion.evidence?.rsi).toBe(100);
  });

  it("abstains in the neutral band", () => {
    const flat = Array.from({ length: 30 }, () => 100);
    const opinion = quantAnalyst(snapshot(flat));

    expect(opinion.signal).toBe("hold");
    expect(opinion.confidence).toBe(0);
  });

  it("abstains before RSI is warmed up", () => {
    const opinion = quantAnalyst(snapshot([100, 101]));

    expect(opinion.signal).toBe("hold");
    expect(opinion.rationale).toContain("warm RSI");
  });
});

describe("arbitrageScout", () => {
  it("acts on an executable edge", () => {
    const opinion = arbitrageScout(snapshot(Array.from({ length: 30 }, () => 100), arbEvaluation()));

    expect(opinion.signal).toBe("buy");
    expect(opinion.confidence).toBeGreaterThan(0);
    expect(opinion.rationale).toContain("Executable");
  });

  it("leaves the directional vote alone when it finds no executable edge", () => {
    const rejected = arbEvaluation({ executable: false, rejections: ["INSUFFICIENT_DEPTH"], netSpreadBps: 30 });
    const opinion = arbitrageScout(snapshot(Array.from({ length: 30 }, () => 100), rejected));

    expect(opinion.signal).toBe("hold");
    expect(opinion.confidence).toBe(0);
    // Not a dissenting directional vote — a different question with no answer.
    expect(opinion.available).toBe(false);
    // The reason is still recorded for the audit trail.
    expect(opinion.rationale).toContain("INSUFFICIENT_DEPTH");
  });

  it("abstains when no scan ran", () => {
    const opinion = arbitrageScout(snapshot(Array.from({ length: 30 }, () => 100), null));

    expect(opinion.signal).toBe("hold");
    expect(opinion.rationale).toContain("No cross-venue scan");
  });

  it("scales confidence with the size of the edge", () => {
    const small = arbitrageScout(snapshot(Array.from({ length: 30 }, () => 100), arbEvaluation({ netSpreadBps: 5 })));
    const large = arbitrageScout(snapshot(Array.from({ length: 30 }, () => 100), arbEvaluation({ netSpreadBps: 25 })));

    expect(large.confidence).toBeGreaterThan(small.confidence);
  });
});

describe("riskAnalyst", () => {
  const calm = snapshot(Array.from({ length: 30 }, () => 100));

  it("clears a healthy portfolio in a calm market", () => {
    const result = riskAnalyst(calm, DEFAULT_RISK_LIMITS, healthy);

    expect(result.veto).toBe(false);
    expect(result.opinion.confidence).toBe(0);
  });

  it("vetoes on the kill switch", () => {
    const result = riskAnalyst(calm, { ...DEFAULT_RISK_LIMITS, killSwitch: true }, healthy);

    expect(result.veto).toBe(true);
    expect(result.reason).toContain("kill switch");
  });

  it("vetoes once the daily loss limit is hit", () => {
    const result = riskAnalyst(calm, DEFAULT_RISK_LIMITS, { ...healthy, realizedPnlToday: -100 });

    expect(result.veto).toBe(true);
    expect(result.reason).toContain("daily loss");
  });

  it("vetoes after consecutive losses", () => {
    const result = riskAnalyst(calm, DEFAULT_RISK_LIMITS, { ...healthy, consecutiveLosses: 5 });

    expect(result.veto).toBe(true);
    expect(result.reason).toContain("consecutive losses");
  });

  it("vetoes when exposure is at the cap", () => {
    const result = riskAnalyst(calm, DEFAULT_RISK_LIMITS, { ...healthy, openExposureQuote: 500 });

    expect(result.veto).toBe(true);
    expect(result.reason).toContain("exposure");
  });

  it("vetoes a volatility spike", () => {
    // Bars spanning ±10% of price put ATR far above the 5% ceiling.
    const wild = snapshot(Array.from({ length: 30 }, () => 100), null, 10);
    const result = riskAnalyst(wild, DEFAULT_RISK_LIMITS, healthy);

    expect(result.veto).toBe(true);
    expect(result.reason).toContain("volatility");
  });

  it("collects every reason rather than stopping at the first", () => {
    const result = riskAnalyst(calm, { ...DEFAULT_RISK_LIMITS, killSwitch: true }, { ...healthy, consecutiveLosses: 5 });

    expect(result.reason).toContain("kill switch");
    expect(result.reason).toContain("consecutive losses");
  });
});
