/**
 * Health checks for the OpenTrader install.
 *
 * Pure by design: the handler gathers the raw facts (process stats, disk, table
 * counts, ticker ages) and this decides what they mean. That keeps every
 * threshold unit testable, including the failure cases, which is the only way to
 * be confident a monitor will actually fire when it matters.
 */
import type { AnalyticsBot, AnalyticsTicker } from "./types.js";

export type HealthStatus = "ok" | "warn" | "crit" | "unknown";

export type HealthCheck = {
  id: string;
  group: string;
  label: string;
  status: HealthStatus;
  /** Short human-readable reading, e.g. "81%" or "3 stalled". */
  value: string | null;
  /** What it means and what to do about it, shown on expand. */
  detail: string | null;
  /** Numeric form of the reading, for sparklines and thresholds. */
  metric: number | null;
};

export type HealthReport = {
  status: HealthStatus;
  checkedAt: number;
  counts: Record<HealthStatus, number>;
  checks: HealthCheck[];
};

export type HealthThresholds = {
  /** Disk usage percent. */
  diskWarn: number;
  diskCrit: number;
  /** Memory usage percent. */
  memoryWarn: number;
  memoryCrit: number;
  /** Database file size in MB. */
  dbSizeWarn: number;
  dbSizeCrit: number;
  /** Share of the database taken by a single table, percent. */
  tableBloatWarn: number;
  tableBloatCrit: number;
  /**
   * Size in MB below which a dominant table is not worth mentioning.
   *
   * Share alone cannot tell you whether a table is a problem. Every young
   * install has one table holding most of a database that is a few megabytes
   * in total, which is not bloat, it is a database. Without a floor this check
   * pages the operator about 1 MB — and because it pages on the *set* of
   * failing checks, each change in that set counted as new and mailed again.
   */
  tableBloatFloorMb: number;
  /** Age in ms of our own last successful fetch before it counts as stale. */
  tickerFetchWarn: number;
  tickerFetchCrit: number;
  /** Age in ms of the exchange reading itself before marks stop being meaningful. */
  tickerReadingWarn: number;
  tickerReadingCrit: number;
  /** API round trip in ms. */
  apiLatencyWarn: number;
  apiLatencyCrit: number;
  /** Multiple of a bot timeframe without activity before it counts as stalled. */
  botStallFactor: number;
  /** Floor for the stall window, so a 1m bot is not flagged constantly. */
  botStallFloorMs: number;
  /** Age in ms of an order stuck in Idle. */
  stuckOrderWarn: number;
  stuckOrderCrit: number;
};

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  diskWarn: 80,
  diskCrit: 92,
  memoryWarn: 85,
  memoryCrit: 95,
  dbSizeWarn: 500,
  dbSizeCrit: 2000,
  tableBloatWarn: 70,
  tableBloatCrit: 90,
  // A database this small cannot be in trouble whatever its shape.
  tableBloatFloorMb: 100,
  tickerFetchWarn: 60_000,
  tickerFetchCrit: 300_000,
  tickerReadingWarn: 600_000,
  tickerReadingCrit: 1_800_000,
  apiLatencyWarn: 500,
  apiLatencyCrit: 2000,
  botStallFactor: 5,
  botStallFloorMs: 900_000,
  stuckOrderWarn: 900_000,
  stuckOrderCrit: 3_600_000,
};

export type HealthInput = {
  now: number;
  /** Daemon process facts. */
  process: {
    pid: number;
    uptimeMs: number;
    rssBytes: number;
    nodeVersion: string;
  };
  host: {
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    loadAverage1m: number;
    cpuCount: number;
    diskTotalBytes: number | null;
    diskFreeBytes: number | null;
  };
  database: {
    path: string;
    sizeBytes: number | null;
    journalMode: string | null;
    tableCounts: Record<string, number>;
    /** Approximate bytes held by the largest table, when it can be measured. */
    largestTable: { name: string; bytes: number } | null;
  };
  /** Time taken to answer this request, as a proxy for API responsiveness. */
  apiLatencyMs: number;
  tickers: AnalyticsTicker[];
  bots: AnalyticsBot[];
  /** Most recent bot log timestamp per bot id, epoch ms. */
  lastBotActivity: Record<number, number>;
  orderFlow: {
    stuckIdleOrders: number;
    oldestStuckIdleMs: number | null;
    filledEntriesWithoutExit: number;
  };
  /** Whether the paper exchange limit-order fill fix is present in this build. */
  paperFillPatchApplied: boolean | null;
  thresholds?: Partial<HealthThresholds>;
};

