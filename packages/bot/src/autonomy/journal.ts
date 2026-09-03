import type { HeadPlan } from "@opentrader/ai-team";
import { isEntry } from "@opentrader/ai-team";
import { xprisma } from "@opentrader/db";
import { logger } from "@opentrader/logger";
import type { AutopilotMode } from "./policy.js";

/**
 * The head's own record, and its memory.
 *
 * Every pass writes a row for every symbol, including the ones that resolved to
 * "hold". A log that only records trades hides the reasoning that mattered most
 * — why the desk stood still while the market moved — and that is exactly the
 * question an operator asks at the end of a flat week.
 *
 * It doubles as durable state. Cooldowns and the day's opening budget are read
 * back from here rather than held in the process, so a restart cannot hand the
 * head a fresh allowance or let it act twice on one idea.
 */

export type JournalEntry = {
  plan: HeadPlan;
  mode: AutopilotMode;
  executed: boolean;
  price: number;
  smartTradeId: number | null;
  /** The council's opinions and the outside readings, for the audit trail. */
  evidence: Record<string, unknown>;
};

let warnedMissingTable = false;

/** Complain about a missing table once, then stay quiet: this runs every minute. */
function warnOnce(error: unknown, what: string): void {
  if (warnedMissingTable) return;
  warnedMissingTable = true;

  logger.warn(`[Head] ${what} (${error instanceof Error ? error.message : String(error)}). Run \`prisma db push\`.`);
}

export async function recordDecision(entry: JournalEntry): Promise<number | null> {
  const { plan } = entry;

  try {
    const row = (await xprisma.autopilotJournal.create({
      data: {
        at: BigInt(Date.now()),
        symbol: plan.symbol,
        action: plan.action,
        mode: entry.mode,
        executed: entry.executed,
        confidence: plan.confidence,
        sizeQuote: isEntry(plan.action) ? plan.sizeQuote : null,
        quantity: plan.quantity > 0 ? plan.quantity : null,
        price: entry.price,
        netPnlQuote: plan.netPnlQuote,
        smartTradeId: entry.smartTradeId,
        reason: plan.reason,
        // Truncated at the source rather than in the reader: this column is
        // read back into a dashboard, and one runaway model rationale should
        // not make the whole journal expensive to page through.
        evidence: JSON.stringify(entry.evidence).slice(0, 8000),
      },
    })) as { id: number };

    return row.id;
  } catch (error) {
    warnOnce(error, "Could not write the autopilot journal");

    return null;
  }
}

/**
 * When the head last *acted* on a symbol.
 *
 * Only executed decisions count. A pass that decided to hold is not an action,
 * and letting it start a cooldown would mean the head talks itself out of
 * trading and then blocks itself from reconsidering.
 */
export async function lastActionAt(symbol: string): Promise<number | null> {
  try {
    const row = (await xprisma.autopilotJournal.findFirst({
      where: { symbol, executed: true },
      orderBy: { at: "desc" },
      select: { at: true },
    })) as { at: bigint } | null;

    return row ? Number(row.at) : null;
  } catch (error) {
    warnOnce(error, "Could not read the autopilot journal");

    return null;
  }
}

/**
 * Notional opened today by the head.
 *
 * Read from the journal rather than from the trades, because the budget should
 * be spent by the decision to open, not by whether the fill landed — otherwise
 * a run of entries that are still resting would look free.
 */
export async function openedNotionalToday(now = Date.now()): Promise<number> {
  const date = new Date(now);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

  try {
    const rows = (await xprisma.autopilotJournal.findMany({
      where: { executed: true, action: { in: ["open", "add"] }, at: { gte: BigInt(dayStart) } },
      select: { sizeQuote: true },
    })) as { sizeQuote: number | null }[];

    return rows.reduce((total, row) => total + (row.sizeQuote ?? 0), 0);
  } catch (error) {
    warnOnce(error, "Could not read the autopilot journal");

    return 0;
  }
}

/**
 * The last exit the head asked for on a given deal, if any.
 *
 * Read back rather than remembered because the loop restarts and an exit does
 * not: a position whose sell is still working must look the same to a daemon
 * that has been up for a week and one that came up ten seconds ago.
 */
export async function lastExitRequest(
  smartTradeId: number,
): Promise<{ at: number; action: string } | null> {
  try {
    const row = (await xprisma.autopilotJournal.findFirst({
      where: {
        smartTradeId,
        executed: true,
        action: { in: ["take_profit", "trail_exit", "stop_out", "close", "flatten"] },
      },
      orderBy: { at: "desc" },
      select: { at: true, action: true },
    })) as { at: bigint; action: string } | null;

    return row ? { at: Number(row.at), action: row.action } : null;
  } catch (error) {
    warnOnce(error, "Could not read the autopilot journal");

    return null;
  }
}

export type JournalRow = {
  id: number;
  at: number;
  symbol: string;
  action: string;
  mode: string;
  executed: boolean;
  confidence: number;
  sizeQuote: number | null;
  quantity: number | null;
  price: number | null;
  netPnlQuote: number | null;
  smartTradeId: number | null;
  reason: string;
};

/** The most recent decisions, newest first, for the dashboard. */
export async function recentDecisions(limit = 50, symbol?: string): Promise<JournalRow[]> {
  try {
    const rows = (await xprisma.autopilotJournal.findMany({
      where: symbol ? { symbol } : undefined,
      orderBy: { at: "desc" },
      take: Math.min(500, Math.max(1, limit)),
    })) as (Omit<JournalRow, "at"> & { at: bigint })[];

    return rows.map((row) => ({ ...row, at: Number(row.at) }));
  } catch (error) {
    warnOnce(error, "Could not read the autopilot journal");

    return [];
  }
}
