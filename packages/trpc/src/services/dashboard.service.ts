/**
 * Data access and caching for the dashboard.
 *
 * All database and exchange I/O for the dashboard lives here; the analytics
 * modules under `services/analytics` stay pure and testable. Three separate
 * caches keep a five second refresh cheap no matter how many browser tabs or
 * agents are watching:
 *
 *  - the trade context, for ~2s, so concurrent clients share one query pass;
 *  - tickers, via TickerCache, so the exchange is polled once per symbol;
 *  - database size statistics, for ten minutes and computed in the background,
 *    because measuring table sizes is a full scan of a very large file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { xprisma } from "@opentrader/db";
import { exchangeProvider } from "@opentrader/exchanges";
import type { ExchangeCode } from "@opentrader/types";
import type {
  AnalyticsBot,
  AnalyticsOrder,
  AnalyticsSmartTrade,
  AnalyticsTicker,
} from "./analytics/index.js";
import { TickerCache } from "./analytics/index.js";

/**
 * Minimal shapes of the rows this service reads.
 *
 * Declared locally rather than imported from Prisma so the file typechecks in a
 * clean checkout, where the workspace declaration files have not been generated
 * yet. They are structurally compatible with the generated model types.
 */
type OrderRow = {
  id: number;
  status: string;
  type: string;
  entityType: string;
  side: string;
  price: number | null;
  filledPrice: number | null;
  fee: number | null;
  quantity: number;
  symbol: string;
  smartTradeId: number;
  createdAt: Date;
  placedAt: Date | null;
  syncedAt: Date | null;
  filledAt: Date | null;
  updatedAt: Date;
};

type TradeRow = {
  id: number;
  type: string;
  entryType: string;
  takeProfitType: string;
  symbol: string;
  botId: number | null;
  exchangeAccountId: number;
  createdAt: Date;
  updatedAt: Date;
  orders: OrderRow[];
};

type BotRow = {
  id: number;
  type: string;
  name: string;
  label: string | null;
  symbol: string;
  enabled: boolean;
  processing: boolean;
  template: string;
  timeframe: string | null;
  createdAt: Date;
  exchangeAccountId: number;
  settings: string;
  state: string;
};

type AccountRow = { id: number; exchangeCode: string; isDemoAccount: boolean };

export type BotLogRow = {
  id: number;
  botId: number;
  action: string;
  triggerEventType: string | null;
  error: string | null;
  createdAt: Date;
};

const CONTEXT_TTL_MS = 2_000;
const DB_STATS_TTL_MS = 600_000;
/**
 * Bot log reads are cached hard.
 *
 * `BotLog` stores a full market-data context per row and carries no index on
 * either `botId` or `createdAt`, so any query against it scans a table that is
 * currently over 700 MB - measured at ~360ms for a single GROUP BY, which was
 * the dominant cost of a dashboard poll. The table is append-only, so serving a
 * slightly old view is safe: it delays a bot start, stop or error notification
 * by at most this long. Closed-deal toasts are derived from order fills, not
 * from here, so the notification that actually matters stays immediate.
 */
const BOT_LOG_TTL_MS = 10_000;
const BOT_ACTIVITY_TTL_MS = 30_000;
/** Rows held in memory, so `since` and `limit` can be applied without a query. */
const BOT_LOG_CACHE_SIZE = 200;
/** Ceiling on how many trades are loaded into one analytics pass. */
const MAX_TRADES = 20_000;

export type AnalyticsContext = {
  now: number;
  bots: AnalyticsBot[];
  trades: AnalyticsSmartTrade[];
  tickers: AnalyticsTicker[];
  botNames: Map<number, string>;
  /** Exchange code per exchange account id. */
  exchangeCodes: Map<number, { code: string; isDemo: boolean }>;
  /** Milliseconds the underlying queries took, surfaced by the health check. */
  loadMs: number;
};

export type DatabaseStats = {
  sizeBytes: number | null;
  journalMode: string | null;
  tableCounts: Record<string, number>;
  largestTable: { name: string; bytes: number } | null;
  measuredAt: number | null;
};

