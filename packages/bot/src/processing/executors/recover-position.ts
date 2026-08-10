/**
 * Recovering a stranded position.
 *
 * A position is stranded when its entry filled but its exit was cancelled - the
 * asset is owned and nothing is able to sell it. Historically that happened
 * every time a bot stopped (see ./stop-policy.ts, which now prevents it), and it
 * leaves capital committed indefinitely because the trade also lost the `ref`
 * its bot identified it by.
 *
 * Recovery places a fresh exit at the price the cancelled one carried, using the
 * platform's own OrderExecutor rather than writing exchange state by hand. Once
 * the order is Placed, `ExchangeAccountProcessor.syncOrders()` picks it up like
 * any other - it selects on `status: Placed` and an enabled bot, not on the ref -
 * so the fill is recorded normally and the profit is realised.
 */
import { xprisma } from "@opentrader/db";
import { exchangeProvider } from "@opentrader/exchanges";
import { logger } from "@opentrader/logger";
import { OrderExecutor } from "./order/order.executor.js";
import { holdsPosition } from "./stop-policy.js";

/**
 * Minimal row shapes, declared locally so this file typechecks in a clean
 * checkout where the workspace declaration files have not been generated.
 * Structurally compatible with the generated Prisma models.
 */
type OrderRow = {
  id: number;
  status: string;
  entityType: string;
  side: string;
  price: number | null;
  filledPrice: number | null;
  quantity: number;
  updatedAt: Date;
};

const ENTRY_TYPES = ["EntryOrder", "SafetyOrder"];
const EXIT_TYPES = ["TakeProfitOrder", "StopLossOrder"];
const LIVE_STATUSES = ["Idle", "Placed"];

export type RecoverablePosition = {
  smartTradeId: number;
  botId: number | null;
  botName: string;
  botEnabled: boolean;
  symbol: string;
  quantity: number;
  entryPrice: number;
  /** The price the cancelled exit carried; where the new one will be placed. */
  targetPrice: number | null;
  /** Profit if the replacement exit fills at that price. */
  expectedPnl: number | null;
  /** Populated when the position cannot be recovered, explaining why. */
  blockedReason: string | null;
};

/**
 * Every held position with no live exit, and whether it can be recovered.
 *
 * Read-only: this is what a dry run reports.
 */
export async function findStrandedPositions(ownerId: number, botId?: number): Promise<RecoverablePosition[]> {
  const trades = (await xprisma.smartTrade.findMany({
    where: { ownerId, ...(botId === undefined ? {} : { botId }) },
    include: { orders: true, bot: true },
  })) as Array<{
    id: number;
    botId: number | null;
    symbol: string;
    orders: OrderRow[];
    bot: { name: string; enabled: boolean } | null;
  }>;

  const stranded: RecoverablePosition[] = [];

  for (const trade of trades) {
    const orders = trade.orders;
    if (!holdsPosition(orders)) continue;
    // A live exit means the position is working, not stranded.
    if (orders.some((o) => EXIT_TYPES.includes(o.entityType) && LIVE_STATUSES.includes(o.status))) continue;

    const entries = orders.filter((o) => ENTRY_TYPES.includes(o.entityType) && o.status === "Filled");
    const quantity = entries.reduce((sum, o) => sum + o.quantity, 0);
    const cost = entries.reduce((sum, o) => sum + (o.filledPrice ?? 0) * o.quantity, 0);
    const entryPrice = quantity > 0 ? cost / quantity : 0;

    // The most recently cancelled exit carries the target this position was aiming at.
    const cancelledExit = orders
      .filter((o) => EXIT_TYPES.includes(o.entityType) && o.price !== null)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];

    const targetPrice = cancelledExit?.price ?? null;

    let blockedReason: string | null = null;
    if (quantity <= 0) blockedReason = "No filled entry quantity";
    else if (targetPrice === null) blockedReason = "No cancelled exit to take a target price from";
    else if (!trade.bot) blockedReason = "Trade is not attached to a bot";
    else if (!trade.bot.enabled) blockedReason = "Bot is stopped, so a placed order would not be tracked";

    stranded.push({
      smartTradeId: trade.id,
      botId: trade.botId,
      botName: trade.bot?.name ?? `Bot ${trade.botId}`,
      botEnabled: trade.bot?.enabled ?? false,
      symbol: trade.symbol,
      quantity,
      entryPrice,
      targetPrice,
      expectedPnl: targetPrice !== null ? (targetPrice - entryPrice) * quantity : null,
      blockedReason,
    });
  }

  return stranded.sort((a, b) => (b.expectedPnl ?? 0) - (a.expectedPnl ?? 0));
}

