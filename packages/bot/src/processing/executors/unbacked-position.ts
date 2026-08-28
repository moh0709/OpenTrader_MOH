/**
 * Clearing positions the exchange never filled.
 *
 * An entry is only real if an exchange gave it an order id. A row that reads
 * `Filled` with no id is a position nothing was ever paid for: no order, no fee,
 * no inventory. See ../bot/entry-integrity.ts for how these came to exist, and
 * why a strategy can no longer create one.
 *
 * They cannot simply be deleted. Each one usually carries a take profit that IS
 * real and IS resting on the exchange, waiting to sell inventory the account
 * does not hold. Deleting the row would leave that order live with nothing in
 * the database describing it, which is the failure `purge-bot.ts` warns about.
 * So the exit is cancelled through the platform executor first, and the rows are
 * then corrected rather than removed: a fabricated position is still something
 * you want to be able to read about afterwards.
 *
 * What gets written back is the truth about the entry. It was never placed and
 * never filled, so `filledPrice`, `filledAt`, `placedAt` and `fee` return to
 * null and the order becomes `Revoked`. Selection is by `exchangeOrderId: null`
 * alone, so a position the exchange really filled can never match.
 */
import { xprisma } from "@opentrader/db";
import { exchangeProvider } from "@opentrader/exchanges";
import { logger } from "@opentrader/logger";
import { OrderExecutor } from "./order/order.executor.js";

/**
 * Minimal row shapes, declared locally so this file typechecks in a clean
 * checkout where the workspace declaration files have not been generated.
 */
type OrderRow = {
  id: number;
  status: string;
  entityType: string;
  side: string;
  price: number | null;
  filledPrice: number | null;
  quantity: number;
  exchangeOrderId: string | null;
};

type TradeRow = {
  id: number;
  botId: number | null;
  ref: string | null;
  symbol: string;
  exchangeAccountId: number;
  orders: OrderRow[];
  bot: { name: string; enabled: boolean } | null;
};

const ENTRY_TYPES = ["EntryOrder", "SafetyOrder"];
const EXIT_TYPES = ["TakeProfitOrder", "StopLossOrder"];
const LIVE_STATUSES = ["Idle", "Placed"];

export type UnbackedPosition = {
  smartTradeId: number;
  botId: number | null;
  botName: string;
  symbol: string;
  quantity: number;
  /** Cost basis the fabricated fill claimed. Never actually spent. */
  claimedCost: number;
  /** Real exchange orders that would be cancelled to clear it. */
  liveExitOrders: number;
  /** Set when clearing would be refused, explaining why. */
  blockedReason: string | null;
};

export type ClearResult = {
  smartTradeId: number;
  botId: number | null;
  symbol: string;
  claimedCost: number;
  exitsCancelled: number;
  cancelFailures: number;
  /** The ref was released, so the bot can build a fresh level here. */
  detached: boolean;
  error: string | null;
};

const isEntry = (order: OrderRow) => ENTRY_TYPES.includes(order.entityType);
const isExit = (order: OrderRow) => EXIT_TYPES.includes(order.entityType);
const isLive = (order: OrderRow) => LIVE_STATUSES.includes(order.status);

/** An entry the strategy called filled that no exchange ever touched. */
const isUnbackedFill = (order: OrderRow) =>
  isEntry(order) && order.status === "Filled" && order.exchangeOrderId === null;

/** True once an exit has filled: the cycle is history, not live exposure. */
const isClosed = (orders: OrderRow[]) => orders.some((order) => isExit(order) && order.status === "Filled");

/** An entry a previous clearing run wrote off. */
const wasWrittenOff = (order: OrderRow) =>
  isEntry(order) && order.status === "Revoked" && order.exchangeOrderId === null;

/**
 * A level that is finished and cannot come back, but still carries the `ref` its
 * bot finds it by.
 *
 * A grid adopts one trade per ladder line by ref. Adopting a written-off line
 * means adopting orders that are all terminal, and `isCompleted()` is false for
 * them because the entry never filled - so the grid neither trades it nor
 * replaces it, and that rung is dead for as long as the ref survives. Detaching
 * is safe by construction here: nothing is held and nothing is resting.
 */
const isDeadLevel = (trade: TradeRow) =>
  trade.ref !== null &&
  trade.orders.some(wasWrittenOff) &&
  !trade.orders.some(isLive) &&
  !trade.orders.some((order) => order.status === "Filled" && order.exchangeOrderId !== null);

async function load(ownerId: number, botId?: number): Promise<TradeRow[]> {
  return (await xprisma.smartTrade.findMany({
    where: { ownerId, ...(botId === undefined ? {} : { botId }) },
    include: { orders: true, bot: { select: { name: true, enabled: true } } },
    orderBy: { id: "asc" },
  })) as unknown as TradeRow[];
}

/**
 * What clearing would act on. Read-only, so seeing the damage never requires
 * permission to change anything.
 */
