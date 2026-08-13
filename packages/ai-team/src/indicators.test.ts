import { describe, expect, it } from "vitest";
import { atrPercent, closes, rsi, slopePercent, sma } from "./indicators.js";
import type { Candle } from "./types.js";

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

describe("sma", () => {
  it("averages the trailing window", () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([1, 2, 3, 4, 5], 2)).toBe(4.5);
  });

  it("returns null without enough history", () => {
    expect(sma([1, 2], 5)).toBeNull();
    expect(sma([1, 2, 3], 0)).toBeNull();
  });
});

describe("rsi", () => {
  it("pins to 100 when every move is a gain", () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(rising, 14)).toBe(100);
  });

  it("pins to 0 when every move is a loss", () => {
    const falling = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(rsi(falling, 14)).toBe(0);
  });

  it("returns 50 for a flat series", () => {
    expect(rsi(Array.from({ length: 30 }, () => 100), 14)).toBe(50);
  });

  it("lands mid-range on mixed moves", () => {
    const zigzag = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
    const value = rsi(zigzag, 14);

    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThan(20);
    expect(value!).toBeLessThan(80);
  });

  it("returns null until warmed up", () => {
    expect(rsi([100, 101, 102], 14)).toBeNull();
    // period + 1 is the exact minimum
    expect(rsi(Array.from({ length: 15 }, (_, i) => 100 + i), 14)).not.toBeNull();
  });
});

describe("atrPercent", () => {
  it("measures range as a share of price", () => {
    // Each bar spans ±0.5% of close, so true range is ~1% of price.
    const value = atrPercent(candles(Array.from({ length: 30 }, () => 100), 0.5), 14);

    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThan(0.5);
    expect(value!).toBeLessThan(1.5);
  });

  it("reports a larger figure for wider bars", () => {
    const calm = atrPercent(candles(Array.from({ length: 30 }, () => 100), 0.2), 14)!;
    const wild = atrPercent(candles(Array.from({ length: 30 }, () => 100), 4), 14)!;

    expect(wild).toBeGreaterThan(calm * 5);
  });

  it("returns null without enough history", () => {
    expect(atrPercent(candles([100, 101]), 14)).toBeNull();
  });
});

describe("slopePercent", () => {
  it("is positive for a rising series and negative for a falling one", () => {
    expect(slopePercent([100, 101, 102, 103, 104], 5)!).toBeGreaterThan(0);
    expect(slopePercent([104, 103, 102, 101, 100], 5)!).toBeLessThan(0);
  });

  it("is zero for a flat series", () => {
    expect(slopePercent([100, 100, 100, 100, 100], 5)).toBe(0);
  });

  it("returns null without enough history", () => {
    expect(slopePercent([100, 101], 10)).toBeNull();
  });
});

describe("closes", () => {
  it("extracts closing prices in order", () => {
    expect(closes(candles([1, 2, 3]))).toEqual([1, 2, 3]);
  });
});
