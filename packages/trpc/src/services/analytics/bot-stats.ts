/**
 * Per-bot aggregation and the leaderboard.
 *
 * There is no single honest answer to "which bot performs best" - it depends on
 * what you are optimising for. On a fleet of grid bots the bot with the largest
 * total profit is often not the one with the best profit per trade, and neither
 * is necessarily the one earning fastest. So rather than assert one winner, this
 * ranks by whichever metric the caller asks for.
 */
import type { AnalyticsBot, AnalyticsSmartTrade, AnalyticsTicker, OpenPosition, PendingEntry, RoundTrip } from "./types.js";
import { EPSILON } from "./types.js";
import type { RoundTripStats } from "./round-trips.js";
import { summarizeRoundTrips, toRoundTrips } from "./round-trips.js";
import type { PositionStats, TickerLookup } from "./positions.js";
import { summarizePositions, toOpenPositions, toPendingEntries } from "./positions.js";

export const LEADERBOARD_METRICS = [
  "netPnl",
  "pnlPercent",
  "trades",
  "winRate",
  "averagePnl",
  "pnlPerHour",
] as const;

export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

export type BotStats = {
  botId: number;
  name: string;
  symbol: string;
  type: string;
  template: string;
  timeframe: string | null;
  enabled: boolean;
  processing: boolean;
  createdAt: number;
  exchangeAccountId: number;

  realized: RoundTripStats;
  positions: PositionStats;
  pendingEntries: number;
  pendingEntryValue: number;

  /** Realised profit plus what the open positions are currently worth. */
  totalPnl: number | null;
  /** Net realised profit as a percent of the capital that was cycled through. */
  pnlPercent: number;
  /** Net realised profit per hour the bot has been alive. */
  pnlPerHour: number;
  activeMs: number;

  /** Epoch ms of the most recent fill on either leg, null if nothing ever filled. */
  lastFillAt: number | null;
  lastTradeClosedAt: number | null;

  markPrice: number | null;
  tickerStale: boolean;
};

function lastFillTimestamp(trades: AnalyticsSmartTrade[]): number | null {
  let latest: number | null = null;

  for (const trade of trades) {
    for (const order of trade.orders) {
      if (order.status !== "Filled" || !order.filledAt) continue;

      const at = order.filledAt.getTime();
      if (latest === null || at > latest) latest = at;
    }
  }

  return latest;
}

export function computeBotStats(
  bot: AnalyticsBot,
  trades: AnalyticsSmartTrade[],
  tickerFor: TickerLookup,
  now: number,
): BotStats {
  const roundTrips = toRoundTrips(trades);
  const realized = summarizeRoundTrips(roundTrips);
  const openPositions = toOpenPositions(trades, tickerFor, now);
  const positions = summarizePositions(openPositions);
  const pending = toPendingEntries(trades, tickerFor, now);

  const activeMs = Math.max(0, now - bot.createdAt.getTime());
  const activeHours = activeMs / 3_600_000;
  const ticker = tickerFor(bot.symbol);

  return {
    botId: bot.id,
    name: bot.name,
    symbol: bot.symbol,
    type: bot.type,
    template: bot.template,
    timeframe: bot.timeframe,
    enabled: bot.enabled,
    processing: bot.processing,
    createdAt: bot.createdAt.getTime(),
    exchangeAccountId: bot.exchangeAccountId,

    realized,
    positions,
    pendingEntries: pending.length,
    pendingEntryValue: pending.reduce((sum, p) => sum + (p.price ?? 0) * p.quantity, 0),

    totalPnl: positions.floatingPnl === null ? null : realized.netPnl + positions.floatingPnl,
    pnlPercent: realized.volume > EPSILON ? (realized.netPnl / realized.volume) * 100 : 0,
    pnlPerHour: activeHours > EPSILON ? realized.netPnl / activeHours : 0,
    activeMs,

    lastFillAt: lastFillTimestamp(trades),
    lastTradeClosedAt: realized.lastTradeAt,

    markPrice: ticker?.last ?? ticker?.bid ?? ticker?.ask ?? null,
    tickerStale: ticker?.stale ?? true,
  };
}

