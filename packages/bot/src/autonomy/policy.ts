import { DEFAULT_HEAD_LIMITS, type HeadLimits } from "@opentrader/ai-team";
import { xprisma } from "@opentrader/db";
import { logger } from "@opentrader/logger";
import type { BarSize } from "@opentrader/types";

/**
 * The trading head's standing orders.
 *
 * Held in the database rather than the environment for one reason: these are
 * numbers an operator changes while watching the desk, and a limit that needs a
 * redeploy to move is a limit nobody adjusts. The row is a singleton, seeded on
 * first read with the conservative defaults from `@opentrader/ai-team`.
 */

/** The singleton row. */
const POLICY_ID = 1;

export type AutopilotMode = "observe" | "live";

export type AutopilotConfig = {
  enabled: boolean;
  /**
   * `observe` runs the whole round and places nothing.
   *
   * This is the default, and it is not a token gesture: the head still gathers,
   * deliberates, plans and journals, so an operator can read a day of what it
   * would have done before letting it do any of it.
   */
  mode: AutopilotMode;
  symbols: string[];
  /** The bot whose exchange account and owner the head trades through. */
  botId: number | null;
  intervalMs: number;
  timeframe: BarSize;
  limits: HeadLimits;
};

export const DEFAULT_AUTOPILOT: AutopilotConfig = {
  enabled: false,
  mode: "observe",
  symbols: [],
  botId: null,
  intervalMs: 60_000,
  timeframe: "1h",
  limits: DEFAULT_HEAD_LIMITS,
};

type PolicyRow = {
  enabled: boolean;
  mode: string;
  symbols: string;
  botId: number | null;
  intervalSec: number;
  timeframe: string;
  equityQuote: number;
  maxPositionQuote: number;
  maxTotalExposureQuote: number;
  maxOpenPositions: number;
  maxDailyOpenNotionalQuote: number;
  maxDailyLossQuote: number;
  maxConsecutiveLosses: number;
  minConfidence: number;
  minExitConfidence: number;
  minNetProfitQuote: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  trailStartPercent: number;
  trailGivebackPercent: number;
  minHoldMs: number;
  cooldownMs: number;
  maxHoldMs: number;
  roundTripFeeBps: number;
  regimeFilterPeriod: number;
  allowPyramiding: boolean;
  killSwitch: boolean;
};

/** Every bar size the exchanges understand, so a bad string cannot reach ccxt. */
const BAR_SIZES: readonly string[] = ["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M", "3M"];

/** Parse the stored watchlist, tolerating anything that is not a JSON array of strings. */
export function parseSymbols(raw: string | null | undefined): string[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return [...new Set(parsed.filter((value): value is string => typeof value === "string" && value.trim() !== ""))];
  } catch {
    return [];
  }
}

export function toConfig(row: PolicyRow): AutopilotConfig {
  return {
    enabled: row.enabled,
    // Anything that is not exactly "live" means observe. A typo in this column
    // must not be the thing that starts trading real money.
    mode: row.mode === "live" ? "live" : "observe",
    symbols: parseSymbols(row.symbols),
    botId: row.botId,
    // Floored at ten seconds. Faster than that is not more informed, it is just
    // more requests at the exchange and the vendors.
    intervalMs: Math.max(10, row.intervalSec) * 1000,
    timeframe: (BAR_SIZES.includes(row.timeframe) ? row.timeframe : DEFAULT_AUTOPILOT.timeframe) as BarSize,
    limits: {
      equityQuote: row.equityQuote,
      maxPositionQuote: row.maxPositionQuote,
      maxTotalExposureQuote: row.maxTotalExposureQuote,
      maxOpenPositions: row.maxOpenPositions,
      maxDailyOpenNotionalQuote: row.maxDailyOpenNotionalQuote,
      maxDailyLossQuote: row.maxDailyLossQuote,
      maxConsecutiveLosses: row.maxConsecutiveLosses,
      minConfidence: row.minConfidence,
      minExitConfidence: row.minExitConfidence,
      minNetProfitQuote: row.minNetProfitQuote,
      takeProfitPercent: row.takeProfitPercent,
      stopLossPercent: row.stopLossPercent,
      trailStartPercent: row.trailStartPercent,
      trailGivebackPercent: row.trailGivebackPercent,
      minHoldMs: row.minHoldMs,
      cooldownMs: row.cooldownMs,
      maxHoldMs: row.maxHoldMs,
      roundTripFeeBps: row.roundTripFeeBps,
      regimeFilterPeriod: row.regimeFilterPeriod,
      allowPyramiding: row.allowPyramiding,
      killSwitch: row.killSwitch,
    },
  };
}

/** Said once, not on every poll: an unreadable policy would otherwise log every minute. */
let warnedUnreadable = false;

function warnUnreadable(error: unknown): null {
  if (!warnedUnreadable) {
    warnedUnreadable = true;
    logger.warn(
      `[Head] Autopilot policy unavailable (${error instanceof Error ? error.message : String(error)}). ` +
        "If the table is missing, run `prisma db push`. The trading head will not run until this is fixed.",
    );
  }

  return null;
}

/**
 * Read the standing orders, seeding the row on first use.
 *
 * Returns null when the policy cannot be read at all — most often an install
 * that has not run `prisma db push` since this shipped. The head then does not
 * run, which is the correct behaviour: no configuration means no mandate.
 *
 * The seed is deliberately tolerant of losing a race. Two callers can arrive
 * here at the same instant on a cold start — the loop's first pass and whatever
 * else asks for the policy while it is in flight — and only one of them may win
 * a primary key. Reporting the loser's unique-constraint failure as "the table
 * is missing" is how a correctly-migrated production install came up with the
 * head switched off and a misleading line in the log telling the operator to
 * run a migration that had already run.
 */
