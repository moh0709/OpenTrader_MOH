/**
 * Payload assembly for the dashboard.
 *
 * These functions turn one analytics context into the shapes the UI and the
 * agent API consume. Both surfaces call the same builders, so the REST endpoints
 * an external agent reads can never drift from what the dashboard displays.
 *
 * The snapshot is deliberately compact - fleet totals, per-bot rollups and a
 * short recent-trades tail rather than the full history - because it is polled
 * every few seconds. Anything long-tailed lives behind its own paginated call.
 */
import type { AnalyticsContext, DatabaseStats } from "./dashboard.service.js";
import type {
  BotStats,
  BucketSize,
  DashboardEvent,
  HealthInput,
  HealthReport,
  LeaderboardEntry,
  LeaderboardMetric,
  OpenPosition,
  PendingEntry,
  RoundTrip,
} from "./analytics/index.js";
import {
  buildActivityHeatmap,
  filledEntries,
  isEntryOrder,
  buildEquityCurve,
  buildFeeBreakdown,
  buildGridModel,
  buildHoldTimeDistribution,
  buildLeaderboard,
  buildPnlDistribution,
  buildSparkline,
  botLogEvents,
  computeAllBotStats,
  computeFleetTotals,
  mergeEvents,
  nextCursor,
  runHealthChecks,
  summarizeRoundTrips,
  tickerLookup,
  toOpenPositions,
  toPendingEntries,
  toRoundTrips,
  tradeClosedEvents,
  windowTotals,
} from "./analytics/index.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Everything derived once, so no builder recomputes what another already did. */
export type DerivedAnalytics = {
  context: AnalyticsContext;
  roundTrips: RoundTrip[];
  openPositions: OpenPosition[];
  pendingEntries: PendingEntry[];
  botStats: BotStats[];
};

export function derive(context: AnalyticsContext): DerivedAnalytics {
  const lookup = tickerLookup(context.tickers);

  return {
    context,
    roundTrips: toRoundTrips(context.trades),
    openPositions: toOpenPositions(context.trades, lookup, context.now),
    pendingEntries: toPendingEntries(context.trades, lookup, context.now),
    botStats: computeAllBotStats(context.bots, context.trades, lookup, context.now),
  };
}

export type SnapshotOptions = {
  metric?: LeaderboardMetric;
  recentTradeLimit?: number;
};

export function buildSnapshot(derived: DerivedAnalytics, options: SnapshotOptions = {}) {
  const { context, roundTrips, openPositions, pendingEntries, botStats } = derived;
  const metric = options.metric ?? "netPnl";
  const recentLimit = options.recentTradeLimit ?? 25;

  const fleet = computeFleetTotals(context.bots, roundTrips, openPositions, pendingEntries);
  const leaderboard = buildLeaderboard(botStats, metric);

  return {
    generatedAt: context.now,
    loadMs: context.loadMs,

    fleet: {
      ...fleet,
      // Rolling windows for the KPI strip.
      today: windowTotals(roundTrips, context.now, DAY),
      week: windowTotals(roundTrips, context.now, 7 * DAY),
      month: windowTotals(roundTrips, context.now, 30 * DAY),
      sparkline: buildSparkline(roundTrips, 48),
      fees: buildFeeBreakdown(roundTrips),
    },

    // Rank and value only; the full per-bot stats travel in `bots`.
    leaderboard: leaderboard.map(({ rank, botId, name, symbol, value }) => ({ rank, botId, name, symbol, value })),
    leaderboardMetric: metric,

    bots: botStats.map((stats) => ({
      ...stats,
      sparkline: buildSparkline(
        roundTrips.filter((rt) => rt.botId === stats.botId),
        24,
      ),
    })),

    recentTrades: roundTrips.slice(0, recentLimit),

    tickers: context.tickers,
  };
}

