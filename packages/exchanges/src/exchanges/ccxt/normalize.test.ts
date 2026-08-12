import { describe, expect, it } from "vitest";
import { feeInQuoteCurrency } from "./normalize.js";

const order = (over = {}) => ({
  symbol: "ETH/USDT",
  average: 1879,
  price: 1879,
  fee: { cost: 0.9395, currency: "USDT" },
  ...over,
});

describe("feeInQuoteCurrency", () => {
  it("leaves a fee already charged in the quote currency alone", () => {
    expect(feeInQuoteCurrency(order())).toBe(0.9395);
  });

  it("converts a fee charged in the base asset to quote at the fill price", () => {
    // 0.0005 ETH of fee on a fill at 1879 is $0.94 of fee.
    expect(feeInQuoteCurrency(order({ fee: { cost: 0.0005, currency: "ETH" } }))).toBeCloseTo(0.9395, 6);
  });

  it("prefers the average fill price over the limit price when converting", () => {
    const fee = feeInQuoteCurrency(order({ average: 1912.59, price: 1904, fee: { cost: 1, currency: "ETH" } }));

    expect(fee).toBe(1912.59);
  });

  it("passes a fee in some third currency through rather than inventing a rate", () => {
    // Converting an OKB-denominated fee at the ETH price would be far more
    // wrong than leaving it, which is the mistake this whole change is about.
    expect(feeInQuoteCurrency(order({ fee: { cost: 0.02, currency: "OKB" } }))).toBe(0.02);
  });

  it("reports no fee rather than NaN when the exchange sends none", () => {
    expect(feeInQuoteCurrency(order({ fee: undefined }))).toBe(0);
    expect(feeInQuoteCurrency(order({ fee: { cost: 0, currency: "USDT" } }))).toBe(0);
  });

  it("does not convert when it cannot tell what the base asset is", () => {
    expect(feeInQuoteCurrency(order({ symbol: undefined, fee: { cost: 0.5, currency: "ETH" } }))).toBe(0.5);
  });

  it("does not multiply by a missing price", () => {
    expect(feeInQuoteCurrency(order({ average: undefined, price: undefined, fee: { cost: 0.5, currency: "ETH" } }))).toBe(0.5);
  });
});
