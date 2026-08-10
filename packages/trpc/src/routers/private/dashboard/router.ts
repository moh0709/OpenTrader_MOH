import { router } from "../../../trpc.js";
import { authorizedProcedure } from "../../../procedures.js";
import { getEvents, getGrid, getHealth, getHistory, getLogs, getPositions, getSnapshot, getTrades } from "./handlers.js";
import {
  ZDashboardEventsSchema,
  ZDashboardGridSchema,
  ZDashboardHistorySchema,
  ZDashboardLogsSchema,
  ZDashboardPositionsSchema,
  ZDashboardSnapshotSchema,
  ZDashboardTradesSchema,
} from "./schema.js";

export const dashboardRouter = router({
  /** Compact fleet overview, polled on the dashboard refresh interval. */
  snapshot: authorizedProcedure.input(ZDashboardSnapshotSchema).query(getSnapshot),
  /** Closed round trips, filtered and paginated. */
  trades: authorizedProcedure.input(ZDashboardTradesSchema).query(getTrades),
  /** Open positions, abandoned positions and resting entries. */
  positions: authorizedProcedure.input(ZDashboardPositionsSchema).query(getPositions),
  /** Grid ladder state per bot. */
  grid: authorizedProcedure.input(ZDashboardGridSchema).query(getGrid),
  /** Equity curve and distributions. */
  history: authorizedProcedure.input(ZDashboardHistorySchema).query(getHistory),
  /** Events since a cursor, driving toasts and the live feed. */
  events: authorizedProcedure.input(ZDashboardEventsSchema).query(getEvents),
  /** Recent bot log entries. */
  logs: authorizedProcedure.input(ZDashboardLogsSchema).query(getLogs),
  /** Full health report. */
  health: authorizedProcedure.query(getHealth),
});
