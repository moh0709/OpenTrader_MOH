/**
 * The learning loop.
 *
 * When a bot closes enough losing trades in a row, this writes a journal entry:
 * the deterministic record of what happened, an analysis of why, and a bounded
 * adjustment proposal. The operator applies or dismisses it from the dashboard —
 * nothing here touches a bot's settings on its own.
 *
 * The guardrails are the load-bearing part. A proposal may only touch keys in
 * GUARDRAILS and only within their bounds; apply clamps before writing. So even
 * a bad day for the analyser cannot raise a position cap to 10x.
 */
import { createReflector } from "@opentrader/ai-team";
import { xprisma } from "@opentrader/db";
import { logger } from "@opentrader/logger";

/** How many losses in a row trigger a post-mortem. */
export const LOSS_STREAK_THRESHOLD = 3;

/** How often the sweep looks for new streaks. */
const EVALUATE_INTERVAL_MS = 15 * 60 * 1000;

/** Closed cycles examined per bot when scoring a streak. */
const SAMPLE_SIZE = 20;

/**
 * What a proposal may touch, and how far. Bounds are absolute, not relative —
 * a value that would exceed them is clamped, not rejected, so an apply never
 * fails halfway through patching settings.
 */
const GUARDRAILS: Record<string, { min: number; max: number }> = {
  // Council confidence floor. Lowering it trades more (looser filter);
  // raising it trades less. Either direction is a legitimate lesson.
  minConfidence: { min: 0.3, max: 0.85 },
  // Per-position notional. Clamped well below the manual-lane hard limits.
  maxPositionQuote: { min: 10, max: 250 },
  // Minimum net arbitrage spread to act on.
  minNetSpreadBps: { min: 0, max: 100 },
};

type OrderRow = { entityType: string; status: string; price: number | null; quantity: number };
type TradeRow = { id: number; symbol: string; createdAt: Date; orders: OrderRow[] };

type Cycle = {
  symbol: string;
  pnl: number;
  entryPrice: number | null;
  exitPrice: number | null;
  closedAt: Date;
};

/** Reconstruct closed position cycles (filled entry + filled exit) from trade rows. */
function extractCycles(trades: TradeRow[]): Cycle[] {
  const cycles: Cycle[] = [];

  for (const trade of trades) {
    const entries = trade.orders.filter((o) => o.entityType === "EntryOrder" && o.status === "Filled");
    const exits = trade.orders.filter(
      (o) => ["TakeProfitOrder", "StopLossOrder"].includes(o.entityType) && o.status === "Filled",
    );
    if (entries.length === 0 || exits.length === 0) continue;

    const qtyIn = entries.reduce((sum, o) => sum + o.quantity, 0);
    const qtyOut = exits.reduce((sum, o) => sum + o.quantity, 0);
    const costIn = entries.reduce((sum, o) => sum + o.quantity * (o.price ?? 0), 0);
    const revenueOut = exits.reduce((sum, o) => sum + o.quantity * (o.price ?? 0), 0);

    cycles.push({
      symbol: trade.symbol,
      pnl: revenueOut - costIn,
      entryPrice: costIn / qtyIn,
      exitPrice: qtyOut > 0 ? revenueOut / qtyOut : null,
      closedAt: trade.createdAt,
    });
  }

  return cycles.sort((a, b) => b.closedAt.getTime() - a.closedAt.getTime());
}

/** Heuristic narrative, used whenever no reflector model answered. */
function heuristicAnalysis(cycles: Cycle[]): string {
  const losses = cycles.filter((c) => c.pnl < 0);
  const avgLoss = losses.reduce((sum, c) => sum + c.pnl, 0) / (losses.length || 1);
  const soldIntoFalls =
    losses.length >= 2 &&
    losses.every((c) => c.exitPrice !== null && c.entryPrice !== null && c.exitPrice < c.entryPrice);

  return [
    `${losses.length} consecutive losing cycles, averaging ${avgLoss.toFixed(2)} quote each.`,
    soldIntoFalls
      ? "Every loss exited below its entry: these were longs sold into falling prices, which reads as buying dips that kept dipping rather than failed timing."
      : "The losses do not share one obvious shape; examine entries against trend before blaming exits.",
    `Sample is small (${cycles.length} cycles). Treat any change as provisional and watch the next few cycles closely.`,
  ].join(" ");
}

