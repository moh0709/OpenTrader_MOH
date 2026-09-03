import type { Candle, HeadAction, OpenPosition } from "@opentrader/ai-team";
import { xprisma } from "@opentrader/db";
import { XEntityType, XOrderStatus } from "@opentrader/types";
import { AUTOPILOT_REF_PREFIX } from "../trade-opener.js";
import { lastExitRequest } from "./journal.js";

/**
 * The book, as the trading head sees it.
 *
 * Reconstructed from orders rather than tracked in memory. A position is what
 * the exchange filled, not what the head believes it filled, and the difference
 * between those two is where trading systems lose money quietly. Reading it
 * back every pass costs one query and removes a whole class of drift.
 *
 * Only deals tagged into the autopilot lane are visible here. Positions a
 * strategy opened belong to that strategy, and the head must not close them
 * — two things managing one position is worse than neither.
 */

type OrderRow = {
  entityType: string;
  status: string;
  side: string;
  price: number | null;
  filledPrice: number | null;
  fee: number | null;
  quantity: number;
  filledAt: Date | null;
};

type TradeRow = {
  id: number;
  symbol: string;
  botId: number | null;
  createdAt: Date;
  orders: OrderRow[];
};

/** Exit legs, in the two shapes OpenTrader records them. */
const EXIT_TYPES: string[] = [XEntityType.TakeProfitOrder, XEntityType.StopLossOrder];

function entryOf(trade: TradeRow): OrderRow | undefined {
  return trade.orders.find((order) => order.entityType === XEntityType.EntryOrder);
}

function exitOf(trade: TradeRow): OrderRow | undefined {
  return trade.orders.find((order) => EXIT_TYPES.includes(order.entityType));
}

/**
 * The highest price since a position was opened, read off the candles.
 *
 * The alternative — a high-water mark kept in a column and updated every pass —
 * is wrong after any restart that misses a spike, and needs a write on a loop
 * that otherwise only reads. The candles already hold this, exactly, for free.
 *
 * Falls back to the entry price when no candle covers the position's life, so a
 * trailing rule can never fire on a peak that was never observed.
 */
export function peakSince(candles: Candle[], openedAt: number, entryPrice: number): number {
  let peak = entryPrice;

  for (const candle of candles) {
    if (candle.timestamp < openedAt) continue;
    if (candle.high > peak) peak = candle.high;
  }

  return peak;
}

/**
 * Open autopilot positions, keyed by symbol.
 *
 * "Open" means the entry filled and no exit has. An entry still resting is not
 * a position — nothing is held — and is deliberately not reported as one, so
 * the head neither trails it nor stops it out.
 */
export async function loadOpenPositions(botId: number): Promise<Map<string, OpenPosition>> {
  const trades = (await xprisma.smartTrade.findMany({
    where: { botId, ref: { startsWith: AUTOPILOT_REF_PREFIX } },
    include: { orders: true },
    orderBy: { createdAt: "asc" },
  })) as unknown as TradeRow[];

  const out = new Map<string, OpenPosition>();

  for (const trade of trades) {
    const entry = entryOf(trade);
    if (!entry || entry.status !== XOrderStatus.Filled) continue;

    const exit = exitOf(trade);
    if (exit && exit.status === XOrderStatus.Filled) continue;

    const entryPrice = entry.filledPrice ?? entry.price ?? 0;
    if (entryPrice <= 0 || entry.quantity <= 0) continue;

    const openedAt = (entry.filledAt ?? trade.createdAt).getTime();

    // One position per symbol. With pyramiding off there is only ever one; with
    // it on, the oldest is the one the exit rules manage, because closing the
    // newest first would leave the trade that has had longest to go wrong open.
    if (out.has(trade.symbol)) continue;

    // Whether the head has already told the exchange to sell this. Without it
    // the loop would re-issue the same exit every minute until the fill landed.
    const requested = await lastExitRequest(trade.id);

    out.set(trade.symbol, {
      smartTradeId: trade.id,
      symbol: trade.symbol,
      quantity: entry.quantity,
      entryPrice,
      entryFeeQuote: entry.fee ?? 0,
      openedAt,
      // Filled in by the caller, which has the candles.
      peakPrice: entryPrice,
      takeProfitPrice: exit?.price ?? null,
      exitRequestedAt: requested?.at ?? null,
      exitRequestedAction: (requested?.action as HeadAction | undefined) ?? null,
    });
  }

  return out;
}

export type BookSummary = {
  openPositions: number;
  openExposureQuote: number;
  realizedPnlToday: number;
  consecutiveLosses: number;
};

function startOfToday(now: number): number {
  const date = new Date(now);

  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Everything the head needs to know about its own book, in one read.
 *
 * Realised profit and loss is computed from filled orders only, so a deal whose
 * exit is still working counts as neither a win nor a loss. That matters for
 * the streak: an exit in flight is not yet a result, and treating it as one
 * would halt the desk on a trade that had not finished losing or winning.
 */
export async function summariseBook(botId: number, now = Date.now()): Promise<BookSummary> {
  const trades = (await xprisma.smartTrade.findMany({
    where: { botId, ref: { startsWith: AUTOPILOT_REF_PREFIX } },
    include: { orders: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  })) as unknown as TradeRow[];

  const dayStart = startOfToday(now);

  let openPositions = 0;
  let openExposureQuote = 0;
  let realizedPnlToday = 0;

  /** Closed cycles, newest first, for the streak count. */
  const closed: { pnl: number; at: number }[] = [];

  for (const trade of trades) {
    const entry = entryOf(trade);
    if (!entry) continue;

    const exit = exitOf(trade);
    const entryPrice = entry.filledPrice ?? entry.price ?? 0;

    if (entry.status === XOrderStatus.Filled && exit?.status === XOrderStatus.Filled) {
      const exitPrice = exit.filledPrice ?? exit.price ?? 0;
      const pnl = (exitPrice - entryPrice) * entry.quantity - (entry.fee ?? 0) - (exit.fee ?? 0);
      const closedAt = (exit.filledAt ?? trade.createdAt).getTime();

      closed.push({ pnl, at: closedAt });
      if (closedAt >= dayStart) realizedPnlToday += pnl;

      continue;
    }

    if (entry.status === XOrderStatus.Filled) {
      openPositions += 1;
      openExposureQuote += entryPrice * entry.quantity;
    }
  }

  closed.sort((a, b) => b.at - a.at);

  let consecutiveLosses = 0;
  for (const cycle of closed) {
    if (cycle.pnl < 0) consecutiveLosses += 1;
    else break;
  }

  return { openPositions, openExposureQuote, realizedPnlToday, consecutiveLosses };
}
