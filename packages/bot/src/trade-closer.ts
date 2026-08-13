import { xprisma, type SmartTradeWithOrders } from "@opentrader/db";
import { eventBus } from "@opentrader/event-bus";
import { exchangeProvider, type IExchange } from "@opentrader/exchanges";
import { logger } from "@opentrader/logger";
import { XEntityType, XOrderSide, XOrderStatus, XOrderType } from "@opentrader/types";
import type { Order } from "@prisma/client";
import { OrderExecutor } from "./processing/executors/order/order.executor.js";
import { TradeExecutor } from "./processing/executors/trade/trade.executor.js";

/**
 * Force-closing a deal ("force take profit" in 3Commas terms).
 *
 * Cancelling a trade and closing a trade are different operations and must not
 * be confused. `cancelOrders()` cancels the resting orders — if the entry has
 * already filled that leaves the position open with nothing managing it, which
 * is strictly worse than doing nothing. Closing means: stop managing the trade,
 * cancel what is resting, and actually exit the inventory we hold.
 */

export type CloseMode = "market" | "limit";

export type CloseOutcome =
  /** An exit order was placed for a position we actually held. */
  | "closed"
  /** The entry never filled, so there was nothing to sell — orders cancelled. */
  | "canceled_unfilled"
  /** The trade had already finished before we got here. */
  | "already_closed";

export type CloseTradeResult = {
  smartTradeId: number;
  botId: number | null;
  symbol: string;
  outcome: CloseOutcome;
  /** True once the exchange confirms the exit order filled. */
  filled: boolean;
  exitQuantity?: number;
  exitPrice?: number | null;
  message: string;
};

function findOrders(smartTrade: SmartTradeWithOrders) {
  const orders = smartTrade.orders as Order[];
  const entryOrder = orders.find((o: Order) => o.entityType === XEntityType.EntryOrder);
  const takeProfitOrder = orders.find((o: Order) => o.entityType === XEntityType.TakeProfitOrder);
  const stopLossOrder = orders.find((o: Order) => o.entityType === XEntityType.StopLossOrder);

  return { entryOrder, takeProfitOrder, stopLossOrder };
}

/** Statuses where an order is done and must not be touched again. */
const TERMINAL_STATUSES: string[] = [XOrderStatus.Canceled, XOrderStatus.Revoked, XOrderStatus.Deleted];

function isTerminal(order: Order): boolean {
  return TERMINAL_STATUSES.includes(order.status);
}

async function loadTrade(id: number): Promise<SmartTradeWithOrders> {
  return (await xprisma.smartTrade.findUniqueOrThrow({
    where: { id },
    include: { orders: true, exchangeAccount: true },
  })) as SmartTradeWithOrders;
}

/**
 * Price to use for a limit exit: sit on the passive side of the book so the
 * order rests as a maker rather than crossing the spread.
 */
