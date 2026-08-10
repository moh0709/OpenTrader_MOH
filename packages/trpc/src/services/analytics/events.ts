/**
 * Event derivation for live notifications.
 *
 * Deliberately stateless: rather than keeping a server-side buffer that a client
 * could fall out of sync with, events are derived on demand from data that is
 * already durable - order fill times and bot log rows. The client holds a cursor
 * and asks what happened after it.
 *
 * That means nothing is missed across a daemon restart, nothing is replayed
 * twice after a page reload, and two browser tabs cannot steal each other events.
 */
import type { RoundTrip } from "./types.js";

export type DashboardEventType = "tradeClosed" | "botStarted" | "botStopped" | "botError" | "agentAction";

export type DashboardEvent = {
  /** Monotonic within a response; the cursor is the timestamp. */
  id: string;
  type: DashboardEventType;
  /** Epoch ms the event happened. */
  at: number;
  botId: number | null;
  botName: string | null;
  symbol: string | null;
  title: string;
  message: string;
  severity: "success" | "danger" | "info" | "warning";
  /** Present on tradeClosed, so the UI can render amount and percent. */
  pnl: number | null;
  pnlPercent: number | null;
  smartTradeId: number | null;
};

export type BotLogRow = {
  id: number;
  botId: number;
  action: string;
  error: string | null;
  createdAt: Date;
};

const formatSigned = (value: number, digits = 2) => `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(digits)}`;

/** Closed-trade events for round trips that exited after the cursor. */
export function tradeClosedEvents(
  roundTrips: RoundTrip[],
  botNames: Map<number, string>,
  since: number,
): DashboardEvent[] {
  return roundTrips
    .filter((rt) => rt.exitAt > since)
    .map((rt) => {
      const won = rt.outcome === "win";
      const botName = rt.botId !== null ? (botNames.get(rt.botId) ?? `Bot ${rt.botId}`) : "Unknown bot";

      return {
        id: `trade-${rt.smartTradeId}`,
        type: "tradeClosed" as const,
        at: rt.exitAt,
        botId: rt.botId,
        botName,
        symbol: rt.symbol,
        title: won ? "Deal closed - win" : rt.outcome === "loss" ? "Deal closed - loss" : "Deal closed - flat",
        message: `${botName} - ${rt.symbol} - ${formatSigned(rt.netPnl, 2)} (${formatSigned(rt.pnlPercent, 2)}%)`,
        severity: won ? ("success" as const) : rt.outcome === "loss" ? ("danger" as const) : ("info" as const),
        pnl: rt.netPnl,
        pnlPercent: rt.pnlPercent,
        smartTradeId: rt.smartTradeId,
      };
    });
}

/** Lifecycle and failure events taken from the bot log. */
export function botLogEvents(logs: BotLogRow[], botNames: Map<number, string>, since: number): DashboardEvent[] {
  const events: DashboardEvent[] = [];

  for (const log of logs) {
    const at = log.createdAt.getTime();
    if (at <= since) continue;

    const botName = botNames.get(log.botId) ?? `Bot ${log.botId}`;
    const base = { at, botId: log.botId, botName, symbol: null, pnl: null, pnlPercent: null, smartTradeId: null };

    if (log.error) {
      events.push({
        ...base,
        id: `log-${log.id}`,
        type: "botError",
        title: "Bot error",
        message: `${botName} - ${truncate(log.error, 160)}`,
        severity: "danger",
      });
    } else if (log.action === "start") {
      events.push({
        ...base,
        id: `log-${log.id}`,
        type: "botStarted",
        title: "Bot started",
        message: botName,
        severity: "info",
      });
    } else if (log.action === "stop") {
      events.push({
        ...base,
        id: `log-${log.id}`,
        type: "botStopped",
        title: "Bot stopped",
        message: `${botName} - resting exit orders are cancelled when a bot stops, leaving any open position without a sell order`,
        severity: "warning",
      });
    }
  }

  return events;
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

/**
 * Merge event sources, oldest first, and cap the result.
 *
 * A client returning after a long absence should see the most recent activity
 * rather than a flood of stale toasts, so the cap keeps the newest events.
 */
export function mergeEvents(sources: DashboardEvent[][], limit = 50): DashboardEvent[] {
  const merged = sources.flat().sort((a, b) => a.at - b.at);

  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

/** Cursor for the next poll: the newest event seen, or the caller previous cursor. */
export function nextCursor(events: DashboardEvent[], previous: number): number {
  return events.reduce((max, event) => Math.max(max, event.at), previous);
}
