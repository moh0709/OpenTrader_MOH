import { describe, expect, it } from "vitest";
import { researchAnalyst, sentimentAnalyst, technicalAnalyst } from "./agents.js";
import type { Candle, MarketSnapshot } from "./types.js";

/**
 * The three seats that read evidence from outside the desk's own candles.
 *
 * The property that matters for all of them is the same: absent or stale
 * evidence must make the agent *unavailable*, not make it vote hold. An
 * unavailable agent is excluded from the tally; a hold is counted as coverage,
 * and would quietly drag every verdict toward no-signal on the days these
 * sources are down.
 */

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  volume: 1,
  timestamp: NOW - (40 - i) * 60_000,
}));

function snapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return { symbol: "BTC/USDT", price: 100, candles, ...overrides };
}

function rating(overrides: Partial<NonNullable<MarketSnapshot["technical"]>> = {}) {
  return {
    source: "tradingview" as const,
    symbol: "BTC/USDT",
    ticker: "BINANCE:BTCUSDT",
    rating: 0.5,
    label: "strong_buy" as const,
    byTimeframe: { "15": 0.5, "60": 0.5, "240": 0.5, "1D": 0.5 },
    alignment: 1,
    timeframes: 4,
    rsi: 60,
    adx: 30,
    close: 100,
    changePercent: 1,
    asOf: NOW,
    ...overrides,
  };
}

describe("technicalAnalyst", () => {
  it("votes with a broad, aligned rating", () => {
    const opinion = technicalAnalyst(snapshot({ technical: rating() }), undefined, NOW);

    expect(opinion.signal).toBe("buy");
    expect(opinion.confidence).toBeCloseTo(0.5, 5);
    expect(opinion.available).not.toBe(false);
  });

  it("discounts a rating that only one timeframe reported", () => {
    const broad = technicalAnalyst(snapshot({ technical: rating() }), undefined, NOW);
    const narrow = technicalAnalyst(
      snapshot({ technical: rating({ byTimeframe: { "5": 0.5 }, timeframes: 1 }) }),
      undefined,
      NOW,
    );

    expect(narrow.confidence).toBeLessThan(broad.confidence);
  });

  it("discounts a market whose timeframes disagree", () => {
    const split = technicalAnalyst(snapshot({ technical: rating({ alignment: 0.5 }) }), undefined, NOW);

    expect(split.confidence).toBeCloseTo(0.25, 5);
  });

  it("is unavailable rather than neutral when there is no reading", () => {
    expect(technicalAnalyst(snapshot(), undefined, NOW).available).toBe(false);
  });

  it("is unavailable once the reading is stale", () => {
    const old = technicalAnalyst(snapshot({ technical: rating({ asOf: NOW - 3 * HOUR }) }), HOUR, NOW);

    expect(old.available).toBe(false);
    expect(old.rationale).toMatch(/3.0h old/);
  });

  it("abstains, but stays at the table, on a genuinely neutral market", () => {
    const flat = technicalAnalyst(
      snapshot({ technical: rating({ rating: 0.02, label: "neutral" }) }),
      undefined,
      NOW,
    );

    expect(flat.signal).toBe("hold");
    expect(flat.available).not.toBe(false);
  });
});

describe("researchAnalyst", () => {
  const conviction = (overrides: Partial<NonNullable<MarketSnapshot["conviction"]>> = {}) => ({
    stance: "strong_buy" as const,
    confidence: 0.8,
    summary: "Accumulation into the halving.",
    asOf: NOW,
    ...overrides,
  });

  it("votes with a fresh conviction", () => {
    const opinion = researchAnalyst(snapshot({ conviction: conviction() }), undefined, NOW);

    expect(opinion.signal).toBe("buy");
    expect(opinion.confidence).toBeCloseTo(0.8, 5);
  });

  it("decays with age rather than falling off a cliff", () => {
    const fresh = researchAnalyst(snapshot({ conviction: conviction() }), 26 * HOUR, NOW);
    const older = researchAnalyst(snapshot({ conviction: conviction({ asOf: NOW - 13 * HOUR }) }), 26 * HOUR, NOW);

    expect(older.confidence).toBeGreaterThan(0);
    expect(older.confidence).toBeLessThan(fresh.confidence);
  });

  it("weighs a plain buy below a strong buy", () => {
    const strong = researchAnalyst(snapshot({ conviction: conviction() }), undefined, NOW);
    const plain = researchAnalyst(snapshot({ conviction: conviction({ stance: "buy" }) }), undefined, NOW);

    expect(plain.confidence).toBeLessThan(strong.confidence);
  });

  it("sells on a bearish stance", () => {
    expect(researchAnalyst(snapshot({ conviction: conviction({ stance: "strong_sell" }) }), undefined, NOW).signal).toBe("sell");
  });

  it("is unavailable past the staleness limit", () => {
    expect(researchAnalyst(snapshot({ conviction: conviction({ asOf: NOW - 40 * HOUR }) }), 26 * HOUR, NOW).available).toBe(false);
  });

  it("refuses a conviction dated in the future", () => {
    const ahead = researchAnalyst(snapshot({ conviction: conviction({ asOf: NOW + HOUR }) }), undefined, NOW);

    expect(ahead.available).toBe(false);
    expect(ahead.rationale).toMatch(/future/);
  });

  it("is unavailable with no conviction at all", () => {
    expect(researchAnalyst(snapshot(), undefined, NOW).available).toBe(false);
  });
});

describe("sentimentAnalyst", () => {
  const reading = (value: number, label = "Greed") => ({
    source: "alternative.me" as const,
    value,
    label,
    asOf: NOW,
  });

  it("fades extreme greed", () => {
    const opinion = sentimentAnalyst(snapshot({ sentiment: reading(90, "Extreme Greed") }));

    expect(opinion.signal).toBe("sell");
    expect(opinion.confidence).toBeGreaterThan(0);
  });

  it("fades extreme fear", () => {
    expect(sentimentAnalyst(snapshot({ sentiment: reading(8, "Extreme Fear") })).signal).toBe("buy");
  });

  it("says nothing in the middle of the range", () => {
    const opinion = sentimentAnalyst(snapshot({ sentiment: reading(55) }));

    expect(opinion.signal).toBe("hold");
    expect(opinion.confidence).toBe(0);
    expect(opinion.available).not.toBe(false);
  });

  it("is unavailable with no reading", () => {
    expect(sentimentAnalyst(snapshot()).available).toBe(false);
  });
});