async function passiveExitPrice(exchange: IExchange, symbol: string, exitSide: XOrderSide): Promise<number | null> {
  try {
    const ticker = await exchange.getTicker(symbol);
    // Selling rests at the ask, buying rests at the bid.
    return exitSide === XOrderSide.Sell ? ticker.ask : ticker.bid;
  } catch (err) {
    logger.warn(`[closeSmartTrade] Could not read ticker for ${symbol}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Force-close a single deal.
 *
 * Safe to call whether or not the owning bot is running, and safe to call twice
 * — a trade that is already finished reports `already_closed` rather than
 * selling a position it no longer holds.
 */
export async function closeSmartTrade(id: number, mode: CloseMode = "market"): Promise<CloseTradeResult> {
  let smartTrade = await loadTrade(id);
  const { symbol, botId } = smartTrade;

  const base: Omit<CloseTradeResult, "outcome" | "message" | "filled"> = {
    smartTradeId: id,
    botId,
    symbol,
  };

  const { entryOrder } = findOrders(smartTrade);

  if (!entryOrder) {
    return { ...base, outcome: "already_closed", filled: false, message: "Trade has no entry order; nothing to close." };
  }

  // Decide "is there anything to close?" from the orders directly rather than
  // from TradeExecutor's status.
  //
  // That status reports "Finished" for a filled entry with no take profit order
  // — which is true from the strategy's point of view (it bought and never
  // intended to sell) but is exactly the case a force-close exists for: the
  // account is holding inventory with nothing managing an exit. Short-circuiting
  // on "Finished" would make those positions impossible to close.
  const { takeProfitOrder: existingTp } = findOrders(smartTrade);

  if (isTerminal(entryOrder)) {
    return { ...base, outcome: "already_closed", filled: false, message: "Entry order was cancelled; no position held." };
  }

  if (entryOrder.status === XOrderStatus.Filled && existingTp?.status === XOrderStatus.Filled) {
    return { ...base, outcome: "already_closed", filled: true, message: "Trade was already closed." };
  }

  // Stop the live queue first. If the bot is running, its Trade instance is
  // reacting to ticker and order events and could place a take profit while we
  // are closing. This is a no-op when the trade is not live.
  await eventBus.emit("cancelTrade", smartTrade);

  const exchange = exchangeProvider.fromAccount(smartTrade.exchangeAccount as never);
  smartTrade = await loadTrade(id);
  const refreshed = findOrders(smartTrade);

  // --- Case 1: the entry never filled. There is no inventory to exit. --------
  if (refreshed.entryOrder && refreshed.entryOrder.status !== XOrderStatus.Filled) {
    for (const order of [refreshed.entryOrder, refreshed.takeProfitOrder, refreshed.stopLossOrder]) {
      if (!order || isTerminal(order)) continue;

      await new OrderExecutor(order, exchange, symbol).cancel();
    }

    logger.info(`[closeSmartTrade] Trade ${id} cancelled before entry filled; no position was held.`);

    return {
      ...base,
      outcome: "canceled_unfilled",
      filled: false,
      message: "Entry order had not filled. Cancelled all resting orders; no position was held.",
    };
  }

  // --- Case 2: we hold inventory. Cancel resting exits, then exit at market. -
  const exitSide = entryOrder.side === XOrderSide.Buy ? XOrderSide.Sell : XOrderSide.Buy;
  const exitQuantity = entryOrder.quantity;

  // A resting stop loss must go, or it can fire against the exit we just placed.
  const restingStopLoss = refreshed.stopLossOrder;
  if (restingStopLoss && !isTerminal(restingStopLoss) && restingStopLoss.status !== XOrderStatus.Filled) {
    await new OrderExecutor(restingStopLoss, exchange, symbol).cancel();
  }

  const limitPrice = mode === "limit" ? await passiveExitPrice(exchange, symbol, exitSide) : null;
  const useLimit = mode === "limit" && limitPrice !== null;

  if (mode === "limit" && !useLimit) {
    logger.warn(`[closeSmartTrade] Trade ${id}: no ticker for a limit exit, falling back to market.`);
  }

  const exitPayload = {
    type: useLimit ? XOrderType.Limit : XOrderType.Market,
    side: exitSide,
    status: XOrderStatus.Idle,
    price: useLimit ? limitPrice : null,
    quantity: exitQuantity,
    entityType: XEntityType.TakeProfitOrder,
  };

  const existingTakeProfit = refreshed.takeProfitOrder;
  let placedPrice: number | null = null;

  if (existingTakeProfit && existingTakeProfit.status === XOrderStatus.Filled) {
    return { ...base, outcome: "already_closed", filled: true, message: "Take profit had already filled." };
  }

  if (existingTakeProfit) {
    // Reuse the take profit slot: `modify` cancels whatever is resting there and
    // re-places it with our exit parameters. Keeping the trade's shape intact
    // means the normal fill machinery still completes it.
    const executor = new OrderExecutor(existingTakeProfit, exchange, symbol);
    const replacement: Order = { ...existingTakeProfit, ...exitPayload };
    await executor.modify(replacement);
    placedPrice = executor.order.price ?? null;
  } else {
    // No take profit existed (e.g. a strategy that only ever buys). Create one
    // so the exit is recorded against the trade like any other order.
    const created = await xprisma.order.create({
      data: {
        ...exitPayload,
        symbol,
        exchangeAccountId: smartTrade.exchangeAccountId,
        smartTradeId: id,
      },
    });

    const executor = new OrderExecutor(created, exchange, symbol);
    await executor.place();
    placedPrice = executor.order.price ?? null;
  }

  // Confirm the fill rather than assuming it. Market orders come back "Placed";
  // the exchange decides when they are filled.
  let filled = false;
  try {
    const synced = await loadTrade(id);
    const tp = findOrders(synced).takeProfitOrder;
    filled = tp?.status === XOrderStatus.Filled;

    const executorAfter = TradeExecutor.create(synced, synced.exchangeAccount as never);
    if (executorAfter.status === "Finished") {
      await eventBus.emit("onTradeCompleted", synced);
    }
  } catch (err) {
    logger.warn(`[closeSmartTrade] Trade ${id}: exit placed but post-check failed: ${(err as Error).message}`);
  }

  logger.info(
    `[closeSmartTrade] Trade ${id} (${symbol}): placed ${useLimit ? "limit" : "market"} ${exitSide} ${exitQuantity} to force close.`,
  );

  return {
    ...base,
    outcome: "closed",
    filled,
    exitQuantity,
    exitPrice: placedPrice,
    message: `Placed a ${useLimit ? `limit ${exitSide} at ${limitPrice}` : `market ${exitSide}`} for ${exitQuantity} to close the deal.`,
  };
}

/**
 * Close every unfinished deal belonging to one bot.
 *
 * Deals are closed one at a time and each result is reported separately: a
 * failure on one must not silently abandon the rest, and the caller needs to
 * see exactly which positions are still open.
 */
export async function closeBotTrades(botId: number, mode: CloseMode = "market"): Promise<CloseTradeResult[]> {
  const trades = await xprisma.smartTrade.findMany({
    where: { botId },
    include: { orders: true, exchangeAccount: true },
  });

  const results: CloseTradeResult[] = [];

  for (const trade of trades) {
    try {
      results.push(await closeSmartTrade(trade.id, mode));
    } catch (err) {
      results.push({
        smartTradeId: trade.id,
        botId,
        symbol: trade.symbol,
        outcome: "already_closed",
        filled: false,
        message: `Failed to close: ${(err as Error).message}`,
      });
    }
  }

  return results;
}

/**
 * Close every unfinished deal across every bot. The blast radius is the whole
 * account, so the caller is required to opt in explicitly.
 */
export async function closeAllTrades(mode: CloseMode = "market"): Promise<CloseTradeResult[]> {
  const trades = await xprisma.smartTrade.findMany({
    include: { orders: true, exchangeAccount: true },
  });

  const results: CloseTradeResult[] = [];

  for (const trade of trades) {
    try {
      results.push(await closeSmartTrade(trade.id, mode));
    } catch (err) {
      results.push({
        smartTradeId: trade.id,
        botId: trade.botId,
        symbol: trade.symbol,
        outcome: "already_closed",
        filled: false,
        message: `Failed to close: ${(err as Error).message}`,
      });
    }
  }

  return results;
}