const bytesToMb = (bytes: number) => bytes / 1_048_576;

const formatBytes = (bytes: number) => {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;

  return `${(bytes / 1024).toFixed(0)} KB`;
};

const formatDuration = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

/** Pick a status from a value and its warn/crit ceilings. */
const byCeiling = (value: number, warn: number, crit: number): HealthStatus =>
  value >= crit ? "crit" : value >= warn ? "warn" : "ok";

const WORST_FIRST: HealthStatus[] = ["crit", "warn", "unknown", "ok"];

/** The more severe of two statuses. */
const worst = (a: HealthStatus, b: HealthStatus): HealthStatus =>
  WORST_FIRST.indexOf(a) <= WORST_FIRST.indexOf(b) ? a : b;

export function rollUp(checks: HealthCheck[]): HealthStatus {
  for (const status of WORST_FIRST) {
    if (checks.some((c) => c.status === status)) return status;
  }

  return "ok";
}

export function runHealthChecks(input: HealthInput): HealthReport {
  const t = { ...DEFAULT_HEALTH_THRESHOLDS, ...input.thresholds };
  const checks: HealthCheck[] = [];

  // --- Daemon -------------------------------------------------------------
  checks.push({
    id: "daemon.uptime",
    group: "Daemon",
    label: "Process uptime",
    status: input.process.uptimeMs < 60_000 ? "warn" : "ok",
    value: formatDuration(input.process.uptimeMs),
    detail:
      input.process.uptimeMs < 60_000
        ? "The daemon restarted less than a minute ago. Bots may still be re-placing their orders."
        : `PID ${input.process.pid} on Node ${input.process.nodeVersion}.`,
    metric: input.process.uptimeMs,
  });

  const rssMb = bytesToMb(input.process.rssBytes);
  checks.push({
    id: "daemon.memory",
    group: "Daemon",
    label: "Process memory",
    status: byCeiling(rssMb, 1024, 2048),
    value: formatBytes(input.process.rssBytes),
    detail: "Resident memory held by the trading daemon.",
    metric: rssMb,
  });

  // --- API ----------------------------------------------------------------
  checks.push({
    id: "api.latency",
    group: "API",
    label: "API response time",
    status: byCeiling(input.apiLatencyMs, t.apiLatencyWarn, t.apiLatencyCrit),
    value: `${Math.round(input.apiLatencyMs)} ms`,
    detail: "Time taken to build this health report, as a proxy for API responsiveness.",
    metric: input.apiLatencyMs,
  });

  // --- Host ---------------------------------------------------------------
  const usedMemory = input.host.totalMemoryBytes - input.host.freeMemoryBytes;
  const memoryPercent = input.host.totalMemoryBytes > 0 ? (usedMemory / input.host.totalMemoryBytes) * 100 : 0;
  checks.push({
    id: "host.memory",
    group: "Host",
    label: "Host memory",
    status: byCeiling(memoryPercent, t.memoryWarn, t.memoryCrit),
    value: `${memoryPercent.toFixed(0)}%`,
    detail: `${formatBytes(usedMemory)} of ${formatBytes(input.host.totalMemoryBytes)} in use.`,
    metric: memoryPercent,
  });

  if (input.host.diskTotalBytes !== null && input.host.diskFreeBytes !== null) {
    const diskUsed = input.host.diskTotalBytes - input.host.diskFreeBytes;
    const diskPercent = (diskUsed / input.host.diskTotalBytes) * 100;
    checks.push({
      id: "host.disk",
      group: "Host",
      label: "Disk usage",
      status: byCeiling(diskPercent, t.diskWarn, t.diskCrit),
      value: `${diskPercent.toFixed(0)}%`,
      detail: `${formatBytes(input.host.diskFreeBytes)} free. The database grows with every bot log entry, so headroom here matters.`,
      metric: diskPercent,
    });
  }

  const loadPerCpu = input.host.cpuCount > 0 ? input.host.loadAverage1m / input.host.cpuCount : 0;
  checks.push({
    id: "host.load",
    group: "Host",
    label: "Load average",
    status: byCeiling(loadPerCpu, 1, 2),
    value: input.host.loadAverage1m.toFixed(2),
    detail: `1 minute load across ${input.host.cpuCount} CPUs.`,
    metric: input.host.loadAverage1m,
  });

  // --- Database -----------------------------------------------------------
  if (input.database.sizeBytes !== null) {
    const sizeMb = bytesToMb(input.database.sizeBytes);
    checks.push({
      id: "db.size",
      group: "Database",
      label: "Database size",
      status: byCeiling(sizeMb, t.dbSizeWarn, t.dbSizeCrit),
      value: formatBytes(input.database.sizeBytes),
      detail: input.database.path,
      metric: sizeMb,
    });

    if (input.database.largestTable && input.database.sizeBytes > 0) {
      const share = (input.database.largestTable.bytes / input.database.sizeBytes) * 100;

      /*
       * A share this table would have to be big to matter.
       *
       * One table holding most of a small database is the normal shape of a
       * young install, not a fault, and reporting it as one is how an operator
       * learns to ignore their own alerts. The share is still shown — it is
       * genuinely the interesting number once the database is large — but it
       * only raises the status above ok once there is enough there to hurt.
       */
      const bigEnoughToMatter = bytesToMb(input.database.largestTable.bytes) >= t.tableBloatFloorMb;

      checks.push({
        id: "db.bloat",
        group: "Database",
        label: `Largest table (${input.database.largestTable.name})`,
        status: bigEnoughToMatter ? byCeiling(share, t.tableBloatWarn, t.tableBloatCrit) : "ok",
        value: `${share.toFixed(1)}% of DB`,
        detail:
          bigEnoughToMatter && share >= t.tableBloatWarn
            ? `${input.database.largestTable.name} holds ${formatBytes(input.database.largestTable.bytes)}, dominating the database. Bot logs store a full market-data context per entry and are never pruned, so this grows without limit. Consider a retention policy or disabling logging on noisy bots.`
            : `${input.database.largestTable.name} holds ${formatBytes(input.database.largestTable.bytes)}.`,
        metric: share,
      });
    }
  }

  if (input.database.journalMode) {
    const isWal = input.database.journalMode.toLowerCase() === "wal";
    checks.push({
      id: "db.journal",
      group: "Database",
      label: "Journal mode",
      status: isWal ? "ok" : "warn",
      value: input.database.journalMode,
      detail: isWal
        ? "Write-ahead logging allows readers and the writer to work concurrently."
        : "Rollback journal mode serialises readers against the writer. Switching to WAL would reduce lock contention as trade volume grows.",
      metric: null,
    });
  }

  // --- Exchange -----------------------------------------------------------
  if (input.tickers.length === 0) {
    checks.push({
      id: "exchange.tickers",
      group: "Exchange",
      label: "Market data",
      status: "unknown",
      value: "no symbols",
      detail: "No bot symbols to price.",
      metric: null,
    });
  } else {
    const failed = input.tickers.filter((ticker) => ticker.error !== null);

    // Two different questions hide in "stale". How long since we last fetched
    // answers whether the dashboard is working; how old the exchange reading is
    // answers whether the market is quiet. A thinly traded pair can sit a minute
    // between trades while our polling is perfectly healthy, so only the first
    // drives the status.
    const oldestFetch = Math.max(...input.tickers.map((ticker) => input.now - ticker.fetchedAt));
    const oldestReading = Math.max(...input.tickers.map((ticker) => ticker.ageMs));

    const status: HealthStatus =
      failed.length === input.tickers.length
        ? "crit"
        : failed.length > 0
          ? "warn"
          : worst(
              byCeiling(oldestFetch, t.tickerFetchWarn, t.tickerFetchCrit),
              byCeiling(oldestReading, t.tickerReadingWarn, t.tickerReadingCrit),
            );

    checks.push({
      id: "exchange.tickers",
      group: "Exchange",
      label: "Market data freshness",
      status,
      value:
        failed.length > 0 ? `${failed.length}/${input.tickers.length} failing` : `fetched ${formatDuration(oldestFetch)} ago`,
      detail:
        failed.length > 0
          ? `Could not price: ${failed.map((ticker) => `${ticker.symbol} (${ticker.error})`).join(", ")}. Floating P&L is unavailable for those symbols.`
          : `${input.tickers.length} symbols tracked. Oldest exchange reading is ${formatDuration(oldestReading)} old, which reflects how actively the pair trades rather than a fault here.`,
      metric: oldestFetch,
    });
  }

  // --- Bot liveness -------------------------------------------------------
  const enabledBots = input.bots.filter((bot) => bot.enabled);
  const stalled: string[] = [];
  const stuckProcessing: string[] = [];

  for (const bot of enabledBots) {
    if (bot.processing) stuckProcessing.push(bot.name);

    const lastActivity = input.lastBotActivity[bot.id];
    if (lastActivity === undefined) continue;

    const timeframeMs = timeframeToMs(bot.timeframe);
    const window = Math.max(t.botStallFloorMs, (timeframeMs ?? 0) * t.botStallFactor);
    if (input.now - lastActivity > window) stalled.push(bot.name);
  }

  checks.push({
    id: "bots.enabled",
    group: "Bots",
    label: "Bots running",
    status: input.bots.length > 0 && enabledBots.length === 0 ? "warn" : "ok",
    value: `${enabledBots.length}/${input.bots.length}`,
    detail:
      enabledBots.length === 0 && input.bots.length > 0
        ? "No bot is enabled. Nothing is trading. Bots must be started again after a daemon restart."
        : "Bots currently enabled.",
    metric: enabledBots.length,
  });

  checks.push({
    id: "bots.stalled",
    group: "Bots",
    label: "Bot activity",
    status: stalled.length > 0 ? "warn" : "ok",
    value: stalled.length > 0 ? `${stalled.length} quiet` : "all active",
    detail:
      stalled.length > 0
        ? `No recent strategy execution for: ${stalled.join(", ")}. This is expected for a bot waiting on a slow timeframe, but persistent silence usually means the candle stream dropped.`
        : "Every enabled bot has executed recently.",
    metric: stalled.length,
  });

  if (stuckProcessing.length > 0) {
    checks.push({
      id: "bots.processing",
      group: "Bots",
      label: "Stuck processing flag",
      status: "warn",
      value: `${stuckProcessing.length} stuck`,
      detail: `These bots are still flagged as processing: ${stuckProcessing.join(", ")}. The flag is meant to clear when a strategy run finishes, so it usually means a run threw or the daemon was killed mid-execution.`,
      metric: stuckProcessing.length,
    });
  }

  // --- Order flow ---------------------------------------------------------
  checks.push({
    id: "orders.stuck",
    group: "Orders",
    label: "Orders awaiting placement",
    status:
      input.orderFlow.oldestStuckIdleMs === null
        ? "ok"
        : byCeiling(input.orderFlow.oldestStuckIdleMs, t.stuckOrderWarn, t.stuckOrderCrit),
    value: `${input.orderFlow.stuckIdleOrders}`,
    detail:
      input.orderFlow.stuckIdleOrders > 0
        ? `Oldest has been waiting ${formatDuration(input.orderFlow.oldestStuckIdleMs ?? 0)}. These orders were due to be placed on the exchange and have not been. Exits still waiting behind an unfilled entry are excluded, since that is their normal resting state.`
        : "Every order that is due to be placed has been placed.",
    metric: input.orderFlow.stuckIdleOrders,
  });

  checks.push({
    id: "orders.unprotected",
    group: "Orders",
    label: "Positions without an exit",
    status: input.orderFlow.filledEntriesWithoutExit > 0 ? "warn" : "ok",
    value: `${input.orderFlow.filledEntriesWithoutExit}`,
    detail:
      input.orderFlow.filledEntriesWithoutExit > 0
        ? "These positions bought but have no live order to sell into. That happens when a bot is stopped while holding stock, and the position stays committed until the bot covers that level again."
        : "Every open position has a live exit order.",
    metric: input.orderFlow.filledEntriesWithoutExit,
  });

  // --- Build integrity ----------------------------------------------------
  if (input.paperFillPatchApplied !== null) {
    checks.push({
      id: "build.paperFillPatch",
      group: "Integrity",
      label: "Paper fill fix",
      status: input.paperFillPatchApplied ? "ok" : "crit",
      value: input.paperFillPatchApplied ? "applied" : "missing",
      detail: input.paperFillPatchApplied
        ? "The paper exchange falls back to the last traded price when the feed omits bid and ask, so limit orders can fill."
        : "The paper exchange is comparing limit prices against a bid and ask this feed never sends, so limit orders will never fill. This build has lost the fix.",
      metric: null,
    });
  }

  const counts: Record<HealthStatus, number> = { ok: 0, warn: 0, crit: 0, unknown: 0 };
  for (const check of checks) counts[check.status] += 1;

  return { status: rollUp(checks), checkedAt: input.now, counts, checks };
}

/** Convert a bot timeframe such as "1m" or "4h" to milliseconds. */
export function timeframeToMs(timeframe: string | null): number | null {
  if (!timeframe) return null;

  const match = /^(\d+)([mhdwM])$/.exec(timeframe);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2]!;
  const unitMs: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    M: 2_592_000_000,
  };

  return unitMs[unit] ? amount * unitMs[unit]! : null;
}
