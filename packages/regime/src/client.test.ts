import { describe, expect, it } from "vitest";
import { parseConviction } from "./client.js";

describe("parseConviction", () => {
  const valid = {
    symbol: "BTC/USDT",
    stance: "sell",
    confidence: 0.7,
    asOf: 1_760_000_000_000,
    summary: "Momentum deteriorating.",
    model: "claude-sonnet-5",
    costUsd: 0.42,
  };

  it("accepts a well-formed conviction", () => {
    expect(parseConviction(valid)).toEqual(valid);
  });

  it("rejects an unrecognised stance rather than coercing it to hold", () => {
    // Coercion would make a service returning nonsense look like one calmly
    // recommending no action — the failure would be invisible.
    expect(parseConviction({ ...valid, stance: "moon" })).toBeNull();
    expect(parseConviction({ ...valid, stance: "" })).toBeNull();
    expect(parseConviction({ ...valid, stance: 3 })).toBeNull();
  });

  it("rejects anything without a usable symbol or timestamp", () => {
    expect(parseConviction({ ...valid, symbol: "" })).toBeNull();
    expect(parseConviction({ ...valid, symbol: undefined })).toBeNull();
    expect(parseConviction({ ...valid, asOf: "yesterday" })).toBeNull();
    expect(parseConviction({ ...valid, asOf: Number.NaN })).toBeNull();
  });

  it("rejects non-objects", () => {
    for (const bad of [null, undefined, 3, "conviction", []]) {
      expect(parseConviction(bad)).toBeNull();
    }
  });

  it("clamps a confidence outside 0..1 instead of rejecting the whole record", () => {
    expect(parseConviction({ ...valid, confidence: 5 })?.confidence).toBe(1);
    expect(parseConviction({ ...valid, confidence: -2 })?.confidence).toBe(0);
    expect(parseConviction({ ...valid, confidence: Number.NaN })?.confidence).toBe(0);
  });

  it("defaults a missing confidence to zero, which the governor treats as a no-op", () => {
    const parsed = parseConviction({ ...valid, confidence: undefined });

    expect(parsed?.confidence).toBe(0);
  });

  it("tolerates missing optional metadata", () => {
    const parsed = parseConviction({ ...valid, model: undefined, costUsd: undefined, summary: undefined });

    expect(parsed).not.toBeNull();
    expect(parsed?.summary).toBe("");
    expect(parsed?.model).toBeUndefined();
  });
});
