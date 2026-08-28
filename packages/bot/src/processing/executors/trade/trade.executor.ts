import { xprisma } from "@opentrader/db";
import type { SmartTradeWithOrders, ExchangeAccountWithCredentials } from "@opentrader/db";
import type { IExchange } from "@opentrader/exchanges";
import { exchangeProvider } from "@opentrader/exchanges";
import { logger } from "@opentrader/logger";
import { ITicker, XEntityType, XOrderType } from "@opentrader/types";
import type { ISmartTradeExecutor, SmartTradeContext } from "../smart-trade-executor.interface.js";
import { OrderExecutor } from "../order/order.executor.js";
import { decomposeSymbol } from "@opentrader/tools";
import { canClearRef, shouldCancelOnStop } from "../stop-policy.js";
import { allowsEntry, committedCapital, exitPriceForMinProfit, orderNotional, toBotLimits, withBotEntryLock } from "../bot-limits.js";
import { evaluateTrailing, type TrailingState } from "../../../trailing-policy.js";

export class TradeExecutor implements ISmartTradeExecutor {
  smartTrade: SmartTradeWithOrders;
  exchange: IExchange;

  constructor(smartTrade: SmartTradeWithOrders, exchange: IExchange) {
    this.smartTrade = smartTrade;
    this.exchange = exchange;
  }

  static create(smartTrade: SmartTradeWithOrders, exchangeAccount: ExchangeAccountWithCredentials) {
    const exchange = exchangeProvider.fromAccount(exchangeAccount);

    return new TradeExecutor(smartTrade, exchange);
  }

