import type { Candle } from "@opentrader/ai-team";
import { describe, expect, it } from "vitest";
import { peakSince } from "./positions.js";

/**
 * The high-water mark a trailing exit is measured against.
 *
 * Read off the candles rather than remembered, so it survives a restart and
 * needs no write on a loop that otherwise only reads. The property that matters
 * is that it can never be *lower* than the entry: a trail measured against a
 * peak below the entry price would fire on a position that has only ever lost.
 */

const bar = (timestamp: number, high: number): Candle => ({
  open: high,
  high,
  low: high,
  close: high,
  volume: 1,
  timestamp,
});

describe("peakSince", () => {
  const candles = [bar(100, 90), bar(200, 105), bar(300, 130), bar(400, 110)];

  it("takes the highest high after the position opened", () => {
    expect(peakSince(candles, 200, 100)).toBe(130);
  });

  it("ignores candles from before the entry", () => {
    // The 130 bar is at t=300; opening after it means it never happened for us.
    expect(peakSince(candles, 350, 100)).toBe(110);
  });

  it("falls back to the entry price when no candle covers the position", () => {
    expect(peakSince(candles, 900, 100)).toBe(100);
    expect(peakSince([], 0, 100)).toBe(100);
  });

  it("never reports a peak below the entry price", () => {
    // Every bar here is under water; the peak stays at the entry, so a trailing
    // rule measured against it cannot fire on a position that only ever lost.
    expect(peakSince([bar(100, 80), bar(200, 70)], 0, 100)).toBe(100);
  });
});
