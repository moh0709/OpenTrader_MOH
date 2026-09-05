import { describe, expect, it } from "vitest";
import { DEFAULT_PAPER_FEE_BPS, paperFeeBps, paperFeeQuote } from "./paper-fees.js";

describe("paperFeeBps", () => {
  it("defaults to a realistic spot taker rate", () => {
    expect(paperFeeBps({} as NodeJS.ProcessEnv)).toBe(DEFAULT_PAPER_FEE_BPS);
    expect(DEFAULT_PAPER_FEE_BPS).toBe(10);
  });

  it("honours an explicit zero, so a no-fee baseline can be asked for", () => {
    expect(paperFeeBps({ PAPER_FEE_BPS: "0" } as NodeJS.ProcessEnv)).toBe(0);
  });

  it("reads a configured rate", () => {
    expect(paperFeeBps({ PAPER_FEE_BPS: "27.5" } as NodeJS.ProcessEnv)).toBe(27.5);
  });

  it("falls back to the default on anything unusable", () => {
    for (const raw of ["", "abc", "-5", undefined]) {
      expect(paperFeeBps({ PAPER_FEE_BPS: raw } as NodeJS.ProcessEnv)).toBe(DEFAULT_PAPER_FEE_BPS);
    }
  });
});

describe("paperFeeQuote", () => {
  it("charges the rate on the notional, in quote currency", () => {
    // 0.04 ETH at 2500 = 100 quote; 10 bps of that is 0.10.
    expect(paperFeeQuote(0.04, 2500, 10)).toBeCloseTo(0.1, 10);
  });

  it("scales with the notional", () => {
    expect(paperFeeQuote(1, 1000, 10)).toBeCloseTo(1, 10);
    expect(paperFeeQuote(2, 1000, 10)).toBeCloseTo(2, 10);
  });

  it("is zero when there is nothing to charge against", () => {
    expect(paperFeeQuote(0, 2500, 10)).toBe(0);
    expect(paperFeeQuote(1, 0, 10)).toBe(0);
    expect(paperFeeQuote(1, 2500, 0)).toBe(0);
  });

  it("never returns NaN, whatever it is handed", () => {
    for (const [q, p] of [
      [NaN, 100],
      [1, NaN],
      [Infinity, 100],
      [-1, 100],
    ] as const) {
      expect(paperFeeQuote(q, p, 10)).toBe(0);
    }
  });

  it("makes a round trip cost twice the one-way fee", () => {
    const entry = paperFeeQuote(0.04, 2500, 10);
    const exit = paperFeeQuote(0.04, 2500, 10);
    expect(entry + exit).toBeCloseTo(0.2, 10);
  });
});
