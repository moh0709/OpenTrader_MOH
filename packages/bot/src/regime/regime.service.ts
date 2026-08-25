import { logger } from "@opentrader/logger";
import { xprisma } from "@opentrader/db";
import { recordAiAction } from "@opentrader/ai-team";
import {
  applyRegimeGovernor,
  describeRegimeDecision,
  fetchLatestConvictions,
  type Conviction,
  type RegimePolicy,
} from "@opentrader/regime";
import { setBotLimits } from "../processing/executors/purge-bot.js";

/**
 * The bridge between the research council and the bots.
 *
 * Polls the research service, mirrors what it finds, and asks the governor what
 * each managed bot's capital cap should be. The governor can only ever reduce
 * below the operator's baseline, so the worst this loop can do is leave capital
 * idle — it has no path to committing more of it.
 *
 * Runs on a timer rather than a subscription for the same reason the research
 * service runs twice a day: a conviction is a standing view, not an event. If
 * the service is unreachable the poll is a no-op and the last conviction stands
 * until it goes stale, at which point every bot reverts to baseline.
 */

/** The council reports twice a day; polling faster than this buys nothing. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** The dashboard runs as the single local user, matching the tRPC context. */
const OWNER_ID = 1;

/** Don't rewrite a cap for a rounding-level difference. */
const CAP_EPSILON = 0.005;

type ManagedBot = {
  id: number;
  name: string;
  symbol: string;
  maxCapital: number | null;
};

type PolicyRow = {
  botId: number;
  baselineMaxCapital: number | null;
  baselineMinProfit: number | null;
  armed: boolean;
  floorFactor: number;
  maxAgeMs: number;
};

export type RegimeSyncResult = {
  polled: number;
  changed: number;
  unreachable: boolean;
};

function toPolicy(row: PolicyRow): RegimePolicy {
  return {
    botId: row.botId,
    baselineMaxCapital: row.baselineMaxCapital,
    baselineMinProfit: row.baselineMinProfit,
    armed: row.armed,
    floorFactor: row.floorFactor,
    maxAgeMs: row.maxAgeMs,
  };
}

/**
 * Mirror the latest conviction per symbol into the local database.
 *
 * The dashboard reads the mirror rather than the service, so it can still show
 * the last known view — and how old it is — while the service is down.
 */
export async function mirrorConvictions(symbols: string[]): Promise<Map<string, Conviction>> {
  const convictions = await fetchLatestConvictions(symbols);

  for (const conviction of convictions.values()) {
    const existing = (await xprisma.regimeConviction.findFirst({
      where: { symbol: conviction.symbol },
      orderBy: { asOf: "desc" },
    })) as { asOf: bigint } | null;

    // Only the newest reading is worth storing; re-storing the same one on
    // every poll would turn a twice-daily table into a per-5-minute one.
    if (existing && existing.asOf >= BigInt(conviction.asOf)) continue;

    await xprisma.regimeConviction.create({
      data: {
        symbol: conviction.symbol,
        stance: conviction.stance,
        confidence: conviction.confidence,
        asOf: BigInt(conviction.asOf),
        summary: conviction.summary,
        model: conviction.model ?? null,
        costUsd: conviction.costUsd ?? null,
      },
    });

    logger.info(`[Regime] New conviction for ${conviction.symbol}: ${conviction.stance} @ ${conviction.confidence.toFixed(2)}`);

    recordAiAction({
      chip: "analysis",
      title: `Council reads ${conviction.symbol}`,
      detail: `${conviction.stance.replace(/_/g, " ")} at ${Math.round(conviction.confidence * 100)}% confidence. ${conviction.summary}`,
      symbol: conviction.symbol,
    });
  }

  return convictions;
}

/**
 * Read the newest mirrored conviction per symbol.
 *
 * Used when the service is unreachable so a transient outage doesn't
 * immediately drop every bot back to baseline — the staleness guard in the
 * governor is what eventually does that, on its own schedule.
 */
async function mirroredConvictions(symbols: string[]): Promise<Map<string, Conviction>> {
  const out = new Map<string, Conviction>();

  for (const symbol of symbols) {
    const row = (await xprisma.regimeConviction.findFirst({
      where: { symbol },
      orderBy: { asOf: "desc" },
    })) as
      | { symbol: string; stance: string; confidence: number; asOf: bigint; summary: string; model: string | null; costUsd: number | null }
      | null;

    if (!row) continue;

    out.set(symbol, {
      symbol: row.symbol,
      stance: row.stance as Conviction["stance"],
      confidence: row.confidence,
      asOf: Number(row.asOf),
      summary: row.summary,
      model: row.model ?? undefined,
      costUsd: row.costUsd ?? undefined,
    });
  }

  return out;
}