const EMPTY_DB_STATS: DatabaseStats = {
  sizeBytes: null,
  journalMode: null,
  tableCounts: {},
  largestTable: null,
  measuredAt: null,
};

/** Parse a JSON column without letting a malformed row take the dashboard down. */
function safeParse(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value);

    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Resolve the sqlite file path from the Prisma connection string. */
function databasePath(): string | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;

  return url.startsWith("file:") ? url.slice("file:".length).split("?")[0]! : url;
}

export class DashboardService {
  private context: { at: number; value: Promise<AnalyticsContext> } | null = null;
  private dbStats: DatabaseStats = EMPTY_DB_STATS;
  private dbStatsPending = false;
  private botLogs: { at: number; rows: BotLogRow[] } | null = null;
  private botActivity: { at: number; value: Record<number, number> } | null = null;
  private paperFillPatch: boolean | null | undefined;

  readonly tickers = new TickerCache(async (exchangeCode, symbol) => {
    const exchange = exchangeProvider.fromCode(exchangeCode as ExchangeCode, false);
    const ticker = await exchange.getTicker(symbol);

    return {
      last: ticker.last ?? null,
      bid: ticker.bid ?? null,
      ask: ticker.ask ?? null,
      timestamp: ticker.timestamp ?? null,
    };
  });

  /**
   * Bots, trades and prices for one analytics pass.
   *
   * Repeated calls inside the TTL share a single in-flight promise, so ten
   * clients refreshing together produce one set of queries rather than ten.
   */
  async getContext(ownerId: number): Promise<AnalyticsContext> {
    const now = Date.now();

    if (this.context && now - this.context.at < CONTEXT_TTL_MS) return this.context.value;

    const load = this.loadContext(ownerId);
    this.context = { at: now, value: load };

    // A failed load must not be cached, or the dashboard stays broken for the TTL.
    load.catch(() => {
      if (this.context?.value === load) this.context = null;
    });

    return load;
  }

  private async loadContext(ownerId: number): Promise<AnalyticsContext> {
    const startedAt = Date.now();

    const [botRows, tradeRows, accountRows] = await Promise.all([
      xprisma.bot.findMany({ where: { ownerId }, orderBy: { createdAt: "desc" } }) as Promise<BotRow[]>,
      xprisma.smartTrade.findMany({
        where: { ownerId },
        include: { orders: true },
        orderBy: { id: "desc" },
        take: MAX_TRADES,
      }) as Promise<TradeRow[]>,
      xprisma.exchangeAccount.findMany({ where: { ownerId } }) as Promise<AccountRow[]>,
    ]);

    const exchangeCodes = new Map<number, { code: string; isDemo: boolean }>();
    for (const account of accountRows) {
      exchangeCodes.set(account.id, { code: account.exchangeCode, isDemo: account.isDemoAccount });
    }

    const bots: AnalyticsBot[] = botRows.map((bot) => ({
      id: bot.id,
      type: bot.type,
      name: bot.name,
      label: bot.label,
      symbol: bot.symbol,
      enabled: bot.enabled,
      processing: bot.processing,
      template: bot.template,
      timeframe: bot.timeframe,
      createdAt: bot.createdAt,
      exchangeAccountId: bot.exchangeAccountId,
      settings: safeParse(bot.settings),
      state: safeParse(bot.state),
    }));

    const trades: AnalyticsSmartTrade[] = tradeRows.map((trade) => ({
      id: trade.id,
      type: trade.type,
      entryType: trade.entryType,
      takeProfitType: trade.takeProfitType,
      symbol: trade.symbol,
      botId: trade.botId,
      exchangeAccountId: trade.exchangeAccountId,
      createdAt: trade.createdAt,
      updatedAt: trade.updatedAt,
      orders: trade.orders.map(
        (order): AnalyticsOrder => ({
          id: order.id,
          status: order.status,
          type: order.type,
          entityType: order.entityType,
          side: order.side,
          price: order.price,
          filledPrice: order.filledPrice,
          fee: order.fee,
          quantity: order.quantity,
          symbol: order.symbol,
          smartTradeId: order.smartTradeId,
          createdAt: order.createdAt,
          placedAt: order.placedAt,
          syncedAt: order.syncedAt,
          filledAt: order.filledAt,
          updatedAt: order.updatedAt,
        }),
      ),
    }));

    // Price every symbol the fleet touches, once each.
    const wanted = new Map<string, { exchangeCode: string; symbol: string }>();
    for (const bot of bots) {
      const account = exchangeCodes.get(bot.exchangeAccountId);
      if (account) wanted.set(`${account.code}:${bot.symbol}`, { exchangeCode: account.code, symbol: bot.symbol });
    }
    for (const trade of trades) {
      const account = exchangeCodes.get(trade.exchangeAccountId);
      if (account) wanted.set(`${account.code}:${trade.symbol}`, { exchangeCode: account.code, symbol: trade.symbol });
    }

    // Pricing a symbol is a call to the exchange, around 200ms each, and there is
    // no reason for a dashboard poll to wait on it: a price up to one TTL old is
    // perfectly good for marking positions. Only the very first load blocks, so
    // that the first paint has prices rather than empty floating P&L; after that
    // the refresh runs in the background and the next poll picks it up.
    const requests = [...wanted.values()];
    if (this.tickers.list().length === 0) await this.tickers.refresh(requests);
    else void this.tickers.refresh(requests);

    // Measuring table sizes is slow, so it is refreshed out of band.
    void this.refreshDatabaseStats();

    return {
      now: Date.now(),
      bots,
      trades,
      tickers: this.tickers.list(),
      botNames: new Map(bots.map((bot) => [bot.id, bot.name])),
      exchangeCodes,
      loadMs: Date.now() - startedAt,
    };
  }