export async function loadAutopilotPolicy(): Promise<AutopilotConfig | null> {
  const read = async (): Promise<PolicyRow | null> =>
    (await xprisma.autopilotPolicy.findUnique({ where: { id: POLICY_ID } })) as PolicyRow | null;

  try {
    const existing = await read();
    if (existing) return toConfig(existing);
  } catch (error) {
    return warnUnreadable(error);
  }

  try {
    const created = (await xprisma.autopilotPolicy.create({ data: { id: POLICY_ID } })) as PolicyRow;
    logger.info("[Head] Seeded autopilot policy with conservative defaults; it is disabled until armed.");

    return toConfig(created);
  } catch (error) {
    // Someone else seeded it between our read and our write. That is a success
    // for the caller, not a failure — the row they wanted now exists.
    const raced = await read().catch(() => null);
    if (raced) return toConfig(raced);

    return warnUnreadable(error);
  }
}

/** What an operator is allowed to change, and the bounds it is clamped into. */
export const NUMERIC_BOUNDS: Record<string, { min: number; max: number }> = {
  intervalSec: { min: 10, max: 86_400 },
  equityQuote: { min: 0, max: 10_000_000 },
  maxPositionQuote: { min: 1, max: 100_000 },
  maxTotalExposureQuote: { min: 1, max: 1_000_000 },
  maxOpenPositions: { min: 1, max: 50 },
  maxDailyOpenNotionalQuote: { min: 1, max: 1_000_000 },
  maxDailyLossQuote: { min: 1, max: 1_000_000 },
  maxConsecutiveLosses: { min: 1, max: 50 },
  minConfidence: { min: 0.1, max: 1 },
  minExitConfidence: { min: 0.1, max: 1 },
  /*
   * Zero is allowed, and means "no floor" rather than a broken setting.
   * `minTicketQuote` returns 0 for it, so an operator who wants the old
   * percentage-only behaviour can have it deliberately rather than by accident.
   */
  minNetProfitQuote: { min: 0, max: 100_000 },
  takeProfitPercent: { min: 0.1, max: 100 },
  stopLossPercent: { min: 0.1, max: 100 },
  trailStartPercent: { min: 0.1, max: 100 },
  trailGivebackPercent: { min: 0.05, max: 100 },
  /*
   * These three are stored in `Int` columns, and Prisma's `Int` is 32-bit
   * however roomy SQLite's own integers are. 30 days in milliseconds is
   * 2,592,000,000 — past the 2,147,483,647 ceiling — so the old bounds let a
   * clamp produce a value the write then threw on. Capped just under the limit
   * instead, which is a little over 23 days and far longer than any of these
   * has a sensible reason to be.
   */
  minHoldMs: { min: 0, max: 2_000_000_000 },
  cooldownMs: { min: 0, max: 2_000_000_000 },
  maxHoldMs: { min: 60_000, max: 2_000_000_000 },
  roundTripFeeBps: { min: 0, max: 500 },
  /** Zero disables the filter. 500 is longer than any warm-up the head fetches. */
  regimeFilterPeriod: { min: 0, max: 500 },
};

const BOOLEAN_KEYS = ["enabled", "allowPyramiding", "killSwitch"] as const;

export type PolicyPatch = Record<string, unknown>;

/**
 * Apply an operator's change.
 *
 * Numbers are clamped into their bounds rather than refused, so a fat-fingered
 * limit becomes a sane one instead of a failed request that leaves the head on
 * its old settings without anyone noticing. Unknown keys are ignored.
 */
export async function saveAutopilotPolicy(patch: PolicyPatch): Promise<AutopilotConfig> {
  const data: Record<string, unknown> = {};

  for (const [key, bound] of Object.entries(NUMERIC_BOUNDS)) {
    const raw = patch[key];
    if (raw === undefined || raw === null || raw === "") continue;

    const value = Number(raw);
    if (!Number.isFinite(value)) continue;

    const clamped = Math.min(bound.max, Math.max(bound.min, value));
    // Integer columns must not receive a fraction, and Prisma will not coerce.
    data[key] = [
      "intervalSec",
      "maxOpenPositions",
      "maxConsecutiveLosses",
      "minHoldMs",
      "cooldownMs",
      "maxHoldMs",
      "regimeFilterPeriod",
    ].includes(key)
      ? Math.round(clamped)
      : clamped;
  }

  for (const key of BOOLEAN_KEYS) {
    if (patch[key] !== undefined) data[key] = patch[key] === true || patch[key] === "true";
  }

  if (patch.mode !== undefined) data.mode = patch.mode === "live" ? "live" : "observe";

  if (patch.symbols !== undefined) {
    const symbols = Array.isArray(patch.symbols)
      ? patch.symbols.filter((s): s is string => typeof s === "string")
      : parseSymbols(typeof patch.symbols === "string" ? patch.symbols : null);

    data.symbols = JSON.stringify([...new Set(symbols.map((s) => s.trim()).filter(Boolean))]);
  }

  if (patch.botId !== undefined) {
    const botId = Number(patch.botId);
    data.botId = Number.isInteger(botId) && botId > 0 ? botId : null;
  }

  if (patch.timeframe !== undefined && BAR_SIZES.includes(String(patch.timeframe))) {
    data.timeframe = String(patch.timeframe);
  }

  const row = (await xprisma.autopilotPolicy.upsert({
    where: { id: POLICY_ID },
    create: { id: POLICY_ID, ...data },
    update: data,
  })) as PolicyRow;

  return toConfig(row);
}
