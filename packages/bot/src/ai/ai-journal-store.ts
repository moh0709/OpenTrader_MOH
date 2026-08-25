/**
 * Durable backing for the AI action feed.
 *
 * The feed itself is a 500-entry ring in `@opentrader/ai-team`, which is what
 * makes it instant and free to read. Its one weakness is that it empties on
 * every restart — and a daemon restarts on every deploy, so the action window
 * and the news lane went blank exactly when an operator most wants to see what
 * happened either side of a release.
 *
 * This writes the same records through to the database and reads the recent
 * ones back at boot.
 *
 * **Every path here is best-effort.** The table is applied with `prisma db push`
 * like the other recent models in this fork, so an install that has not been
 * pushed yet simply does not have it. A missing table, a locked database, a
 * malformed row — none of them may disturb the ring, and none of them may
 * surface to the trading loop that wrote the entry. The ring stays the source
 * of truth; this is a convenience on top of it.
 */
import { aiActivity, type AiActionRecord } from "@opentrader/ai-team";
import { xprisma } from "@opentrader/db";
import { logger } from "@opentrader/logger";

/** How many past actions to bring back at boot. Matches the ring's own size. */
const HYDRATE_LIMIT = 500;

/** Rows older than this are pruned, so the table does not grow without end. */
const RETENTION_DAYS = 30;

type AiActionRow = {
  at: bigint;
  chip: string;
  severity: string;
  botId: number | null;
  botName: string | null;
  symbol: string | null;
  smartTradeId: number | null;
  title: string;
  detail: string;
  target: string;
  autonomous: boolean;
};

/**
 * Whether the table is there.
 *
 * Checked once and remembered: an install without it would otherwise pay a
 * failed query for every council tick, and log a failure for each one.
 */
let available: boolean | null = null;

function unavailable(operation: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  if (available !== false) {
    logger.warn(
      `[AI] Action history is not being saved (${operation}: ${message}). The live feed still works; it will start empty after a restart. Run 'prisma db push' to create the AiAction table.`,
    );
  }

  available = false;
}

function toRecord(row: AiActionRow): Omit<AiActionRecord, "seq" | "id"> {
  let target: AiActionRecord["target"] = {};
  try {
    const parsed = JSON.parse(row.target) as unknown;
    if (parsed && typeof parsed === "object") target = parsed as AiActionRecord["target"];
  } catch {
    // A malformed target costs the bubble its aim, not the entry its place.
  }

  return {
    at: Number(row.at),
    chip: row.chip as AiActionRecord["chip"],
    severity: row.severity as AiActionRecord["severity"],
    botId: row.botId,
    botName: row.botName,
    symbol: row.symbol,
    smartTradeId: row.smartTradeId,
    title: row.title,
    detail: row.detail,
    target,
    autonomous: row.autonomous,
  };
}

/**
 * Load recent history into the ring, then keep writing new entries through.
 *
 * Returns a function that stops the writing, for shutdown. Safe to call when
 * the table does not exist: it says so once and leaves the feed ring-only.
 */
export async function startAiJournalStore(): Promise<() => void> {
  try {
    const rows = (await xprisma.aiAction.findMany({
      orderBy: { at: "desc" },
      take: HYDRATE_LIMIT,
    })) as AiActionRow[];

    available = true;

    // Oldest first: `hydrate` appends, and the feed reads in the order things
    // happened.
    aiActivity.hydrate(rows.reverse().map(toRecord));

    if (rows.length > 0) logger.info(`[AI] Restored ${rows.length} past actions into the feed`);

    void prune();
  } catch (error) {
    unavailable("loading history", error);
  }

  return aiActivity.subscribe((entry) => {
    if (available === false) return;

    // Deliberately not awaited. This runs inside the strategy's tick, and a
    // write that blocked a candle close would be a far worse bug than a lost
    // row in a convenience table.
    void xprisma.aiAction
      .create({
        data: {
          at: BigInt(entry.at),
          chip: entry.chip,
          severity: entry.severity,
          botId: entry.botId,
          botName: entry.botName,
          symbol: entry.symbol,
          smartTradeId: entry.smartTradeId,
          title: entry.title,
          detail: entry.detail,
          target: JSON.stringify(entry.target),
          autonomous: entry.autonomous,
        },
      })
      .catch((error: unknown) => unavailable("saving an action", error));
  });
}

/** Drop rows past the retention window. The table is append-only otherwise. */
async function prune() {
  const cutoff = BigInt(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  try {
    const { count } = await xprisma.aiAction.deleteMany({ where: { at: { lt: cutoff } } });
    if (count > 0) logger.info(`[AI] Pruned ${count} action records older than ${RETENTION_DAYS} days`);
  } catch {
    // Pruning is housekeeping. Failing to tidy is not worth a warning.
  }
}
