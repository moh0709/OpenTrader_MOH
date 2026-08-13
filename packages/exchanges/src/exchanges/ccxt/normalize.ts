import { type OrderType } from "ccxt";
import { composeSymbolIdFromPair, getExponentAbs } from "@opentrader/tools";
import { OrderSide, XOrderType } from "@opentrader/types";
import type { Normalize } from "../../types/normalize.interface.js";
import { normalizeOrderStatus } from "../../utils/normalizeOrderStatus.js";

/**
 * The fee, always expressed in the quote currency.
 *
 * CCXT reports `fee.cost` denominated in `fee.currency`, and which currency
 * that is depends on the exchange and the side: a spot buy is commonly charged
 * in the base asset (you simply receive slightly less of what you bought)
 * while a sell is charged in quote. Keeping only the cost, as this used to,
 * throws away the one piece of information needed to read the number.
 *
 * A consumer left guessing gets it wrong whenever the guess does not hold. The
 * dashboard guessed "buy fees are base" and multiplied every entry fee by the
 * fill price, which turned a $0.94 fee into $1,765 and a winning trade into a
 * reported $1,757 loss. Normalising here means nothing downstream has to know
 * any of this.
 *
 * A fee paid in some third currency - an exchange's own discount token, say -
 * cannot be converted without a rate we do not have here, so it is passed
 * through unchanged. That is a small error; multiplying by the fill price
 * would be a large one.
 */
export function feeInQuoteCurrency(order: {
  fee?: { cost?: number; currency?: string } | undefined;
  symbol?: string | undefined;
  average?: number | undefined;
  price?: number | undefined;
}): number {
  const cost = order.fee?.cost;
  if (!cost) return 0;

  const currency = order.fee?.currency;
  const base = order.symbol?.split("/")[0];
  if (!currency || !base || currency !== base) return cost;

  const price = order.average || order.price;

  return price ? cost * price : cost;
}

const accountAssets: Normalize["accountAssets"] = {
  response: (data) =>
    Object.entries(data).flatMap(([currency, balance]) => {
      // exclude non-coin keys like "timestamp", "info", etc.
      const isCoin = balance?.total && balance?.free;
      if (!isCoin) return [];

      return [
        {
          currency,
          balance: Number(balance.total),
          availableBalance: Number(balance.free),
        },
      ];
    }),
};

const getLimitOrder: Normalize["getLimitOrder"] = {
  request: (params) => [params.orderId, params.symbol],
  response: (order) => ({
    exchangeOrderId: order.id,
    clientOrderId: order.clientOrderId,
    symbol: order.symbol,
    side: order.side as OrderSide,
    quantity: order.amount,
    quantityExecuted: order.filled,
    volume: order.amount * order.price,
    volumeExecuted: order.cost,
    price: order.price, // could be undefined for market order, in case not filled yet?
    filledPrice: order.average || null,
    status: normalizeOrderStatus(order),
    fee: feeInQuoteCurrency(order),
    createdAt: order.timestamp,
    lastTradeTimestamp: order.lastTradeTimestamp,
  }),
};

const placeOrder: Normalize["placeOrder"] = {
  request: (params) => {
    const orderType: OrderType = params.type === XOrderType.Market ? "market" : "limit";

    // Some exchanges require price for Market orders to calculate the total cost of the order in the quote currency.
    // https://docs.ccxt.com/#/?id=market-buys
    if (params.price !== undefined) {
      return [params.symbol, orderType, params.side, params.quantity, params.price];
    }

    return [params.symbol, orderType, params.side, params.quantity];
  },
  response: (order) => ({
    orderId: order.id,
    clientOrderId: order.clientOrderId,
  }),
};

const placeLimitOrder: Normalize["placeLimitOrder"] = {
  request: (params) => [params.symbol, params.side, params.quantity, params.price],
  response: (order) => ({
    orderId: order.id,
    clientOrderId: order.clientOrderId,
  }),
};

const placeMarketOrder: Normalize["placeMarketOrder"] = {
  request: (params) => [params.symbol, params.side, params.quantity],
  response: (order) => ({
    orderId: order.id,
    clientOrderId: order.clientOrderId,
  }),
};

const placeStopOrder: Normalize["placeStopOrder"] = {
  request: (params) => {
    const type = params.type === "limit" ? "limit" : "market";

    return [
      params.symbol,
      type,
      params.side,
      params.quantity,
      type === "limit" ? params.price : undefined,
      params.stopPrice,
    ];
  },
  response: (order) => ({
    orderId: order.id,
    clientOrderId: order.clientOrderId,
  }),
};

const cancelLimitOrder: Normalize["cancelLimitOrder"] = {
  request: (params) => [params.orderId, params.symbol],
  response: (data) => ({
    orderId: data.id,
  }),
};

const getOpenOrders: Normalize["getOpenOrders"] = {
  request: (params) => [params.symbol],
  response: (orders) =>
    orders.map((order) => ({
      exchangeOrderId: order.id,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side as OrderSide,
      quantity: order.amount,
      quantityExecuted: order.filled,
      volume: order.amount * order.price,
      volumeExecuted: order.cost,
      price: order.price,
      filledPrice: null,
      status: normalizeOrderStatus(order) as "open",
      fee: feeInQuoteCurrency(order),
      createdAt: order.timestamp,
      lastTradeTimestamp: order.lastTradeTimestamp,
    })),
};