export async function findUnbackedPositions(ownerId: number, botId?: number): Promise<UnbackedPosition[]> {
  const trades = await load(ownerId, botId);
  const found: UnbackedPosition[] = [];

  for (const trade of trades) {
    if (isClosed(trade.orders)) continue;

    const unbacked = trade.orders.filter(isUnbackedFill);
    if (unbacked.length === 0) continue;

    found.push({
      smartTradeId: trade.id,
      botId: trade.botId,
      botName: trade.bot?.name ?? "unknown",
      symbol: trade.symbol,
      quantity: unbacked.reduce((total, order) => total + order.quantity, 0),
      claimedCost: unbacked.reduce(
        (total, order) => total + (order.filledPrice ?? order.price ?? 0) * order.quantity,
        0,
      ),
      liveExitOrders: trade.orders.filter((order) => isExit(order) && isLive(order)).length,
      // A running bot re-creates its levels within seconds, so clearing
      // underneath one produces a half-state rather than a clean slate.
      blockedReason: trade.bot?.enabled ? `Bot ${trade.bot.name} is still running. Stop it first.` : null,
    });
  }

  return found;
}

/**
 * Cancel the real exits, then write the truth back over the fabricated entry.
 *
 * Refuses any trade whose bot is still running, and reports per trade rather
 * than aborting the batch, so one exchange error cannot strand the rest.
 */
export async function clearUnbackedPositions(ownerId: number, botId?: number): Promise<ClearResult[]> {
  const trades = await load(ownerId, botId);
  const results: ClearResult[] = [];

  for (const trade of trades) {
    if (isClosed(trade.orders)) continue;

    const unbacked = trade.orders.filter(isUnbackedFill);

    // Left behind by an earlier run of this operation, before it knew to release
    // the ref. Releasing it now is the whole of the repair.
    if (unbacked.length === 0) {
      if (!isDeadLevel(trade) || trade.bot?.enabled) continue;

      await xprisma.smartTrade.update({ where: { id: trade.id }, data: { ref: null } });
      logger.warn(`[clearUnbacked] Trade ${trade.id}: released ref "${trade.ref}" from a written-off level.`);

      results.push({
        smartTradeId: trade.id,
        botId: trade.botId,
        symbol: trade.symbol,
        claimedCost: 0,
        exitsCancelled: 0,
        cancelFailures: 0,
        detached: true,
        error: null,
      });
      continue;
    }

    const claimedCost = unbacked.reduce(
      (total, order) => total + (order.filledPrice ?? order.price ?? 0) * order.quantity,
      0,
    );
    const base = { smartTradeId: trade.id, botId: trade.botId, symbol: trade.symbol, claimedCost };

    if (trade.bot?.enabled) {
      results.push({
        ...base,
        exitsCancelled: 0,
        cancelFailures: 0,
        detached: false,
        error: `Bot ${trade.bot.name} is still running. Stop it first.`,
      });
      continue;
    }

    const account = await xprisma.exchangeAccount.findUnique({ where: { id: trade.exchangeAccountId } });
    if (!account) {
      results.push({ ...base, exitsCancelled: 0, cancelFailures: 0, detached: false, error: "Exchange account not found." });
      continue;
    }

    const exchange = exchangeProvider.fromAccount(account as never);
    let cancelled = 0;
    let failures = 0;

    // The exits are real orders on a real book, so they go first. One left
    // resting after its position is written off would sell what nobody owns.
    for (const order of trade.orders.filter((o) => isExit(o) && isLive(o))) {
      try {
        await new OrderExecutor(order as never, exchange, trade.symbol).cancel();
        cancelled += 1;
      } catch (err) {
        failures += 1;
        logger.error(
          `[clearUnbacked] Trade ${trade.id}: could not cancel exit ${order.id}: ${(err as Error).message}`,
        );
      }
    }

    if (failures > 0) {
      results.push({
        ...base,
        exitsCancelled: cancelled,
        cancelFailures: failures,
        detached: false,
        error: "Left the entry untouched because an exit could not be cancelled; retry once the exchange responds.",
      });
      continue;
    }

    for (const order of unbacked) {
      await xprisma.order.update({
        where: { id: order.id },
        data: { status: "Revoked", filledPrice: null, filledAt: null, placedAt: null, fee: null },
      });
    }

    // Nothing is held and nothing is resting, so the ref may go - and must, or
    // the bot re-adopts a dead rung and never trades that level again.
    await xprisma.smartTrade.update({ where: { id: trade.id }, data: { ref: null } });

    logger.warn(
      `[clearUnbacked] Trade ${trade.id} (${trade.symbol}): wrote off ${claimedCost.toFixed(2)} of cost basis that ` +
        `was never spent, and cancelled ${cancelled} exit order(s) resting against inventory never bought.`,
    );

    results.push({ ...base, exitsCancelled: cancelled, cancelFailures: 0, detached: true, error: null });
  }

  return results;
}