export type RecoveryResult = {
  smartTradeId: number;
  placed: boolean;
  orderId: number | null;
  price: number | null;
  quantity: number;
  error: string | null;
};

/**
 * Place a replacement exit for one stranded position.
 *
 * Creates a new take profit order and places it through OrderExecutor, so the
 * exchange call, the status transition and the id bookkeeping are all the
 * platform's own. Returns without placing if the position is not actually
 * stranded, which makes the operation safe to retry.
 */
export async function recoverPosition(smartTradeId: number, ownerId: number): Promise<RecoveryResult> {
  const trade = (await xprisma.smartTrade.findFirst({
    where: { id: smartTradeId, ownerId },
    include: { orders: true, exchangeAccount: true, bot: true },
  })) as {
    id: number;
    symbol: string;
    exchangeAccountId: number;
    orders: OrderRow[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- credentials shape comes from the db extension
    exchangeAccount: any;
    bot: { enabled: boolean } | null;
  } | null;

  const fail = (error: string): RecoveryResult => ({
    smartTradeId,
    placed: false,
    orderId: null,
    price: null,
    quantity: 0,
    error,
  });

  if (!trade) return fail("Trade not found");
  if (!holdsPosition(trade.orders)) return fail("Position is not held, nothing to recover");
  if (trade.orders.some((o) => EXIT_TYPES.includes(o.entityType) && LIVE_STATUSES.includes(o.status))) {
    return fail("Position already has a live exit order");
  }
  if (!trade.bot?.enabled) return fail("Bot is stopped, so a placed order would not be tracked");

  const entries = trade.orders.filter((o) => ENTRY_TYPES.includes(o.entityType) && o.status === "Filled");
  const quantity = entries.reduce((sum, o) => sum + o.quantity, 0);
  if (quantity <= 0) return fail("No filled entry quantity");

  const cancelledExit = trade.orders
    .filter((o) => EXIT_TYPES.includes(o.entityType) && o.price !== null)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];

  if (!cancelledExit?.price) return fail("No cancelled exit to take a target price from");

  const created = (await xprisma.order.create({
    data: {
      status: "Idle",
      type: "Limit",
      entityType: "TakeProfitOrder",
      side: "Sell",
      price: cancelledExit.price,
      quantity,
      symbol: trade.symbol,
      exchangeAccountId: trade.exchangeAccountId,
      smartTradeId: trade.id,
    },
  })) as OrderRow & { symbol: string; exchangeAccountId: number; smartTradeId: number };

  try {
    const exchange = exchangeProvider.fromAccount(trade.exchangeAccount);
    const executor = new OrderExecutor(created as never, exchange, trade.symbol);
    const placed = await executor.place();

    if (!placed) {
      await xprisma.order.update({ where: { id: created.id }, data: { status: "Revoked" } });
      return fail("Exchange rejected the order");
    }

    logger.info(
      `[Recovery] Replaced the exit for stranded position ${trade.id}: Sell ${quantity} ${trade.symbol} at ${cancelledExit.price}`,
    );

    return {
      smartTradeId: trade.id,
      placed: true,
      orderId: created.id,
      price: cancelledExit.price,
      quantity,
      error: null,
    };
  } catch (err) {
    // Do not leave a dangling Idle order behind a failed placement.
    await xprisma.order.update({ where: { id: created.id }, data: { status: "Revoked" } }).catch(() => undefined);

    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[Recovery] Could not recover position ${trade.id}: ${message}`);

    return fail(message);
  }
}

/**
 * Recover many positions.
 *
 * Sequential on purpose: each placement is an exchange call, and a burst of
 * hundreds in parallel is a good way to get rate limited mid-run. `limit` caps
 * a single invocation so recovery can be done in reviewable batches.
 */
export async function recoverPositions(
  ownerId: number,
  options: { botId?: number; limit?: number } = {},
): Promise<{ attempted: number; placed: number; failed: number; results: RecoveryResult[] }> {
  const candidates = (await findStrandedPositions(ownerId, options.botId))
    .filter((position) => position.blockedReason === null)
    .slice(0, options.limit ?? 50);

  const results: RecoveryResult[] = [];
  for (const candidate of candidates) {
    results.push(await recoverPosition(candidate.smartTradeId, ownerId));
  }

  return {
    attempted: results.length,
    placed: results.filter((r) => r.placed).length,
    failed: results.filter((r) => !r.placed).length,
    results,
  };
}
