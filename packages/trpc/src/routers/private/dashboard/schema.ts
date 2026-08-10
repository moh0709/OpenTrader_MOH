import { z } from "zod";

export const ZLeaderboardMetric = z.enum(["netPnl", "pnlPercent", "trades", "winRate", "averagePnl", "pnlPerHour"]);

export const ZBucketSize = z.enum(["5m", "15m", "1h", "4h", "1d"]);

export const ZDashboardSnapshotSchema = z.object({
  metric: ZLeaderboardMetric.optional(),
  recentTradeLimit: z.number().int().min(0).max(200).optional(),
});
export type TDashboardSnapshotSchema = z.infer<typeof ZDashboardSnapshotSchema>;

export const ZDashboardTradesSchema = z.object({
  botId: z.number().int().optional(),
  symbol: z.string().optional(),
  outcome: z.enum(["win", "loss", "breakeven"]).optional(),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  sort: z.enum(["exitAt", "netPnl", "pnlPercent", "holdMs"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});
export type TDashboardTradesSchema = z.infer<typeof ZDashboardTradesSchema>;

export const ZDashboardPositionsSchema = z.object({
  botId: z.number().int().optional(),
  state: z.enum(["live", "abandoned", "missing"]).optional(),
  includePending: z.boolean().optional(),
});
export type TDashboardPositionsSchema = z.infer<typeof ZDashboardPositionsSchema>;

export const ZDashboardGridSchema = z.object({
  botId: z.number().int().optional(),
});
export type TDashboardGridSchema = z.infer<typeof ZDashboardGridSchema>;

export const ZDashboardHistorySchema = z.object({
  botId: z.number().int().optional(),
  bucket: ZBucketSize.optional(),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
});
export type TDashboardHistorySchema = z.infer<typeof ZDashboardHistorySchema>;

export const ZDashboardEventsSchema = z.object({
  /**
   * Epoch ms of the newest event already seen. Zero asks for the current cursor
   * without any events, so a first load does not replay history as toasts.
   */
  since: z.number().int().min(0),
  limit: z.number().int().min(1).max(200).optional(),
});
export type TDashboardEventsSchema = z.infer<typeof ZDashboardEventsSchema>;

export const ZDashboardLogsSchema = z.object({
  botId: z.number().int().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type TDashboardLogsSchema = z.infer<typeof ZDashboardLogsSchema>;
