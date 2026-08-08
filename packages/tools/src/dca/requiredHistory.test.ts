import { describe, expect, it } from "vitest";

import { BarSize } from "@opentrader/types";

import { requiredHistory } from "./requiredHistory.js";

describe("requiredHistory", () => {
  it("requests one extra timeframe for the first RSI value", () => {
    expect(requiredHistory([["RSI", BarSize.FOUR_HOURS, { periods: 14 }]])).toBe(3600);
  });

  it("keeps the configured period count for SMA", () => {
    expect(requiredHistory([["SMA", BarSize.FOUR_HOURS, { periods: 14 }]])).toBe(3360);
  });
});
