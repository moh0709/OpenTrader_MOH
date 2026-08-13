/**
 * Fixture builders for the analytics tests.
 *
 * The default values mirror rows taken from a real install, so the tests read as
 * concrete scenarios rather than abstract shapes.
 */
import type { AnalyticsBot, AnalyticsOrder, AnalyticsSmartTrade } from "./types.js";

let nextOrderId = 1;
let nextTradeId = 1;

export function resetFixtureIds() {
  nextOrderId = 1;
  nextTradeId = 1;
}

export function makeOrder(overrides: Partial<AnalyticsOrder> = {}): AnalyticsOrder {
  const createdAt = overrides.createdAt ?? new Date(1_786_361_000_000);

  return {
    id: overrides.id ?? nextOrderId++,
    status: "Filled",
    type: "Limit",
    entityType: "EntryOrder",
    side: "Buy",
    price: 65_006,
    filledPrice: 65_005.35,
    fee: 0,
    quantity: 0.012,
    symbol: "BTC/USD",
    smartTradeId: 1,
    createdAt,
    placedAt: createdAt,
    syncedAt: createdAt,
    filledAt: overrides.filledAt ?? createdAt,
    updatedAt: createdAt,
    ...overrides,
  } as AnalyticsOrder;
}

export function makeTrade(orders: AnalyticsOrder[], overrides: Partial<AnalyticsSmartTrade> = {}): AnalyticsSmartTrade {
  const id = overrides.id ?? nextTradeId++;

  return {
    id,
    type: "Trade",
    entryType: "Order",
    takeProfitType: "Order",
    symbol: "BTC/USD",
    botId: 5,
    exchangeAccountId: 1,
    createdAt: new Date(1_786_361_000_000),
    updatedAt: new Date(1_786_361_000_000),
    ...overrides,
    orders: orders.map((order) => ({ ...order, smartTradeId: id })),
  };
}

/**
 * A completed grid cycle: bought at `entryPrice`, sold at `exitPrice`.
 * Modelled on SmartTrade 359 of the live install.
 */
export function makeClosedTrade(options: {
  entryPrice: number;
  exitPrice: number;
  quantity?: number;
  entryAt?: number;
  exitAt?: number;
  botId?: number;
  symbol?: string;
  fee?: number;
  exitEntityType?: "TakeProfitOrder" | "StopLossOrder";
}): AnalyticsSmartTrade {
  const quantity = options.quantity ?? 0.012;
  const entryAt = options.entryAt ?? 1_786_361_861_085;
  const exitAt = options.exitAt ?? 1_786_361_928_827;
  const fee = options.fee ?? 0;

  return makeTrade(
    [
      makeOrder({
        entityType: "EntryOrder",
        side: "Buy",
        status: "Filled",
        price: options.entryPrice,
        filledPrice: options.entryPrice,
        quantity,
        fee,
        filledAt: new Date(entryAt),
        symbol: options.symbol ?? "BTC/USD",
      }),
      makeOrder({
        entityType: options.exitEntityType ?? "TakeProfitOrder",
        side: "Sell",
        status: "Filled",
        price: options.exitPrice,
        filledPrice: options.exitPrice,
        quantity,
        fee,
        filledAt: new Date(exitAt),
        symbol: options.symbol ?? "BTC/USD",
      }),
    ],
    { botId: options.botId ?? 5, symbol: options.symbol ?? "BTC/USD" },
  );
}

/** A position that bought and is still waiting to sell. */
export function makeOpenTrade(options: {
  entryPrice: number;
  targetPrice: number;
  quantity?: number;
  entryAt?: number;
  botId?: number;
  symbol?: string;
  /** "Placed" leaves a live exit, "Canceled"/"Revoked" abandons the position. */
  exitStatus?: string;
}): AnalyticsSmartTrade {
  const quantity = options.quantity ?? 0.012;
  const entryAt = options.entryAt ?? 1_786_361_000_000;

  return makeTrade(
    [
      makeOrder({
        entityType: "EntryOrder",
        side: "Buy",
        status: "Filled",
        price: options.entryPrice,
        filledPrice: options.entryPrice,
        quantity,
        filledAt: new Date(entryAt),
        symbol: options.symbol ?? "BTC/USD",
      }),
      makeOrder({
        entityType: "TakeProfitOrder",
        side: "Sell",
        status: options.exitStatus ?? "Placed",
        price: options.targetPrice,
        filledPrice: null,
        quantity,
        filledAt: null,
        symbol: options.symbol ?? "BTC/USD",
      }),
    ],
    { botId: options.botId ?? 5, symbol: options.symbol ?? "BTC/USD" },
  );
}

/** An entry order resting on the book, nothing bought yet. */
export function makePendingTrade(options: {
  price: number;
  quantity?: number;
  botId?: number;
  symbol?: string;
  status?: string;
}): AnalyticsSmartTrade {
  return makeTrade(
    [
      makeOrder({
        entityType: "EntryOrder",
        side: "Buy",
        status: options.status ?? "Placed",
        price: options.price,
        filledPrice: null,
        filledAt: null,
        quantity: options.quantity ?? 0.012,
        symbol: options.symbol ?? "BTC/USD",
      }),
      makeOrder({
        entityType: "TakeProfitOrder",
        side: "Sell",
        status: "Idle",
        price: options.price + 20,
        filledPrice: null,
        filledAt: null,
        quantity: options.quantity ?? 0.012,
        symbol: options.symbol ?? "BTC/USD",
      }),
    ],
    { botId: options.botId ?? 5, symbol: options.symbol ?? "BTC/USD" },
  );
}

export function makeBot(overrides: Partial<AnalyticsBot> = {}): AnalyticsBot {
  return {
    id: 5,
    type: "Bot",
    name: "Bronze Dud Bolt",
    label: null,
    symbol: "BTC/USD",
    enabled: true,
    processing: false,
    template: "gridBot",
    timeframe: "1m",
    createdAt: new Date(1_786_100_000_000),
    exchangeAccountId: 1,
    settings: {},
    state: {},
    ...overrides,
  };
}

export function makeGridSettings(prices: number[], quantity = 0.012) {
  return { gridLines: prices.map((price) => ({ price, quantity })) };
}