  /** Invalidate the cached reads, so a control action is reflected immediately. */
  invalidate() {
    this.context = null;
    this.botLogs = null;
    this.botActivity = null;
  }

  getDatabaseStats(): DatabaseStats {
    return this.dbStats;
  }

  /**
   * Measure the database in the background.
   *
   * `dbstat` gives exact per-table page usage but scans the whole file, which
   * takes seconds on a large database, so it never runs inside a request.
   */
  private async refreshDatabaseStats(): Promise<void> {
    const now = Date.now();
    if (this.dbStatsPending) return;
    if (this.dbStats.measuredAt !== null && now - this.dbStats.measuredAt < DB_STATS_TTL_MS) return;

    this.dbStatsPending = true;

    try {
      const file = databasePath();
      let sizeBytes: number | null = null;

      if (file) {
        try {
          sizeBytes = (await fs.promises.stat(file)).size;
        } catch {
          sizeBytes = null;
        }
      }

      const [journalRows, smartTrades, orders, botLogs] = await Promise.all([
        xprisma.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode").catch(() => []),
        xprisma.smartTrade.count(),
        xprisma.order.count(),
        xprisma.botLog.count(),
      ]);

      let largestTable: { name: string; bytes: number } | null = null;
      try {
        const rows = await xprisma.$queryRawUnsafe<Array<{ name: string; bytes: bigint | number }>>(
          "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 1",
        );
        if (rows[0]) largestTable = { name: rows[0].name, bytes: Number(rows[0].bytes) };
      } catch {
        // dbstat is a compile-time option; without it the bloat check is skipped.
        largestTable = null;
      }

      this.dbStats = {
        sizeBytes,
        journalMode: journalRows[0]?.journal_mode ?? null,
        tableCounts: { SmartTrade: smartTrades, Order: orders, BotLog: botLogs },
        largestTable,
        measuredAt: Date.now(),
      };
    } catch {
      // Best effort: leaving the stats unmeasured makes the health check report
      // them as unknown, which is more visible than a log line nobody reads.
    } finally {
      this.dbStatsPending = false;
    }
  }

