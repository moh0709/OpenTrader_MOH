import { xprisma } from "@opentrader/db";
import { eventBus } from "@opentrader/event-bus";
import { exchangeProvider } from "@opentrader/exchanges";
import { logger } from "@opentrader/logger";
import { XEntityType, XEntryType, XOrderSide, XOrderStatus, XOrderType, XSmartTradeType, XTakeProfitType } from "@opentrader/types";

/**
 * Opening a deal from outside the strategy.
 *
 * Every other entry in this system is made by a bot that decided to trade
 * according to its own rules. This one is not: it lets an operator or an agent
 * force a position regardless of what the strategy thinks, which is the point —
 * and also why it needs its own limits.
 *
 * Closing can only ever reduce exposure, so it needs little protection. Opening
 * only ever increases it, and the caller here is explicitly bypassing the
 * discipline that normally decides entries. The limits below are therefore
 * enforced in code, before anything reaches the exchange, and cannot be
 * overridden by the caller — the same principle as the risk governor.
 */

export type ManualTradeLimits = {
  /** Master switch. Set MANUAL_TRADING=0 to refuse every request. */
  enabled: boolean;
  /** Largest notional a single call may open, in quote currency. */
  maxNotionalQuote: number;
  /** How many manually-opened deals may be live at once. */
  maxOpenPositions: number;
  /** Total notional that may be opened manually per calendar day. */
  maxDailyNotionalQuote: number;
  /** When non-empty, only these symbols may be traded. */
  allowedSymbols: string[];
};

export const DEFAULT_MANUAL_LIMITS: ManualTradeLimits = {
  enabled: true,
  maxNotionalQuote: 100,
  maxOpenPositions: 5,
  maxDailyNotionalQuote: 1000,
  allowedSymbols: [],
};

export function manualLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): ManualTradeLimits {
  const symbols = (env.MANUAL_TRADING_SYMBOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    enabled: env.MANUAL_TRADING !== "0",
    maxNotionalQuote: Number(env.MANUAL_TRADING_MAX_NOTIONAL) || DEFAULT_MANUAL_LIMITS.maxNotionalQuote,
    maxOpenPositions: Number(env.MANUAL_TRADING_MAX_POSITIONS) || DEFAULT_MANUAL_LIMITS.maxOpenPositions,
    maxDailyNotionalQuote: Number(env.MANUAL_TRADING_DAILY_NOTIONAL) || DEFAULT_MANUAL_LIMITS.maxDailyNotionalQuote,
    allowedSymbols: symbols,
  };
}

/**
 * Deals opened outside a strategy are tagged so they can be counted against
 * their own budget without touching anything a bot created.
 *
 * Two lanes, because they answer to different people. A `manual:` deal was
 * asked for by an operator or an agent through the API; an `auto:` deal was
 * opened by the trading head on its own judgement. They share this code path —
 * the pricing, the limit checks and the placement are identical — but not their
 * budgets, so a busy morning of manual trades cannot quietly consume the head's
 * daily allowance, or the reverse.
 */
export const MANUAL_REF_PREFIX = "manual:";
export const AUTOPILOT_REF_PREFIX = "auto:";

/** Every lane that is not a strategy's own. Refs here survive a restart. */
export const EXTERNAL_REF_PREFIXES = [MANUAL_REF_PREFIX, AUTOPILOT_REF_PREFIX] as const;

/** True for a ref that belongs to one of the lanes above. */
export function isExternalRef(ref: string | null | undefined): boolean {
  return typeof ref === "string" && EXTERNAL_REF_PREFIXES.some((prefix) => ref.startsWith(prefix));
}

export type OpenTradeParams = {
  /** Supplies the exchange account, owner and default symbol. */
  botId: number;
  symbol?: string;
  side: "buy" | "sell";
  /** Base quantity. Give this or quoteAmount, not neither. */
  quantity?: number;
  /** Notional in quote currency; converted to quantity at the current price. */
  quoteAmount?: number;
  orderType: "market" | "limit";
  /** Required for a limit entry. */
  price?: number;
  /** Optional resting exit placed once the entry fills. */
  takeProfitPrice?: number;
  /**
   * Optional resting stop, placed alongside the take profit.
   *
   * The pair is what makes a filled entry survivable without the daemon: one
   * order to take the win, one to cut the loss, both sitting at the venue.
   */
  stopLossPrice?: number;
};

