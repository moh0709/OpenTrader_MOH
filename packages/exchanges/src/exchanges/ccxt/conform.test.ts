import { describe, expect, it } from "vitest";
import { checkOrderLimits, conformOrder, floorToStep, type MarketRules } from "./conform.js";

/**
 * The rule this module exists to enforce is asymmetric, and the tests are mostly
 * about that asymmetry: a size may always be rounded down and must never be
 * rounded up, because a venue's step size is not permission to exceed a risk
 * cap. Everything else is arithmetic.
 */

const HBAR: MarketRules = { amountStep: 1, priceTick: 0.00001, minAmount: 1, minCost: 5 };
const BTC: MarketRules = { amountStep: 0.00001, priceTick: 0.01, minAmount: 0.00001, minCost: 5 };
const NO_RULES: MarketRules = { amountStep: null, priceTick: null, minAmount: null, minCost: null };

describe("floorToStep", () => {
  it("rounds down to the step", () => {
    expect(floorToStep(1664.349495033157, 1)).toBe(1664);
    expect(floorToStep(0.00042871934, 0.00001)).toBe(0.00042);
    expect(floorToStep(7.999, 0.001)).toBe(7.999);
  });

  it("survives the float error that plain division leaves behind", () => {
    // 0.29 / 0.01 is 28.999999999999996 in IEEE 754. Floored naively that is 28,
    // and a whole step disappears.
    expect(floorToStep(0.29, 0.01)).toBe(0.29);
    expect(floorToStep(1.15, 0.05)).toBe(1.15);
    expect(floorToStep(0.07, 0.01)).toBe(0.07);
  });

  it("never rounds up", () => {
    for (const [value, step] of [
      [1.9999, 1],
      [0.00999, 0.01],
      [999.99, 10],
    ] as const) {
      expect(floorToStep(value, step)).toBeLessThanOrEqual(value);
    }
  });

  it("passes the value through when there is no step to honour", () => {
    expect(floorToStep(1.23456, null)).toBe(1.23456);
    expect(floorToStep(1.23456, 0)).toBe(1.23456);
  });
});

describe("checkOrderLimits", () => {
  it("accepts an order that clears both minimums", () => {
    expect(checkOrderLimits(100, 0.08, HBAR).ok).toBe(true);
  });

  it("refuses a size under the venue minimum", () => {
    const result = checkOrderLimits(0.000001, 80000, BTC);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/under the venue minimum/);
  });

  it("refuses an order worth less than the venue will accept", () => {
    // 10 HBAR at 0.08 is 0.80 quote — over the amount minimum, under the cost
    // one. This is the check that actually bites in practice.
    const result = checkOrderLimits(10, 0.08, HBAR);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/order value 0.8000 is under the venue minimum of 5/);
  });

  it("refuses a size that is not a size", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(checkOrderLimits(bad, 100, BTC).ok, String(bad)).toBe(false);
    }
  });

  it("does not invent limits a venue did not state", () => {
    expect(checkOrderLimits(0.0000001, 1, NO_RULES).ok).toBe(true);
  });

  it("cannot judge cost without a price, and says nothing rather than guessing", () => {
    // A market order carries no price. Refusing it for an unknowable cost would
    // block every market entry; the amount minimum still applies.
    expect(checkOrderLimits(100, null, HBAR).ok).toBe(true);
  });
});

describe("conformOrder", () => {
  it("rounds a raw computed size to something the venue accepts", () => {
    // The exact quantity this system sent to production on 6 September.
    const result = conformOrder(1664.349495033157, 0.08029, HBAR);

    expect(result.ok).toBe(true);
    expect(result.quantity).toBe(1664);
    expect(result.adjusted).toMatch(/quantity 1664.349495033157 -> 1664/);
  });

  it("reports when nothing needed changing", () => {
    const result = conformOrder(1664, 0.08, HBAR);

    expect(result.ok).toBe(true);
    expect(result.adjusted).toBeUndefined();
  });

  it("refuses rather than rounding a size up to the minimum", () => {
    // Rounding 0.4 up to the 1-unit step would place more exposure than was
    // authorised. The trade is declined instead — this is the whole point.
    const result = conformOrder(0.4, 0.08, HBAR);

    expect(result.ok).toBe(false);
    expect(result.quantity).toBe(0);
  });

  it("applies the venue's own rounding when one is supplied", () => {
    // ccxt does the rounding in production; this proves the seam is used.
    const result = conformOrder(
      1664.349495033157,
      0.080294999,
      HBAR,
      (v) => Math.floor(v),
      (v) => Number(v.toFixed(5)),
    );

    expect(result.quantity).toBe(1664);
    expect(result.price).toBe(0.08029);
    expect(result.adjusted).toMatch(/price 0.080294999 -> 0.08029/);
  });

  it("leaves a market order's absent price alone", () => {
    const result = conformOrder(1664.9, null, HBAR);

    expect(result.price).toBeNull();
    expect(result.quantity).toBe(1664);
    expect(result.ok).toBe(true);
  });
});