  /**
   * Whether this build still carries the paper exchange limit-order fill fix.
   *
   * Without it the paper exchange compares limit prices against a bid and ask
   * that the Coinbase feed never sends, and no limit order ever fills. The fix
   * has previously been applied by hand to a built bundle, where a rebuild
   * silently reverts it - so the running build is inspected rather than trusted.
   * The answer cannot change without a restart, so it is computed once.
   */
  hasPaperFillFix(): boolean | null {
    if (this.paperFillPatch !== undefined) return this.paperFillPatch;

    try {
      const dir = path.dirname(fileURLToPath(import.meta.url));
      const files = fs.readdirSync(dir).filter((file) => file.endsWith(".mjs") || file.endsWith(".js"));

      let found = false;
      let sawPaperExchange = false;

      for (const file of files) {
        const contents = fs.readFileSync(path.join(dir, file), "utf8");
        if (contents.includes("Paper] BUY order ID:")) sawPaperExchange = true;
        if (contents.includes("ticker.ask ?? ticker.last")) {
          found = true;
          break;
        }
      }

      // Unknown rather than false when the paper exchange is not in this bundle,
      // so a source checkout does not report a false alarm.
      this.paperFillPatch = found ? true : sawPaperExchange ? false : null;
    } catch {
      this.paperFillPatch = null;
    }

    return this.paperFillPatch;
  }

  /** Host facts for the health report. */
  hostStats() {
    let diskTotalBytes: number | null = null;
    let diskFreeBytes: number | null = null;

    try {
      const stats = fs.statfsSync(databasePath() ?? os.homedir());
      diskTotalBytes = stats.blocks * stats.bsize;
      diskFreeBytes = stats.bavail * stats.bsize;
    } catch {
      // Not every platform reports filesystem statistics.
    }

    return {
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      loadAverage1m: os.loadavg()[0] ?? 0,
      cpuCount: os.cpus().length,
      diskTotalBytes,
      diskFreeBytes,
    };
  }

  processStats() {
    return {
      pid: process.pid,
      uptimeMs: process.uptime() * 1000,
      rssBytes: process.memoryUsage().rss,
      nodeVersion: process.versions.node,
    };
  }

  databaseFile() {
    return databasePath() ?? "unknown";
  }

  /** Most recent bot log entry per bot, for the liveness check. */
  async lastBotActivity(ownerId: number): Promise<Record<number, number>> {
    const cachedAt = this.botActivity?.at ?? 0;
    if (this.botActivity && Date.now() - cachedAt < BOT_ACTIVITY_TTL_MS) return this.botActivity.value;

    const rows = (await xprisma.botLog.groupBy({
      by: ["botId"],
      _max: { createdAt: true },
      where: { bot: { ownerId } },
    })) as Array<{ botId: number; _max: { createdAt: Date | null } }>;

    const activity: Record<number, number> = {};
    for (const row of rows) {
      if (row._max.createdAt) activity[row.botId] = row._max.createdAt.getTime();
    }

    this.botActivity = { at: Date.now(), value: activity };

    return activity;
  }

  /**
   * Recent bot log rows, for the event feed and the log widget.
   *
   * One query per TTL fetches the newest rows; `since` and `limit` are applied
   * in memory afterwards, so a five second poll does not scan the table twelve
   * times a minute.
   */
  async recentBotLogs(ownerId: number, limit: number, since?: number): Promise<BotLogRow[]> {
    if (!this.botLogs || Date.now() - this.botLogs.at >= BOT_LOG_TTL_MS) {
      const rows = (await xprisma.botLog.findMany({
        where: { bot: { ownerId } },
        orderBy: { createdAt: "desc" },
        take: BOT_LOG_CACHE_SIZE,
        select: { id: true, botId: true, action: true, error: true, createdAt: true, triggerEventType: true },
      })) as BotLogRow[];

      this.botLogs = { at: Date.now(), rows };
    }

    const rows = since ? this.botLogs.rows.filter((row) => row.createdAt.getTime() > since) : this.botLogs.rows;

    return rows.slice(0, limit);
  }
}

/**
 * One instance per process, so the caches are actually shared.
 * Held on globalThis so a dev-mode module reload does not create a second one.
 */
const globalForDashboard = globalThis as unknown as { dashboardService?: DashboardService };

export const dashboardService = globalForDashboard.dashboardService ?? new DashboardService();

if (process.env.NODE_ENV !== "production") globalForDashboard.dashboardService = dashboardService;