export type TradeQuery = {
  botId?: number;
  symbol?: string;
  outcome?: "win" | "loss" | "breakeven";
  from?: number;
  to?: number;
  sort?: "exitAt" | "netPnl" | "pnlPercent" | "holdMs";
  direction?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

/** Closed trades, filtered and paginated, plus totals for the filtered set. */
export function buildTradesView(derived: DerivedAnalytics, query: TradeQuery = {}) {
  const sort = query.sort ?? "exitAt";
  const direction = query.direction ?? "desc";
  const limit = Math.min(query.limit ?? 50, 500);
  const offset = Math.max(query.offset ?? 0, 0);

  const filtered = derived.roundTrips.filter((rt) => {
    if (query.botId !== undefined && rt.botId !== query.botId) return false;
    if (query.symbol && rt.symbol !== query.symbol) return false;
    if (query.outcome && rt.outcome !== query.outcome) return false;
    if (query.from !== undefined && rt.exitAt < query.from) return false;
    if (query.to !== undefined && rt.exitAt > query.to) return false;

    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const delta = a[sort] - b[sort];

    return direction === "asc" ? delta : -delta;
  });

  return {
    total: filtered.length,
    offset,
    limit,
    // Totals describe the whole filtered set, not just the page on screen.
    totals: summarizeRoundTrips(filtered),
    trades: sorted.slice(offset, offset + limit),
    botNames: Object.fromEntries(derived.context.botNames),
  };
}

export type PositionQuery = {
  botId?: number;
  state?: "live" | "abandoned" | "missing";
  includePending?: boolean;
};

export function buildPositionsView(derived: DerivedAnalytics, query: PositionQuery = {}) {
  const positions = derived.openPositions.filter((position) => {
    if (query.botId !== undefined && position.botId !== query.botId) return false;
    if (query.state && position.exitState !== query.state) return false;

    return true;
  });

  const pending = query.includePending === false
    ? []
    : derived.pendingEntries.filter((entry) => query.botId === undefined || entry.botId === query.botId);

  return {
    positions,
    pendingEntries: pending,
    botNames: Object.fromEntries(derived.context.botNames),
  };
}

/** The grid ladder for one bot, or for every grid bot when no id is given. */
export function buildGridView(derived: DerivedAnalytics, botId?: number) {
  const lookup = tickerLookup(derived.context.tickers);
  const bots = botId === undefined ? derived.context.bots : derived.context.bots.filter((bot) => bot.id === botId);

  return bots.map((bot) => {
    const ticker = lookup(bot.symbol);
    const markPrice = ticker?.last ?? ticker?.bid ?? ticker?.ask ?? null;

    return buildGridModel(
      bot,
      derived.context.trades.filter((trade) => trade.botId === bot.id),
      derived.roundTrips.filter((rt) => rt.botId === bot.id),
      derived.openPositions.filter((position) => position.botId === bot.id),
      markPrice,
    );
  });
}

export type HistoryQuery = {
  botId?: number;
  bucket?: BucketSize;
  from?: number;
  to?: number;
};

export function buildHistoryView(derived: DerivedAnalytics, query: HistoryQuery = {}) {
  const roundTrips =
    query.botId === undefined ? derived.roundTrips : derived.roundTrips.filter((rt) => rt.botId === query.botId);

  return {
    equityCurve: buildEquityCurve(roundTrips, query.bucket ?? "1h", query.from, query.to),
    pnlDistribution: buildPnlDistribution(roundTrips),
    holdTimes: buildHoldTimeDistribution(roundTrips),
    heatmap: buildActivityHeatmap(roundTrips),
    fees: buildFeeBreakdown(roundTrips),
    stats: summarizeRoundTrips(roundTrips),
  };
}

export type BotLogRowInput = {
  id: number;
  botId: number;
  action: string;
  error: string | null;
  createdAt: Date;
};

/**
 * Events since a cursor, for toasts and the live feed.
 *
 * A first-ever poll (cursor 0) would otherwise replay the entire history as
 * toasts, so it returns the cursor without any events and starts from now.
 */
export function buildEventsView(
  derived: DerivedAnalytics,
  logs: BotLogRowInput[],
  since: number,
  limit = 50,
): { events: DashboardEvent[]; cursor: number } {
  const latest = Math.max(
    derived.roundTrips[0]?.exitAt ?? 0,
    ...logs.map((log) => log.createdAt.getTime()),
    0,
  );

  if (since <= 0) return { events: [], cursor: latest || derived.context.now };

  const events = mergeEvents(
    [
      tradeClosedEvents(derived.roundTrips, derived.context.botNames, since),
      botLogEvents(logs, derived.context.botNames, since),
    ],
    limit,
  );

  return { events, cursor: nextCursor(events, since) };
}

export type HealthViewInput = {
  derived: DerivedAnalytics;
  database: DatabaseStats;
  databasePath: string;
  process: HealthInput["process"];
  host: HealthInput["host"];
  lastBotActivity: Record<number, number>;
  paperFillPatchApplied: boolean | null;
  apiLatencyMs: number;
  thresholds?: HealthInput["thresholds"];
};

export function buildHealthView(input: HealthViewInput): HealthReport & { database: DatabaseStats } {
  const { derived } = input;

  // Order flow facts the health checks reason about.
  //
  // An idle order is one that exists in the database but has not been placed on
  // the exchange. That is only a fault when the order was due to be placed:
  // OpenTrader creates a take profit alongside its entry and holds it idle until
  // the entry fills, so an idle exit behind an unfilled entry is the normal
  // resting state, not a stuck order. Counting those would make this check fire
  // permanently, which is worse than not having it.
  let stuckIdleOrders = 0;
  let oldestStuckIdleMs: number | null = null;

  for (const trade of derived.context.trades) {
    const entryFilled = filledEntries(trade).length > 0;

    for (const order of trade.orders) {
      if (order.status !== "Idle") continue;

      const isEntry = isEntryOrder(order);
      // An entry should be placed as soon as the bot runs; an exit only once its
      // entry has filled.
      if (!isEntry && !entryFilled) continue;

      stuckIdleOrders += 1;
      const age = derived.context.now - order.createdAt.getTime();
      if (oldestStuckIdleMs === null || age > oldestStuckIdleMs) oldestStuckIdleMs = age;
    }
  }

  const report = runHealthChecks({
    now: derived.context.now,
    process: input.process,
    host: input.host,
    database: {
      path: input.databasePath,
      sizeBytes: input.database.sizeBytes,
      journalMode: input.database.journalMode,
      tableCounts: input.database.tableCounts,
      largestTable: input.database.largestTable,
    },
    apiLatencyMs: input.apiLatencyMs,
    tickers: derived.context.tickers,
    bots: derived.context.bots,
    lastBotActivity: input.lastBotActivity,
    orderFlow: {
      stuckIdleOrders,
      oldestStuckIdleMs,
      // Positions holding stock with no live sell order - the abandoned book.
      filledEntriesWithoutExit: derived.openPositions.filter((p) => p.exitState !== "live").length,
    },
    paperFillPatchApplied: input.paperFillPatchApplied,
    thresholds: input.thresholds,
  });

  return { ...report, database: input.database };
}

export type { LeaderboardEntry };
