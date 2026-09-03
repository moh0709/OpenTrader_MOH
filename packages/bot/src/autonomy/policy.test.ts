import { describe, expect, it } from "vitest";
import { DEFAULT_AUTOPILOT, NUMERIC_BOUNDS, parseSymbols, toConfig } from "./policy.js";

/**
 * The reader between the database row and the head's standing orders.
 *
 * Everything here is about refusing to trust the column. A row is edited by
 * hand, restored from a backup, or written by a version of the code that no
 * longer exists — and the one outcome that must never follow from a bad value
 * is the head trading more than it was told to.
 */

const row = (overrides: Partial<Parameters<typeof toConfig>[0]> = {}) => ({
  enabled: true,
  mode: "live",
  symbols: '["BTC/USDT","ETH/USDT"]',
  botId: 7,
  intervalSec: 60,
  timeframe: "1h",
  equityQuote: 1000,
  maxPositionQuote: 100,
  maxTotalExposureQuote: 400,
  maxOpenPositions: 4,
  maxDailyOpenNotionalQuote: 600,
  maxDailyLossQuote: 50,
  maxConsecutiveLosses: 3,
  minConfidence: 0.6,
  minExitConfidence: 0.5,
  takeProfitPercent: 1.5,
  stopLossPercent: 2.5,
  trailStartPercent: 1,
  trailGivebackPercent: 0.5,
  minHoldMs: 900_000,
  cooldownMs: 600_000,
  maxHoldMs: 432_000_000,
  roundTripFeeBps: 55,
  allowPyramiding: false,
  killSwitch: false,
  ...overrides,
});

describe("parseSymbols", () => {
  it("reads a JSON array and drops duplicates", () => {
    expect(parseSymbols('["BTC/USDT","ETH/USDT","BTC/USDT"]')).toEqual(["BTC/USDT", "ETH/USDT"]);
  });

  it("returns an empty watchlist for anything it cannot read", () => {
    expect(parseSymbols("not json")).toEqual([]);
    expect(parseSymbols('{"BTC/USDT":true}')).toEqual([]);
    expect(parseSymbols(null)).toEqual([]);
    expect(parseSymbols("")).toEqual([]);
  });

  it("ignores non-string and empty entries", () => {
    expect(parseSymbols('["BTC/USDT", 3, null, "  "]')).toEqual(["BTC/USDT"]);
  });
});

describe("toConfig", () => {
  it("carries the operator's numbers through unchanged", () => {
    const config = toConfig(row());

    expect(config.mode).toBe("live");
    expect(config.symbols).toEqual(["BTC/USDT", "ETH/USDT"]);
    expect(config.botId).toBe(7);
    expect(config.limits.maxPositionQuote).toBe(100);
    expect(config.intervalMs).toBe(60_000);
  });

  it("treats anything that is not exactly 'live' as observe", () => {
    // A typo in this column must not be the thing that starts trading real money.
    for (const mode of ["Live", "LIVE", "observe", "paper", ""]) {
      expect(toConfig(row({ mode })).mode).toBe("observe");
    }
  });

  it("floors the interval so a zero cannot become a busy loop", () => {
    expect(toConfig(row({ intervalSec: 0 })).intervalMs).toBe(10_000);
    expect(toConfig(row({ intervalSec: -5 })).intervalMs).toBe(10_000);
  });

  it("falls back to the default timeframe rather than passing a bad bar to ccxt", () => {
    expect(toConfig(row({ timeframe: "7h" })).timeframe).toBe(DEFAULT_AUTOPILOT.timeframe);
    expect(toConfig(row({ timeframe: "15m" })).timeframe).toBe("15m");
  });

  it("keeps a disabled row disabled", () => {
    expect(toConfig(row({ enabled: false })).enabled).toBe(false);
  });
});

describe("saveAutopilotPolicy bounds", () => {
  /**
   * These three live in `Int` columns, and Prisma's `Int` is 32-bit however
   * roomy SQLite's own integers are. The bounds used to allow 30 and 365 days
   * in milliseconds, both past 2,147,483,647 — so a clamp produced a value the
   * write then threw on, and the operator's change silently did not take.
   */
  it("keeps every millisecond bound inside a 32-bit column", () => {
    const INT32_MAX = 2_147_483_647;

    for (const key of ["minHoldMs", "cooldownMs", "maxHoldMs"] as const) {
      expect(NUMERIC_BOUNDS[key].max).toBeLessThanOrEqual(INT32_MAX);
    }
  });

  it("still allows a window long enough to be useful", () => {
    // Three weeks. Longer than any of these has a sensible reason to be.
    expect(NUMERIC_BOUNDS.maxHoldMs.max).toBeGreaterThan(21 * 86_400_000);
  });
});