  static async fromId(id: number) {
    const smartTrade = await xprisma.smartTrade.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        orders: true,
        exchangeAccount: true,
      },
    });

    const exchange = exchangeProvider.fromAccount(smartTrade.exchangeAccount);

    return new TradeExecutor(smartTrade, exchange);
  }

  static async fromOrderId(orderId: number) {
    const order = await xprisma.order.findUniqueOrThrow({
      where: {
        id: orderId,
      },
      include: {
        smartTrade: {
          include: {
            orders: true,
            exchangeAccount: true,
          },
        },
      },
    });

    const exchange = exchangeProvider.fromAccount(order.smartTrade.exchangeAccount);

    return new TradeExecutor(order.smartTrade, exchange);
  }

  static async fromExchangeOrderId(exchangeOrderId: string) {
    const order = await xprisma.order.findFirstOrThrow({
      where: {
        exchangeOrderId,
      },
      include: {
        smartTrade: {
          include: {
            orders: true,
            exchangeAccount: true,
          },
        },
      },
    });

    const exchange = exchangeProvider.fromAccount(order.smartTrade.exchangeAccount);

    return new TradeExecutor(order.smartTrade, exchange);
  }

  /**
   * Places the entry order and take profit order on the exchange.
   * Returns `true` if the order was placed successfully.
   */
  async next(market?: SmartTradeContext) {
    const entryOrder = this.smartTrade.orders.find((order) => order.entityType === "EntryOrder")!;
    const takeProfitOrder = this.smartTrade.orders.find((order) => order.entityType === "TakeProfitOrder");
    const stopLossOrder = this.smartTrade.orders.find((order) => order.entityType === XEntityType.StopLossOrder);
    const { baseCurrency, quoteCurrency } = decomposeSymbol(this.smartTrade.symbol);

    if (entryOrder.status === "Idle") {
      return withBotEntryLock(this.smartTrade.botId ?? -1, async () => {
        // A grid will place an entry on every level it has, which is usually far
        // more money than intended to expose. The cap is checked while holding a
        // per-bot lock, so concurrent grid workers cannot bypass it.
        const limits = await this.botLimits();

        if (limits.maxCapital !== null) {
          const trades = await xprisma.smartTrade.findMany({
            where: { botId: this.smartTrade.botId ?? undefined },
            include: { orders: true },
          });

          // Exclude this entry: it is already stored as Idle, so leaving it in
          // would count it once as committed and again as the order being added.
          const committed = committedCapital(trades, entryOrder.id);
          const decision = allowsEntry(limits, committed, orderNotional(entryOrder));
          if (!decision.allowed) {
            logger.info(`[TradeExecutor] Skipped entry for [ST - ${this.smartTrade.ref}]: ${decision.reason}`);

            return false;
          }
        }

        const orderExecutor = new OrderExecutor(entryOrder, this.exchange, this.smartTrade.symbol);
        await orderExecutor.place();
        await this.pull();

        const quoteLogValue = entryOrder.price ? entryOrder.quantity * entryOrder.price : "?";
        const priceLogValue = entryOrder.price ? entryOrder.price : "Market";
        logger.info(
          `[TradeExecutor] Placed entry ${entryOrder.side} ${entryOrder.quantity} ${baseCurrency} for ${quoteLogValue} ${quoteCurrency} at ${priceLogValue}`,
        );

        return true;
      });
    } else if (entryOrder.status === "Filled" && takeProfitOrder?.status === "Idle") {
      // Grid spacing is set in price, so a tight grid on a small quantity can
      // close for fractions of a cent. Lift the exit to the price that actually
      // earns the floor, rather than blocking it and stranding the position.
      const limits = await this.botLimits();

      if (limits.minProfit !== null && takeProfitOrder.price !== null && entryOrder.filledPrice !== null) {
        const lifted = exitPriceForMinProfit(
          limits,
          entryOrder.filledPrice,
          takeProfitOrder.quantity,
          takeProfitOrder.price,
        );

        if (lifted > takeProfitOrder.price) {
          await xprisma.order.update({ where: { id: takeProfitOrder.id }, data: { price: lifted } });
          await this.pull();

          logger.info(
            `[TradeExecutor] Raised take profit of [ST - ${this.smartTrade.ref}] from ${takeProfitOrder.price} to ${lifted} to meet the ${limits.minProfit} minimum profit.`,
          );
        }
      }

      const takeProfit = this.smartTrade.orders.find((order) => order.entityType === "TakeProfitOrder")!;
      const orderExecutor = new OrderExecutor(takeProfit, this.exchange, this.smartTrade.symbol);
      await orderExecutor.place();
      await this.pull();

      const quoteLogValue = takeProfitOrder.price ? takeProfitOrder.quantity * takeProfitOrder.price : "?";
      const priceLogValue = takeProfitOrder.price ? takeProfitOrder.price : "Market";
      logger.info(
        `[TradeExecutor] Placed take profit ${takeProfitOrder.side} ${takeProfitOrder.quantity} ${baseCurrency} for ${quoteLogValue} ${quoteCurrency} at ${priceLogValue}`,
      );

      return true;
    }

    if (await this.applyAdaptiveTrailing(market)) return true;

    const stopLossActivated =
      market?.ticker && stopLossOrder?.stopPrice ? market.ticker.bid <= stopLossOrder.stopPrice : false;
    if (
      entryOrder.status === "Filled" &&
      takeProfitOrder?.status === "Placed" &&
      stopLossOrder?.status === "Idle" &&
      stopLossActivated
    ) {
      // Cancel TP
      const tpOrder = new OrderExecutor(takeProfitOrder, this.exchange, this.smartTrade.symbol);
      await tpOrder.cancel();

      // Place SL
      const slOrder = new OrderExecutor(stopLossOrder, this.exchange, this.smartTrade.symbol);
      await slOrder.place();

      await this.pull();

      const quoteLogValue = stopLossOrder.price ? stopLossOrder.quantity * stopLossOrder.price : "?";
      const priceLogValue = stopLossOrder.price ? stopLossOrder.price : "Market";
      logger.info(
        `[TradeExecutor] Placed stop loss ${stopLossOrder.side} ${stopLossOrder.quantity} ${baseCurrency} for ${quoteLogValue} ${quoteCurrency} at ${priceLogValue}`,
      );

      return true;
    }

    return false;
  }

  async onOrderFilled() {
    return this.next();
  }

  async onTicker(ticker: ITicker, atr = 0) {
    await this.next({ ticker, atr });
  }

  /**
   * Optional, explicitly enabled adaptive exit. Fixed TP remains the default.
   * State is persisted on Bot.state so a daemon restart cannot forget a peak.
   */
  private async applyAdaptiveTrailing(market?: SmartTradeContext): Promise<boolean> {
    if (!market?.ticker || !this.smartTrade.botId || !market.atr) return false;

    const entry = this.smartTrade.orders.find((order) => order.entityType === XEntityType.EntryOrder);
    const takeProfit = this.smartTrade.orders.find((order) => order.entityType === XEntityType.TakeProfitOrder);
    if (!entry || entry.status !== "Filled" || entry.filledPrice === null || !takeProfit || takeProfit.status !== "Placed") {
      return false;
    }

    const bot = (await xprisma.bot.findUnique({
      where: { id: this.smartTrade.botId },
      select: { state: true, settings: true, minProfit: true },
    })) as unknown as { state: unknown; settings: unknown; minProfit: number | null } | null;
    if (!bot) return false;

    const settings = typeof bot.settings === "string" ? JSON.parse(bot.settings) : bot.settings;
    if (!settings?.adaptiveTrailing?.enabled) return false;

    const rawState = typeof bot.state === "string" ? JSON.parse(bot.state) : bot.state;
    const trailing: Record<string, TrailingState> = rawState?.adaptiveTrailing ?? {};
    const previous = trailing[String(this.smartTrade.id)] ?? {
      active: false,
      highestPrice: entry.filledPrice,
    };
    const policy = settings.adaptiveTrailing;
    const decision = evaluateTrailing(
      previous,
      {
        entryPrice: entry.filledPrice,
        quantity: entry.quantity,
        entryFee: entry.fee ?? 0,
        minProfit: bot.minProfit ?? policy.minProfit ?? 0,
        exitFeeRate: policy.exitFeeRate ?? 0.0005,
        atrMultiplier: policy.atrMultiplier ?? 1.5,
        minTrailDistance: policy.minTrailDistance ?? 0,
        activationAtrMultiple: policy.activationAtrMultiple ?? 0.5,
      },
      { price: market.ticker.last, atr: market.atr, timestamp: market.ticker.timestamp },
    );

    trailing[String(this.smartTrade.id)] = decision.state;
    await xprisma.bot.update({ where: { id: this.smartTrade.botId }, data: { state: JSON.stringify({ ...rawState, adaptiveTrailing: trailing }) } });

    if (decision.action === "exit") {
      const executor = new OrderExecutor(takeProfit, this.exchange, this.smartTrade.symbol);
      await executor.modify({ ...takeProfit, type: XOrderType.Market, price: null });
      logger.info(`[AdaptiveTrailing] Market exit requested for [ST - ${this.smartTrade.id}] at ${market.ticker.last}.`);
      return true;
    }

    if ((decision.action === "activate" || decision.action === "raise") && decision.state.trailPrice !== undefined) {
      const runnerTarget = Math.max(takeProfit.price ?? 0, market.ticker.last + Math.max(market.atr * (policy.atrMultiplier ?? 1.5), policy.minTrailDistance ?? 0));
      if (runnerTarget > (takeProfit.price ?? 0)) {
        const executor = new OrderExecutor(takeProfit, this.exchange, this.smartTrade.symbol);
        await executor.modify({ ...takeProfit, type: XOrderType.Limit, price: runnerTarget });
        logger.info(`[AdaptiveTrailing] Raised TP for [ST - ${this.smartTrade.id}] to ${runnerTarget}; trail ${decision.state.trailPrice}.`);
        return true;
      }
    }

    return false;
  }

  /** The owning bot's limits, or none when the trade has no bot. */
  private async botLimits() {
    if (this.smartTrade.botId === null) return toBotLimits(null);

    const bot = (await xprisma.bot.findUnique({
      where: { id: this.smartTrade.botId },
      select: { maxCapital: true, minProfit: true },
    })) as { maxCapital: number | null; minProfit: number | null } | null;

    return toBotLimits(bot);
  }

  /**
   * Cancel all orders linked to the smart trade.
   * Return number of cancelled orders.
   */
  async cancelOrders(): Promise<number> {
    const allOrders = [];

    // Exits protecting a held position are left working: cancelling them would
    // strand the position with no way to close. See ../stop-policy.ts.
    const kept = [];

    for (const order of this.smartTrade.orders) {
      if (!shouldCancelOnStop(order, this.smartTrade.orders)) {
        kept.push(order.id);
        continue;
      }

      const orderExecutor = new OrderExecutor(order, this.exchange, this.smartTrade.symbol);

      const cancelled = await orderExecutor.cancel();
      allOrders.push(cancelled);
    }

    // A bot re-adopts its trades by ref, so a held position must keep it.
    if (canClearRef(this.smartTrade.orders)) await xprisma.smartTrade.clearRef(this.smartTrade.id);
    await this.pull();

    const cancelledOrders = allOrders.filter((cancelled) => cancelled);
    logger.info(
      `[TradeExecutor] Cancelled ${cancelledOrders.length} of ${allOrders.length} orders of [ST - ${this.smartTrade.ref}].` +
        (kept.length > 0 ? ` Kept ${kept.length} exit order(s) working: the position is still held.` : ""),
    );

    return cancelledOrders.length;
  }

  get status(): "Entering" | "Exiting" | "Finished" {
    const entryOrder = this.smartTrade.orders.find((order) => order.entityType === "EntryOrder")!;
    const takeProfitOrder = this.smartTrade.orders.find((order) => order.entityType === "TakeProfitOrder");
    const stopLossOrder = this.smartTrade.orders.find((order) => order.entityType === XEntityType.StopLossOrder);

    if (entryOrder.status === "Idle" || entryOrder.status === "Placed") {
      return "Entering";
    }

    if (
      entryOrder.status === "Filled" &&
      (!takeProfitOrder || takeProfitOrder.status === "Filled") &&
      (!stopLossOrder || stopLossOrder.status === "Filled")
    ) {
      return "Finished";
    }

    return "Exiting";
  }

  /**
   * Pulls the order from the database to update the status.
   * Call directly only for testing.
   */
  async pull() {
    this.smartTrade = await xprisma.smartTrade.findUniqueOrThrow({
      where: {
        id: this.smartTrade.id,
      },
      include: {
        orders: true,
        exchangeAccount: true,
      },
    });
  }
}