export type OpenTradeResult = {
  ok: boolean;
  smartTradeId?: number;
  symbol?: string;
  side?: string;
  quantity?: number;
  orderType?: string;
  price?: number | null;
  notionalQuote?: number;
  /** Why the request was refused. Empty when ok. */
  rejections: string[];
  message: string;
};

function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Notional already opened in one lane today, in quote currency. */
export async function manualNotionalToday(prefix: string = MANUAL_REF_PREFIX): Promise<number> {
  const trades = await xprisma.smartTrade.findMany({
    where: { ref: { startsWith: prefix }, createdAt: { gte: startOfToday() } },
    include: { orders: true },
  });

  let total = 0;
  for (const trade of trades) {
    const entry = (trade.orders as { entityType: string; quantity: number; price: number | null; filledPrice: number | null }[]).find(
      (o) => o.entityType === XEntityType.EntryOrder,
    );
    if (!entry) continue;
    const price = entry.filledPrice ?? entry.price ?? 0;
    total += price * entry.quantity;
  }

  return total;
}

/** Deals in one lane whose entry has not yet been exited. */
export async function openManualPositions(prefix: string = MANUAL_REF_PREFIX): Promise<number> {
  const trades = await xprisma.smartTrade.findMany({
    where: { ref: { startsWith: prefix } },
    include: { orders: true },
  });

  return trades.filter((trade: { orders: unknown }) => {
    const orders = trade.orders as { entityType: string; status: string }[];
    const entry = orders.find((o) => o.entityType === XEntityType.EntryOrder);
    const tp = orders.find((o) => o.entityType === XEntityType.TakeProfitOrder);
    if (!entry) return false;
    // Still live if the entry is working, or filled without a completed exit.
    if (entry.status === XOrderStatus.Idle || entry.status === XOrderStatus.Placed) return true;
    return entry.status === XOrderStatus.Filled && tp?.status !== XOrderStatus.Filled;
  }).length;
}

/**
 * Force-open a deal, bypassing strategy.
 *
 * Refuses rather than clamps. A close that gets reduced is still a close, but an
 * entry that is quietly resized is not the trade the caller asked for — better
 * to say no and let them ask again with a number that fits.
 */
