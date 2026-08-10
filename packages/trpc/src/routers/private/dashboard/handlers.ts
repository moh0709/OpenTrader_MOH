/**
 * Dashboard query handlers.
 *
 * These are kept together rather than split one folder per procedure, as the
 * rest of the router tree is, because every one of them is a projection of the
 * same derived analytics pass - reading them side by side is what makes that
 * relationship legible. The work itself lives in `services/dashboard.service`
 * (I/O and caching) and `services/dashboard-views` (assembly).
 */
import type { Context } from "../../../utils/context.js";
import { dashboardService } from "../../../services/dashboard.service.js";
import {
  buildEventsView,
  buildGridView,
  buildHealthView,
  buildHistoryView,
  buildPositionsView,
  buildSnapshot,
  buildTradesView,
  derive,
} from "../../../services/dashboard-views.js";
import type {
  TDashboardEventsSchema,
  TDashboardGridSchema,
  TDashboardHistorySchema,
  TDashboardLogsSchema,
  TDashboardPositionsSchema,
  TDashboardSnapshotSchema,
  TDashboardTradesSchema,
} from "./schema.js";

type User = NonNullable<Context["user"]>;
type Options<T> = { ctx: { user: User }; input: T };

const derived = async (user: User) => derive(await dashboardService.getContext(user.id));

export async function getSnapshot({ ctx, input }: Options<TDashboardSnapshotSchema>) {
  return buildSnapshot(await derived(ctx.user), input);
}

export async function getTrades({ ctx, input }: Options<TDashboardTradesSchema>) {
  return buildTradesView(await derived(ctx.user), input);
}

export async function getPositions({ ctx, input }: Options<TDashboardPositionsSchema>) {
  return buildPositionsView(await derived(ctx.user), input);
}

export async function getGrid({ ctx, input }: Options<TDashboardGridSchema>) {
  return buildGridView(await derived(ctx.user), input.botId);
}

export async function getHistory({ ctx, input }: Options<TDashboardHistorySchema>) {
  return buildHistoryView(await derived(ctx.user), input);
}

export async function getEvents({ ctx, input }: Options<TDashboardEventsSchema>) {
  const [context, logs] = await Promise.all([
    derived(ctx.user),
    // Only the window the caller has not seen yet needs loading.
    dashboardService.recentBotLogs(ctx.user.id, 100, input.since > 0 ? input.since : undefined),
  ]);

  return buildEventsView(context, logs, input.since, input.limit);
}

export async function getLogs({ ctx, input }: Options<TDashboardLogsSchema>) {
  const logs = await dashboardService.recentBotLogs(ctx.user.id, input.limit ?? 50);
  const context = await dashboardService.getContext(ctx.user.id);

  return {
    logs: logs
      .filter((log) => input.botId === undefined || log.botId === input.botId)
      .map((log) => ({
        id: log.id,
        botId: log.botId,
        botName: context.botNames.get(log.botId) ?? `Bot ${log.botId}`,
        action: log.action,
        triggerEventType: log.triggerEventType,
        // The stored error is JSON; surface it as text and let the UI decide.
        error: log.error && log.error !== "undefined" && log.error !== "null" ? log.error : null,
        createdAt: log.createdAt.getTime(),
      })),
  };
}

export async function getHealth({ ctx }: { ctx: { user: User } }) {
  const startedAt = Date.now();

  const [context, lastBotActivity] = await Promise.all([
    derived(ctx.user),
    dashboardService.lastBotActivity(ctx.user.id),
  ]);

  return buildHealthView({
    derived: context,
    database: dashboardService.getDatabaseStats(),
    databasePath: dashboardService.databaseFile(),
    process: dashboardService.processStats(),
    host: dashboardService.hostStats(),
    lastBotActivity,
    paperFillPatchApplied: dashboardService.hasPaperFillFix(),
    apiLatencyMs: Date.now() - startedAt,
  });
}
