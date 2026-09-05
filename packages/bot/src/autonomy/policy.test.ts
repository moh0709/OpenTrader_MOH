import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HEAD_LIMITS } from "@opentrader/ai-team";
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
  entryOrderType: "market",
  equityQuote: 1000,
  maxPositionQuote: 100,
  maxTotalExposureQuote: 400,
  maxOpenPositions: 4,
  maxDailyOpenNotionalQuote: 600,
  maxDailyLossQuote: 50,
  maxConsecutiveLosses: 3,
  minConfidence: 0.6,
  minExitConfidence: 0.5,
  minNetProfitQuote: 3,
  regimeFilterPeriod: 0,
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

/**
 * The schema and the code have to agree about what a default is.
 *
 * `DEFAULT_HEAD_LIMITS` was corrected to a 3.0 / 2.0 reward-to-risk pairing
 * after the first live day lost money on 1.5 / 2.5. The Prisma column defaults
 * were not, and there are no migrations in this repository — so every fresh
 * `prisma db push` went on seeding the pairing that had already been diagnosed
 * as unprofitable, and the correction only ever reached installs whose operator
 * had typed the numbers in by hand.
 *
 * Two sources of truth for one number is the bug. This test is the join.
 */
describe("schema defaults match the shipped limits", () => {
  const schema = readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "../../../prisma/src/schema.prisma"),
    "utf8",
  );

  const model = schema.slice(schema.indexOf("model AutopilotPolicy"));
  const block = model.slice(0, model.indexOf("\n}"));

  /**
   * The `@default(...)` on one column of AutopilotPolicy.
   *
   * Parsed line by line rather than with one clever expression: the schema is a
   * flat list of columns, and a parser that can be read at a glance is worth
   * more here than a compact one.
   */
  const defaultOf = (column: string): number => {
    for (const line of block.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] !== column || (parts[1] !== "Float" && parts[1] !== "Int")) continue;

      const marker = parts.find((part) => part.startsWith("@default("));
      if (!marker) break;

      return Number(marker.slice("@default(".length, -1));
    }

    throw new Error(`no Float column '${column}' with a default in AutopilotPolicy`);
  };

  const COLUMNS = [
    "minConfidence",
    "minExitConfidence",
    "minNetProfitQuote",
    "takeProfitPercent",
    "stopLossPercent",
    "trailStartPercent",
    "trailGivebackPercent",
    "roundTripFeeBps",
    "regimeFilterPeriod",
    "equityQuote",
    "maxPositionQuote",
    "maxTotalExposureQuote",
    "maxDailyOpenNotionalQuote",
    "maxDailyLossQuote",
  ] as const;

  for (const column of COLUMNS) {
    it(`seeds ${column} with the shipped default`, () => {
      expect(defaultOf(column)).toBe(DEFAULT_HEAD_LIMITS[column]);
    });
  }

  it("seeds a reward larger than the risk", () => {
    expect(defaultOf("takeProfitPercent")).toBeGreaterThan(defaultOf("stopLossPercent"));
  });

  it("seeds a floor the seeded cap can fund", () => {
    const minTicket = (defaultOf("minNetProfitQuote") / defaultOf("takeProfitPercent")) * 100;

    expect(minTicket).toBeLessThanOrEqual(defaultOf("maxPositionQuote"));
  });
});

/**
 * How an entry reaches the book.
 *
 * A limit entry rests at the bid and saves the spread; a market entry crosses
 * it. The column is free text, so the reader has to be the thing that refuses to
 * let a typo change execution behaviour.
 */
describe("entryOrderType", () => {
  it("reads a limit entry", () => {
    expect(toConfig(row({ entryOrderType: "limit" })).entryOrderType).toBe("limit");
  });

  it("treats anything that is not exactly 'limit' as a market order", () => {
    // The safe direction: an unrecognised value crosses the spread and fills,
    // rather than resting somewhere the operator never looks.
    for (const value of ["market", "Limit", "LIMIT", "maker", "", "null", "true"]) {
      expect(toConfig(row({ entryOrderType: value })).entryOrderType, value).toBe("market");
    }
  });

  it("defaults to crossing the spread", () => {
    expect(DEFAULT_AUTOPILOT.entryOrderType).toBe("market");
  });
});