/** Group trades by bot, so each bot is aggregated over only its own trades. */
export function groupTradesByBot(trades: AnalyticsSmartTrade[]): Map<number, AnalyticsSmartTrade[]> {
  const byBot = new Map<number, AnalyticsSmartTrade[]>();

  for (const trade of trades) {
    if (trade.botId === null) continue;

    const bucket = byBot.get(trade.botId);
    if (bucket) bucket.push(trade);
    else byBot.set(trade.botId, [trade]);
  }

  return byBot;
}

export function computeAllBotStats(
  bots: AnalyticsBot[],
  trades: AnalyticsSmartTrade[],
  tickerFor: TickerLookup,
  now: number,
): BotStats[] {
  const byBot = groupTradesByBot(trades);

  return bots.map((bot) => computeBotStats(bot, byBot.get(bot.id) ?? [], tickerFor, now));
}

export function metricValue(stats: BotStats, metric: LeaderboardMetric): number | null {
  switch (metric) {
    case "netPnl":
      return stats.realized.netPnl;
    case "pnlPercent":
      return stats.pnlPercent;
    case "trades":
      return stats.realized.trades;
    case "winRate":
      return stats.realized.winRate;
    case "averagePnl":
      return stats.realized.averagePnl;
    case "pnlPerHour":
      return stats.pnlPerHour;
    default:
      return null;
  }
}

export type LeaderboardEntry = {
  rank: number;
  botId: number;
  name: string;
  symbol: string;
  value: number | null;
  stats: BotStats;
};

/**
 * Rank bots by one metric, best first.
 *
 * Bots with no closed trades have no meaningful value for most metrics, so they
 * sort last rather than being treated as zero and outranking a losing bot.
 */
export function buildLeaderboard(allStats: BotStats[], metric: LeaderboardMetric): LeaderboardEntry[] {
  const ranked = [...allStats].sort((a, b) => {
    const av = metricValue(a, metric);
    const bv = metricValue(b, metric);

    if (av === null && bv === null) return a.name.localeCompare(b.name);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (bv !== av) return bv - av;

    return a.name.localeCompare(b.name);
  });

  return ranked.map((stats, index) => ({
    rank: index + 1,
    botId: stats.botId,
    name: stats.name,
    symbol: stats.symbol,
    value: metricValue(stats, metric),
    stats,
  }));
}

export type FleetTotals = {
  bots: number;
  enabledBots: number;
  realized: RoundTripStats;
  positions: PositionStats;
  pendingEntries: number;
  pendingEntryValue: number;
  totalPnl: number | null;
  symbols: string[];
};

/**
 * Fleet-wide totals.
 *
 * Realised and position stats are recomputed from the flat trade list rather
 * than summed from per-bot stats, so derived figures such as win rate, profit
 * factor and streaks are correct across the fleet instead of being averages of
 * averages.
 */
export function computeFleetTotals(
  bots: AnalyticsBot[],
  roundTrips: RoundTrip[],
  openPositions: OpenPosition[],
  pendingEntries: PendingEntry[],
): FleetTotals {
  const realized = summarizeRoundTrips(roundTrips);
  const positions = summarizePositions(openPositions);

  return {
    bots: bots.length,
    enabledBots: bots.filter((b) => b.enabled).length,
    realized,
    positions,
    pendingEntries: pendingEntries.length,
    pendingEntryValue: pendingEntries.reduce((sum, p) => sum + (p.price ?? 0) * p.quantity, 0),
    totalPnl: positions.floatingPnl === null ? null : realized.netPnl + positions.floatingPnl,
    symbols: [...new Set(bots.map((b) => b.symbol))].sort(),
  };
}

/** Tickers keyed by symbol, as a lookup the analytics services can take. */
export function tickerLookup(tickers: AnalyticsTicker[]): TickerLookup {
  const bySymbol = new Map(tickers.map((t) => [t.symbol, t]));

  return (symbol: string) => bySymbol.get(symbol);
}