export async function openSmartTrade(
  params: OpenTradeParams,
  limits: ManualTradeLimits = manualLimitsFromEnv(),
  /**
   * Which lane this entry belongs to, and therefore whose budget it spends.
   * Defaults to the manual lane so every existing caller is unaffected.
   */
  refPrefix: string = MANUAL_REF_PREFIX,
): Promise<OpenTradeResult> {
  const rejections: string[] = [];
  const refuse = (message: string): OpenTradeResult => ({ ok: false, rejections, message });

  if (!limits.enabled) {
    rejections.push("manual trading is disabled (MANUAL_TRADING=0)");
    return refuse("Manual trading is disabled on this instance.");
  }

  // The relation must be requested explicitly — without it `exchangeAccount` is
  // undefined and building the exchange client throws before any limit is
  // checked, turning a request that should be cleanly refused into a 500.
  const bot = await xprisma.bot.findUnique({
    where: { id: params.botId },
    include: { exchangeAccount: true },
  });
  if (!bot) {
    rejections.push(`bot ${params.botId} not found`);
    return refuse(`No bot with id ${params.botId}.`);
  }

  const symbol = params.symbol || bot.symbol;

  if (limits.allowedSymbols.length > 0 && !limits.allowedSymbols.includes(symbol)) {
    rejections.push(`symbol ${symbol} is not in the allowlist`);
    return refuse(`${symbol} is not permitted. Allowed: ${limits.allowedSymbols.join(", ")}.`);
  }

  if (params.orderType === "limit" && !params.price) {
    rejections.push("limit orders require a price");
    return refuse("A limit entry needs a price.");
  }

  if (!params.quantity && !params.quoteAmount) {
    rejections.push("no size given");
    return refuse("Give either quantity (base) or quoteAmount (notional).");
  }

  // Price the order. A limit uses its own price; a market needs the book.
  const exchange = exchangeProvider.fromAccount(bot.exchangeAccount as never);
  let referencePrice = params.price ?? 0;

  if (params.orderType === "market" || !referencePrice) {
    try {
      const ticker = await exchange.getTicker(symbol);
      referencePrice = params.side === "buy" ? ticker.ask : ticker.bid;
    } catch (err) {
      rejections.push(`could not price ${symbol}: ${(err as Error).message}`);
      return refuse(`Could not read a price for ${symbol}, so the size cannot be checked against the limits.`);
    }
  }

  if (!referencePrice || referencePrice <= 0) {
    rejections.push("no usable price");
    return refuse(`Could not establish a price for ${symbol}.`);
  }

  const quantity = params.quantity ?? (params.quoteAmount as number) / referencePrice;
  const notionalQuote = quantity * referencePrice;

  if (quantity <= 0) {
    rejections.push("size resolved to zero");
    return refuse("The requested size resolves to zero.");
  }

  // --- Limits. Checked before anything is written or placed. ---------------
  if (notionalQuote > limits.maxNotionalQuote) {
    rejections.push(`notional ${notionalQuote.toFixed(2)} exceeds the per-order cap ${limits.maxNotionalQuote}`);
  }

  const openPositions = await openManualPositions(refPrefix);
  if (openPositions >= limits.maxOpenPositions) {
    rejections.push(`${openPositions} manual positions already open (cap ${limits.maxOpenPositions})`);
  }

  const usedToday = await manualNotionalToday(refPrefix);
  if (usedToday + notionalQuote > limits.maxDailyNotionalQuote) {
    rejections.push(
      `daily manual budget would be exceeded: ${usedToday.toFixed(2)} used + ${notionalQuote.toFixed(2)} requested > ${limits.maxDailyNotionalQuote}`,
    );
  }

  if (rejections.length > 0) {
    logger.warn(`[openSmartTrade] Refused ${params.side} ${symbol}: ${rejections.join("; ")}`);
    return refuse(`Refused: ${rejections.join("; ")}`);
  }

  // --- Create and place ----------------------------------------------------
  const side = params.side === "buy" ? XOrderSide.Buy : XOrderSide.Sell;
  const exitSide = side === XOrderSide.Buy ? XOrderSide.Sell : XOrderSide.Buy;
  const ref = `${refPrefix}${Date.now()}`;

  const orders: Record<string, unknown>[] = [
    {
      status: XOrderStatus.Idle,
      type: params.orderType === "market" ? XOrderType.Market : XOrderType.Limit,
      entityType: XEntityType.EntryOrder,
      side,
      price: params.orderType === "limit" ? params.price : null,
      quantity,
      symbol,
      exchangeAccountId: bot.exchangeAccountId,
    },
  ];

  if (params.takeProfitPrice) {
    orders.push({
      status: XOrderStatus.Idle,
      type: XOrderType.Limit,
      entityType: XEntityType.TakeProfitOrder,
      side: exitSide,
      price: params.takeProfitPrice,
      quantity,
      symbol,
      exchangeAccountId: bot.exchangeAccountId,
    });
  }

  if (params.stopLossPrice) {
    // A stop-market: triggered by price crossing, then filled at whatever the
    // book offers. Being out is the point; the fill price is not the point.
    orders.push({
      status: XOrderStatus.Idle,
      type: XOrderType.Market,
      entityType: XEntityType.StopLossOrder,
      side: exitSide,
      price: null,
      stopPrice: params.stopLossPrice,
      quantity,
      symbol,
      exchangeAccountId: bot.exchangeAccountId,
    });
  }

  const created = await xprisma.smartTrade.create({
    data: {
      entryType: XEntryType.Order,
      takeProfitType: params.takeProfitPrice ? XTakeProfitType.Order : XTakeProfitType.None,
      ref,
      type: XSmartTradeType.Trade,
      symbol,
      orders: { createMany: { data: orders as never } },
      exchangeAccount: { connect: { id: bot.exchangeAccountId } },
      bot: { connect: { id: bot.id } },
      owner: { connect: { id: bot.ownerId } },
    },
    include: { orders: true, exchangeAccount: true },
  });

  logger.warn(
    `[openSmartTrade] ${refPrefix === MANUAL_REF_PREFIX ? "MANUAL" : "AUTOPILOT"} ENTRY: ${params.side} ${quantity} ${symbol} ` +
      `(~${notionalQuote.toFixed(2)} quote) as ${params.orderType} on bot ${bot.id}, deal ${created.id}`,
  );

  // Hand it to the daemon to place, the same path a bot-created trade takes.
  await eventBus.emit("placeTrade", created as never);

  return {
    ok: true,
    smartTradeId: created.id,
    symbol,
    side: params.side,
    quantity,
    orderType: params.orderType,
    price: params.orderType === "limit" ? (params.price ?? null) : null,
    notionalQuote,
    rejections: [],
    message:
      `Opened deal ${created.id}: ${params.side} ${quantity} ${symbol} as ${params.orderType}` +
      `${params.takeProfitPrice ? ` with a take profit at ${params.takeProfitPrice}` : ""}.`,
  };
}