/**
 * One pass: refresh convictions, then reconcile every managed bot's cap.
 *
 * Exported so the API can trigger it and get the result, rather than the
 * operator having to wait out the poll interval to see an effect.
 */
export async function syncRegime(): Promise<RegimeSyncResult> {
  const policies = (await xprisma.regimePolicy.findMany()) as PolicyRow[];
  if (policies.length === 0) return { polled: 0, changed: 0, unreachable: false };

  const bots = (await xprisma.bot.findMany({
    where: { id: { in: policies.map((p) => p.botId) } },
    select: { id: true, name: true, symbol: true, maxCapital: true },
  })) as ManagedBot[];

  const symbols = [...new Set(bots.map((b) => b.symbol))];

  let convictions = await mirrorConvictions(symbols);
  const unreachable = convictions.size === 0;
  if (unreachable) convictions = await mirroredConvictions(symbols);

  const now = Date.now();
  let changed = 0;

  for (const bot of bots) {
    const policy = policies.find((p) => p.botId === bot.id);
    if (!policy) continue;

    const decision = applyRegimeGovernor(toPolicy(policy), convictions.get(bot.symbol) ?? null, now);

    const target = decision.maxCapital;
    const current = bot.maxCapital;

    const same =
      (target === null && current === null) ||
      (target !== null && current !== null && Math.abs(target - current) < CAP_EPSILON);

    if (same) continue;

    // The one write this whole layer makes, through the same path the operator
    // and the dashboard use — so it is rate limited, audited, and visible in
    // the event feed like any other control action.
    await setBotLimits(bot.id, OWNER_ID, { maxCapital: target ?? 0 });
    changed += 1;

    logger.info(`[Regime] ${describeRegimeDecision(decision, bot.name)}`);

    const conviction = convictions.get(bot.symbol);
    const direction = decision.reduced ? "cut" : "restored";

    recordAiAction({
      chip: "cap",
      severity: decision.reduced ? "warning" : "info",
      title: `Cap ${direction} on ${bot.name}`,
      detail: conviction
        ? `Now ${(target ?? 0).toFixed(2)} — council is ${conviction.stance.replace(/_/g, " ")} on ${bot.symbol}.`
        : `Now ${(target ?? 0).toFixed(2)} — ${decision.notes[decision.notes.length - 1] ?? "back to your baseline"}.`,
      botId: bot.id,
      botName: bot.name,
      symbol: bot.symbol,
    });
  }

  return { polled: bots.length, changed, unreachable };
}

/**
 * Restore every managed bot to its operator baseline, immediately.
 *
 * The disarm switch. Sets `armed = false` so the next poll cannot undo it, then
 * writes the baselines back rather than waiting for the poll to notice.
 */
export async function disarmRegime(): Promise<{ restored: number }> {
  await xprisma.regimePolicy.updateMany({ data: { armed: false } });

  const policies = (await xprisma.regimePolicy.findMany()) as PolicyRow[];
  let restored = 0;

  for (const policy of policies) {
    if (policy.baselineMaxCapital === null) continue;
    await setBotLimits(policy.botId, OWNER_ID, { maxCapital: policy.baselineMaxCapital });
    restored += 1;
  }

  logger.warn(`[Regime] Disarmed. Restored ${restored} bots to their baseline caps.`);

  recordAiAction({
    chip: "settings",
    severity: "warning",
    title: "Regime governor disarmed",
    detail: `${restored} bot${restored === 1 ? "" : "s"} put back on your baseline cap. Convictions no longer move capital.`,
  });

  return { restored };
}

export class RegimeService {
  private timer: NodeJS.Timeout | null = null;

  start() {
    const tick = async () => {
      try {
        const result = await syncRegime();
        if (result.changed > 0) {
          logger.info(`[Regime] Reconciled ${result.polled} bots, ${result.changed} cap changes`);
        }
      } catch (err) {
        // A failure here must never take the daemon down — the bots keep
        // trading on whatever caps they currently hold, which are by
        // construction no higher than the operator's baseline.
        logger.warn(`[Regime] Sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    void tick();
    this.timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    // Never hold the process open just for the regime poll.
    this.timer.unref?.();

    logger.info(`[Regime] Governor polling every ${POLL_INTERVAL_MS / 60000} min`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