const getClosedOrders: Normalize["getClosedOrders"] = {
  request: (params) => [params.symbol],
  response: (orders) =>
    orders.map((order) => ({
      exchangeOrderId: order.id,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side as OrderSide,
      quantity: order.amount,
      quantityExecuted: order.filled,
      volume: order.amount * order.price,
      volumeExecuted: order.cost,
      price: order.price,
      filledPrice: order.average || order.price, // assume that filled order must always contain `order.average`
      status: normalizeOrderStatus(order) as "filled" | "canceled",
      fee: feeInQuoteCurrency(order),
      createdAt: order.timestamp,
      lastTradeTimestamp: order.lastTradeTimestamp,
    })),
};

const getTicker: Normalize["getTicker"] = {
  request: (symbol) => [symbol],
  response: (ticker) => ({
    symbol: ticker.symbol!,
    timestamp: ticker.timestamp!,

    bid: ticker.bid!,
    ask: ticker.ask!,
    last: ticker.last!,

    open: ticker.open,
    high: ticker.high,
    low: ticker.low,
    close: ticker.close,

    baseVolume: ticker.baseVolume!,
    quoteVolume: ticker.quoteVolume!,
  }),
};

const getMarketPrice: Normalize["getMarketPrice"] = {
  request: (params) => [params.symbol],
  response: (ticker) => ({
    symbol: ticker.symbol,
    price: ticker.last! || ticker.bid! || ticker.ask!,
    timestamp: ticker.timestamp!,
  }),
};

const getCandlesticks: Normalize["getCandlesticks"] = {
  request: (params) => [params.symbol, params.bar, params.since, params.limit],
  response: (candlesticks) =>
    candlesticks.map((candlestick) => ({
      timestamp: candlestick[0]!,
      open: candlestick[1]!,
      high: candlestick[2]!,
      low: candlestick[3]!,
      close: candlestick[4]!,
      volume: candlestick[5] ?? 0,
    })),
};

const getSymbol: Normalize["getSymbol"] = {
  request: (params) => [params.currencyPair],
  response: (market, exchangeCode) => ({
    symbolId: composeSymbolIdFromPair(exchangeCode, market!.symbol),
    currencyPair: market!.symbol,
    exchangeCode,
    exchangeSymbolId: market!.id!,

    baseCurrency: market!.base!,
    quoteCurrency: market!.quote!,

    filters: {
      precision: market!.precision,
      decimals: {
        amount: market!.precision.amount ? getExponentAbs(market!.precision.amount) : undefined,
        price: market!.precision.price ? getExponentAbs(market!.precision.price) : undefined,
      },
      limits: market!.limits,
    },
  }),
};

const getSymbols: Normalize["getSymbols"] = {
  response: (markets, exchangeCode) =>
    Object.entries(markets).map(([_symbol, market]) => getSymbol.response(market, exchangeCode)),
};

const watchOrders: Normalize["watchOrders"] = {
  request: (params) => [params.symbol],
  response: (orders) =>
    orders.map((order) => ({
      exchangeOrderId: order.id,
      clientOrderId: order.clientOrderId,
      side: order.side as OrderSide,
      quantity: order.amount,
      price: order.price,
      filledPrice: order.average || null,
      status: normalizeOrderStatus(order),
      fee: feeInQuoteCurrency(order),
      createdAt: order.timestamp,
      lastTradeTimestamp: order.lastTradeTimestamp,
    })),
};

const watchCandles: Normalize["watchCandles"] = {
  request: (params) => [params.symbol],
  response: (ohlcv) =>
    ohlcv.map((order) => ({
      timestamp: order[0]!,
      open: order[1]!,
      high: order[2]!,
      low: order[3]!,
      close: order[4]!,
      volume: order[5]!,
    })),
};

const watchTrades: Normalize["watchTrades"] = {
  request: (params) => [params.symbol],
  response: (trades) =>
    trades.map((trade) => ({
      id: trade.id!,
      amount: trade.amount!,
      price: trade.price!,
      timestamp: trade.timestamp!,
      side: trade.side as OrderSide,
      symbol: trade.symbol!,
      takerOrMaker: trade.takerOrMaker,
    })),
};

const watchOrderbook: Normalize["watchOrderbook"] = {
  request: (symbol) => [symbol],
  response: (orderbook) => ({
    symbol: orderbook.symbol!,
    timestamp: orderbook.timestamp!,

    bids: [...orderbook.bids].map(([price, quantity]) => ({ price: price!, quantity: quantity! })),
    asks: [...orderbook.asks].map(([price, quantity]) => ({ price: price!, quantity: quantity! })),
  }),
};

const watchTicker: Normalize["watchTicker"] = {
  request: (symbol) => [symbol],
  response: (ticker) => ({
    symbol: ticker.symbol!,
    timestamp: ticker.timestamp!,

    bid: ticker.bid!,
    ask: ticker.ask!,
    last: ticker.last!,

    open: ticker.open,
    high: ticker.high,
    low: ticker.low,
    close: ticker.close,

    baseVolume: ticker.baseVolume!,
    quoteVolume: ticker.quoteVolume!,
  }),
};

export const normalize: Normalize = {
  accountAssets,
  getLimitOrder,
  placeOrder,
  placeLimitOrder,
  placeMarketOrder,
  placeStopOrder,
  cancelLimitOrder,
  getOpenOrders,
  getClosedOrders,
  getTicker,
  getMarketPrice,
  getCandlesticks,
  getSymbol,
  getSymbols,
  watchOrders,
  watchCandles,
  watchTrades,
  watchOrderbook,
  watchTicker,
};