/** Deterministic proposal: the conservative lesson a loss streak teaches. */
function heuristicProposal(): Record<string, number> {
  return { minConfidence: 0.65 };
}

export type EvaluateResult = { evaluated: number; created: number };

/**
 * Score every bot with closed trades; write a journal entry for any bot whose
 * current streak meets the threshold and which has no open proposal yet.
 */
export async function evaluateLearning(ownerId: number): Promise<EvaluateResult> {
  const bots = (await xprisma.bot.findMany({
    where: { ownerId },
    select: { id: true, name: true, symbol: true },
  })) as { id: number; name: string; symbol: string }[];

  let created = 0;

  for (const bot of bots) {
    try {
      const trades = (await xprisma.smartTrade.findMany({
        where: { botId: bot.id, ownerId },
        include: { orders: true },
        orderBy: { createdAt: "desc" },
        take: SAMPLE_SIZE,
      })) as unknown as TradeRow[];

      const cycles = extractCycles(trades);

      // Count the streak at the head of the history only.
      let streak = 0;
      for (const cycle of cycles) {
        if (cycle.pnl < 0) streak += 1;
        else break;
      }

      if (streak < LOSS_STREAK_THRESHOLD) continue;

      const open = await xprisma.learningJournal.findFirst({ where: { botId: bot.id, status: "proposed" } });
      if (open) continue;

      const streakCycles = cycles.slice(0, streak);
      const stats = {
        sampleSize: cycles.length,
        streak,
        losses: streakCycles.map((c) => ({
          symbol: c.symbol,
          pnl: Number(c.pnl.toFixed(2)),
          entryPrice: c.entryPrice !== null ? Number(c.entryPrice.toFixed(2)) : null,
          exitPrice: c.exitPrice !== null ? Number(c.exitPrice.toFixed(2)) : null,
          closedAt: c.closedAt.toISOString(),
        })),
      };

      const prompt = [
        `Bot "${bot.name}" trading ${bot.symbol} has lost its last ${streak} cycles in a row.`,
        "The deterministic record (most recent first):",
        ...stats.losses.map((l) => `- ${l.closedAt}: entry ${l.entryPrice}, exit ${l.exitPrice}, P&L ${l.pnl}`),
        "Write the post-mortem.",
      ].join("\n");

      const reflect = createReflector();
      const analysis = (await reflect?.(prompt)) ?? heuristicAnalysis(streakCycles);

      await xprisma.learningJournal.create({
        data: {
          botId: bot.id,
          botName: bot.name,
          symbol: bot.symbol,
          trigger: "loss_streak",
          lossStreak: streak,
          stats: JSON.stringify(stats),
          analysis,
          proposal: JSON.stringify(heuristicProposal()),
          status: "proposed",
          model: reflect ? "claude" : null,
        },
      });

      created += 1;
      logger.info(`[Learning] Bot ${bot.id} (${bot.name}): loss streak of ${streak} recorded, proposal opened.`);
    } catch (error) {
      logger.warn(`[Learning] Could not evaluate bot ${bot.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { evaluated: bots.length, created };
}

/** Clamp a proposed value into its guardrail band; unknown keys are refused. */
function clampProposal(proposal: Record<string, unknown>): Record<string, number> {
  const applied: Record<string, number> = {};

  for (const [key, raw] of Object.entries(proposal)) {
    const guard = GUARDRAILS[key];
    if (!guard) throw new Error(`Proposal key "${key}" is not adjustable`);

    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : NaN;
    if (Number.isNaN(value)) throw new Error(`Proposal value for "${key}" is not a number`);

    applied[key] = Math.min(guard.max, Math.max(guard.min, value));
  }

  if (Object.keys(applied).length === 0) throw new Error("Proposal is empty");
  return applied;
}

/** Apply a proposal to the bot's template settings, snapshotting what was there. */
export async function applyLearning(entryId: number, ownerId: number): Promise<ApplyResult> {
  const entry = (await xprisma.learningJournal.findUnique({ where: { id: entryId } })) as
    | { id: number; botId: number; status: string; proposal: string; stats: string }
    | null;
  if (!entry) throw new Error(`No journal entry ${entryId}`);
  if (entry.status !== "proposed") throw new Error(`Entry ${entryId} is already ${entry.status}`);

  const applied = clampProposal(JSON.parse(entry.proposal));

  const bot = (await xprisma.bot.findFirst({ where: { id: entry.botId, ownerId }, select: { settings: true } })) as
    | { settings: string }
    | null;
  if (!bot) throw new Error(`Bot ${entry.botId} not found`);

  const settings = JSON.parse(bot.settings || "{}") as Record<string, unknown>;
  const previous: Record<string, unknown> = {};
  for (const key of Object.keys(applied)) previous[key] = settings[key] ?? null;

  await xprisma.bot.update({
    where: { id: entry.botId },
    data: { settings: JSON.stringify({ ...settings, ...applied }) },
  });

  await xprisma.learningJournal.update({
    where: { id: entryId },
    data: {
      status: "applied",
      resolvedAt: new Date(),
      stats: JSON.stringify({ ...JSON.parse(entry.stats), previousSettings: previous }),
    },
  });

  logger.info(`[Learning] Entry ${entryId} applied to bot ${entry.botId}: ${JSON.stringify(applied)}`);
  return { id: entryId, applied };
}

/** Undo an applied entry by restoring the snapshot taken at apply time. */
export async function revertLearning(entryId: number, ownerId: number): Promise<{ id: number }> {
  const entry = (await xprisma.learningJournal.findUnique({ where: { id: entryId } })) as
    | { id: number; botId: number; status: string; stats: string }
    | null;
  if (!entry) throw new Error(`No journal entry ${entryId}`);
  if (entry.status !== "applied") throw new Error(`Only applied entries can be reverted (this one is ${entry.status})`);

  const previous = (JSON.parse(entry.stats) as { previousSettings?: Record<string, unknown> }).previousSettings;
  if (!previous) throw new Error(`Entry ${entryId} has no settings snapshot to revert to`);

  const bot = (await xprisma.bot.findFirst({ where: { id: entry.botId, ownerId }, select: { settings: true } })) as
    | { settings: string }
    | null;
  if (!bot) throw new Error(`Bot ${entry.botId} not found`);

  const settings = JSON.parse(bot.settings || "{}") as Record<string, unknown>;
  for (const [key, value] of Object.entries(previous)) {
    if (value === null) delete settings[key];
    else settings[key] = value;
  }

  await xprisma.bot.update({ where: { id: entry.botId }, data: { settings: JSON.stringify(settings) } });
  await xprisma.learningJournal.update({ where: { id: entryId }, data: { status: "reverted", resolvedAt: new Date() } });

  logger.info(`[Learning] Entry ${entryId} reverted for bot ${entry.botId}.`);
  return { id: entryId };
}

export async function dismissLearning(entryId: number): Promise<{ id: number }> {
  const entry = (await xprisma.learningJournal.findUnique({ where: { id: entryId } })) as { status: string } | null;
  if (!entry) throw new Error(`No journal entry ${entryId}`);
  if (entry.status !== "proposed") throw new Error(`Only proposed entries can be dismissed (this one is ${entry.status})`);

  await xprisma.learningJournal.update({ where: { id: entryId }, data: { status: "dismissed", resolvedAt: new Date() } });
  return { id: entryId };
}

/**
 * Periodic sweep. Deliberately its own timer, off the trading path: a slow
 * reflector call must never delay a candle close.
 */
export function startLearningLoop(ownerId: number) {
  const sweep = () =>
    void evaluateLearning(ownerId).catch((error) =>
      logger.warn(`[Learning] Sweep failed: ${error instanceof Error ? error.message : String(error)}`),
    );

  void sweep();
  const timer = setInterval(sweep, EVALUATE_INTERVAL_MS);
  timer.unref?.();

  return () => clearInterval(timer);
}
