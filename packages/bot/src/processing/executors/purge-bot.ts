/**
 * Purging a bot's trade history, and setting its limits.
 *
 * Purge exists to reset a bot to zero: every smart trade it owns, open or
 * closed, together with their orders. It is genuinely destructive and there is
 * no undo, so it does two things carefully.
 *
 * First, it cancels anything still live on the exchange before deleting the
 * rows. Deleting an order that is still resting would leave the exchange holding
 * an order nothing in the database knows about - a real position with no record,
 * which is worse than the mess being cleaned up.
 *
 * Second, it refuses to run against a bot that is still enabled. A running bot
 * re-creates its trades within seconds, so purging underneath it produces a
 * confusing half-state rather than a clean slate.
 */
import { xprisma } from "@opentrader/db";
import { exchangeProvider } from "@opentrader/exchanges";
import { logger } from "@opentrader/logger";
import { OrderExecutor } from "./order/order.executor.js";

const LIVE_STATUSES = ["Idle", "Placed"];

export type PurgeResult = {
  botId: number;
  botName: string;
  /** Orders cancelled on the exchange before deletion. */
  cancelled: number;
  cancelFailures: number;
  deletedTrades: number;
  deletedOrders: number;
  error: string | null;
};

export type PurgePreview = {
  botId: number;
  botName: string;
  enabled: boolean;
  trades: number;
  orders: number;
  liveOrders: number;
  openPositions: number;
  realizedPnl: number;
  /** Set when the purge would be refused, explaining why. */
  blockedReason: string | null;
};

type OrderRow = {
  id: number;
  status: string;
  entityType: string;
  price: number | null;
  filledPrice: number | null;
  quantity: number;
};

type TradeRow = { id: number; symbol: string; exchangeAccountId: number; orders: OrderRow[] };

/** What a purge would remove. Read-only, so the UI can confirm against real numbers. */
export async function previewPurge(botId: number, ownerId: number): Promise<PurgePreview> {
  const bot = (await xprisma.bot.findFirst({ where: { id: botId, ownerId } })) as
    | { id: number; name: string; enabled: boolean }
    | null;

  if (!bot) {
    return {
      botId,
      botName: `Bot ${botId}`,
      enabled: false,
      trades: 0,
      orders: 0,
      liveOrders: 0,
      openPositions: 0,
      realizedPnl: 0,
      blockedReason: "Bot not found",
    };
  }

  const trades = (await xprisma.smartTrade.findMany({
    where: { botId, ownerId },
    include: { orders: true },
  })) as TradeRow[];

  let orders = 0;
  let liveOrders = 0;
  let openPositions = 0;
  let realizedPnl = 0;

  for (const trade of trades) {
    orders += trade.orders.length;

    const entries = trade.orders.filter((o) => ["EntryOrder", "SafetyOrder"].includes(o.entityType));
    const exits = trade.orders.filter((o) => ["TakeProfitOrder", "StopLossOrder"].includes(o.entityType));
    const filledEntries = entries.filter((o) => o.status === "Filled");
    const filledExits = exits.filter((o) => o.status === "Filled");

    liveOrders += trade.orders.filter((o) => LIVE_STATUSES.includes(o.status)).length;
    if (filledEntries.length > 0 && filledExits.length === 0) openPositions += 1;

    if (filledEntries.length > 0 && filledExits.length > 0) {
      const inQty = filledEntries.reduce((sum, o) => sum + o.quantity, 0);
      const inCost = filledEntries.reduce((sum, o) => sum + (o.filledPrice ?? 0) * o.quantity, 0);
      const outQty = filledExits.reduce((sum, o) => sum + o.quantity, 0);
      const outCost = filledExits.reduce((sum, o) => sum + (o.filledPrice ?? 0) * o.quantity, 0);

      if (inQty > 0 && outQty > 0) {
        realizedPnl += (outCost / outQty - inCost / inQty) * Math.min(inQty, outQty);
      }
    }
  }

  return {
    botId,
    botName: bot.name,
    enabled: bot.enabled,
    trades: trades.length,
    orders,
    liveOrders,
    openPositions,
    realizedPnl,
    // Purging underneath a running bot leaves a half-state, not a clean slate.
    blockedReason: bot.enabled ? "Stop the bot first: a running bot re-creates its trades immediately" : null,
  };
}

/**
 * Delete every trade of a bot, cancelling anything still live first.
 *
 * Orders are removed by the cascade on SmartTrade rather than deleted directly,
 * so no order can be orphaned by a partial run.
 */
export async function purgeBotTrades(botId: number, ownerId: number): Promise<PurgeResult> {
  const preview = await previewPurge(botId, ownerId);

  const fail = (error: string): PurgeResult => ({
    botId,
    botName: preview.botName,
    cancelled: 0,
    cancelFailures: 0,
    deletedTrades: 0,
    deletedOrders: 0,
    error,
  });

  if (preview.blockedReason) return fail(preview.blockedReason);

  const trades = (await xprisma.smartTrade.findMany({
    where: { botId, ownerId },
    include: { orders: true, exchangeAccount: true },
  })) as Array<TradeRow & { exchangeAccount: unknown }>;

  let cancelled = 0;
  let cancelFailures = 0;

  for (const trade of trades) {
    const live = trade.orders.filter((order) => LIVE_STATUSES.includes(order.status));
    if (live.length === 0) continue;

    for (const order of live) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- credentials shape comes from the db extension
        const exchange = exchangeProvider.fromAccount(trade.exchangeAccount as any);
        const executor = new OrderExecutor(order as never, exchange, trade.symbol);

        if (await executor.cancel()) cancelled += 1;
      } catch (err) {
        // A cancel that fails must not stop the purge, but it is worth knowing
        // about: that order may still be resting on the exchange.
        cancelFailures += 1;
        logger.warn(
          `[Purge] Could not cancel order ${order.id} of bot ${botId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const { count } = await xprisma.smartTrade.deleteMany({ where: { botId, ownerId } });

  logger.info(
    `[Purge] Bot ${botId} (${preview.botName}): cancelled ${cancelled} live orders, deleted ${count} trades and ${preview.orders} orders.`,
  );

  return {
    botId,
    botName: preview.botName,
    cancelled,
    cancelFailures,
    deletedTrades: count,
    deletedOrders: preview.orders,
    error: null,
  };
}

export type SetLimitsResult = {
  botId: number;
  maxCapital: number | null;
  minProfit: number | null;
};

/**
 * Set a bot's capital cap and minimum profit.
 *
 * Zero clears a limit, which is what the form sends when a field is emptied.
 * Storing it as null keeps "no limit" a single representation rather than two.
 */
export async function setBotLimits(
  botId: number,
  ownerId: number,
  limits: { maxCapital?: number | null; minProfit?: number | null },
): Promise<SetLimitsResult> {
  const normalise = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

  const data: { maxCapital?: number | null; minProfit?: number | null } = {};
  if (limits.maxCapital !== undefined) data.maxCapital = normalise(limits.maxCapital);
  if (limits.minProfit !== undefined) data.minProfit = normalise(limits.minProfit);

  const bot = (await xprisma.bot.update({ where: { id: botId, ownerId }, data })) as {
    id: number;
    maxCapital: number | null;
    minProfit: number | null;
  };

  logger.info(`[Limits] Bot ${botId}: maxCapital=${bot.maxCapital ?? "none"}, minProfit=${bot.minProfit ?? "none"}`);

  return { botId: bot.id, maxCapital: bot.maxCapital, minProfit: bot.minProfit };
}
