import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the force-close state machine.
 *
 * This code places real market orders, so the cases that matter most are the
 * ones where it must do *nothing*: never sell a position that was never
 * opened, and never sell one that has already been closed.
 */

const state = vi.hoisted(() => ({
  trades: [] as Record<string, unknown>[],
  orderCalls: [] as { method: string; order: Record<string, unknown> }[],
  created: [] as Record<string, unknown>[],
  ticker: { bid: 99, ask: 101 } as { bid: number; ask: number } | null,
  emitted: [] as string[],
}));

vi.mock("@opentrader/db", () => ({
  xprisma: {
    smartTrade: {
      findUniqueOrThrow: async ({ where }: { where: { id: number } }) => {
        const trade = state.trades.find((t) => t.id === where.id);
        if (!trade) throw new Error(`No trade ${where.id}`);
        return trade;
      },
      findMany: async ({ where }: { where?: { botId?: number } } = {}) =>
        where?.botId === undefined ? state.trades : state.trades.filter((t) => t.botId === where.botId),
    },
    order: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 900 + state.created.length, ...data };
        state.created.push(row);
        return row;
      },
    },
  },
  toOrderEntity: (o: unknown) => o,
}));

vi.mock("@opentrader/event-bus", () => ({
  eventBus: { emit: async (name: string) => void state.emitted.push(name) },
}));

vi.mock("@opentrader/exchanges", () => ({
  exchangeProvider: {
    fromAccount: () => ({
      getTicker: async () => {
        if (!state.ticker) throw new Error("ticker unavailable");
        return state.ticker;
      },
    }),
  },
}));

vi.mock("./processing/executors/order/order.executor.js", () => ({
  OrderExecutor: class {
    order: Record<string, unknown>;
    constructor(order: Record<string, unknown>) {
      this.order = order;
    }
    async cancel() {
      state.orderCalls.push({ method: "cancel", order: this.order });
      return true;
    }
    async modify(next: Record<string, unknown>) {
      state.orderCalls.push({ method: "modify", order: next });
      this.order = next;
      return true;
    }
    async place() {
      state.orderCalls.push({ method: "place", order: this.order });
      return true;
    }
  },
}));

const { closeSmartTrade, closeBotTrades } = await import("./trade-closer.js");

type OrderSpec = { entityType: string; status: string; side?: string; quantity?: number; type?: string };

function makeTrade(id: number, orders: OrderSpec[], botId: number | null = 7) {
  return {
    id,
    botId,
    symbol: "BTC/USDT",
    exchangeAccountId: 1,
    exchangeAccount: { id: 1 },
    orders: orders.map((o, i) => ({
      id: id * 10 + i,
      entityType: o.entityType,
      status: o.status,
      side: o.side ?? (o.entityType === "EntryOrder" ? "Buy" : "Sell"),
      type: o.type ?? "Limit",
      quantity: o.quantity ?? 0.5,
      price: 100,
      symbol: "BTC/USDT",
    })),
  };
}

beforeEach(() => {
  state.trades = [];
  state.orderCalls = [];
  state.created = [];
  state.ticker = { bid: 99, ask: 101 };
  state.emitted = [];
});

describe("closeSmartTrade", () => {
  // The single most important guarantee: if the entry never filled, we hold
  // nothing, so the close must cancel and stop — not sell.
  it("never places an exit when the entry has not filled", async () => {
    state.trades = [
      makeTrade(1, [
        { entityType: "EntryOrder", status: "Placed" },
        { entityType: "TakeProfitOrder", status: "Idle" },
      ]),
    ];

    const result = await closeSmartTrade(1);

    expect(result.outcome).toBe("canceled_unfilled");
    expect(result.filled).toBe(false);
    expect(state.orderCalls.every((c) => c.method === "cancel")).toBe(true);
    expect(state.orderCalls.some((c) => c.method === "place" || c.method === "modify")).toBe(false);
  });

  it("cancels every resting order when the entry has not filled", async () => {
    state.trades = [
      makeTrade(1, [
        { entityType: "EntryOrder", status: "Placed" },
        { entityType: "TakeProfitOrder", status: "Idle" },
        { entityType: "StopLossOrder", status: "Placed" },
      ]),
    ];

    await closeSmartTrade(1);

    expect(state.orderCalls.filter((c) => c.method === "cancel")).toHaveLength(3);
  });

  it("closes a held position by turning the take profit into a market exit", async () => {
    state.trades = [
      makeTrade(2, [
        { entityType: "EntryOrder", status: "Filled", side: "Buy", quantity: 0.25 },
        { entityType: "TakeProfitOrder", status: "Placed", side: "Sell" },
      ]),
    ];

    const result = await closeSmartTrade(2, "market");

    expect(result.outcome).toBe("closed");
    expect(result.exitQuantity).toBe(0.25);

    const modify = state.orderCalls.find((c) => c.method === "modify");
    expect(modify).toBeDefined();
    expect(modify!.order.type).toBe("Market");
    expect(modify!.order.side).toBe("Sell");
    expect(modify!.order.quantity).toBe(0.25);
    expect(modify!.order.status).toBe("Idle");
    expect(modify!.order.price).toBeNull();
  });

  it("exits on the opposite side of the entry", async () => {
    state.trades = [
      makeTrade(3, [
        { entityType: "EntryOrder", status: "Filled", side: "Sell", quantity: 1 },
        { entityType: "TakeProfitOrder", status: "Placed", side: "Buy" },
      ]),
    ];

    await closeSmartTrade(3);

    expect(state.orderCalls.find((c) => c.method === "modify")!.order.side).toBe("Buy");
  });

  // Double-selling is the other way this loses money.
  it("refuses to act on a trade whose take profit already filled", async () => {
    state.trades = [
      makeTrade(4, [
        { entityType: "EntryOrder", status: "Filled" },
        { entityType: "TakeProfitOrder", status: "Filled" },
      ]),
    ];

    const result = await closeSmartTrade(4);

    expect(result.outcome).toBe("already_closed");
    expect(state.orderCalls).toHaveLength(0);
  });

  it("is safe to call twice", async () => {
    state.trades = [
      makeTrade(5, [
        { entityType: "EntryOrder", status: "Filled" },
        { entityType: "TakeProfitOrder", status: "Filled" },
      ]),
    ];

    await closeSmartTrade(5);
    const second = await closeSmartTrade(5);

    expect(second.outcome).toBe("already_closed");
    expect(state.orderCalls).toHaveLength(0);
  });

  it("does nothing when the entry order was cancelled", async () => {
    state.trades = [makeTrade(20, [{ entityType: "EntryOrder", status: "Canceled" }])];

    const result = await closeSmartTrade(20);

    expect(result.outcome).toBe("already_closed");
    expect(state.orderCalls).toHaveLength(0);
    expect(state.created).toHaveLength(0);
  });

  // A filled entry with no take profit is "Finished" to the strategy but is an
  // unmanaged position to the account. Force-closing must still exit it.
  it("creates an exit order when the trade has no take profit slot", async () => {
    state.trades = [makeTrade(6, [{ entityType: "EntryOrder", status: "Filled", quantity: 2 }])];

    const result = await closeSmartTrade(6);

    expect(result.outcome).toBe("closed");
    expect(state.created).toHaveLength(1);
    expect(state.created[0].entityType).toBe("TakeProfitOrder");
    expect(state.created[0].quantity).toBe(2);
    expect(state.orderCalls.some((c) => c.method === "place")).toBe(true);
  });

  it("cancels a resting stop loss before exiting, so it cannot fire against the exit", async () => {
    state.trades = [
      makeTrade(7, [
        { entityType: "EntryOrder", status: "Filled" },
        { entityType: "TakeProfitOrder", status: "Placed" },
        { entityType: "StopLossOrder", status: "Placed" },
      ]),
    ];

    await closeSmartTrade(7);

    const cancelled = state.orderCalls.find((c) => c.method === "cancel");
    expect(cancelled?.order.entityType).toBe("StopLossOrder");
  });

  it("stops the live trade queue before touching the exchange", async () => {
    state.trades = [
      makeTrade(8, [
        { entityType: "EntryOrder", status: "Filled" },
        { entityType: "TakeProfitOrder", status: "Placed" },
      ]),
    ];

    await closeSmartTrade(8);

    expect(state.emitted).toContain("cancelTrade");
  });

  describe("limit mode", () => {
    it("rests on the passive side of the book", async () => {
      state.trades = [
        makeTrade(9, [
          { entityType: "EntryOrder", status: "Filled", side: "Buy" },
          { entityType: "TakeProfitOrder", status: "Placed", side: "Sell" },
        ]),
      ];

      const result = await closeSmartTrade(9, "limit");

      const modify = state.orderCalls.find((c) => c.method === "modify");
      expect(modify!.order.type).toBe("Limit");
      // Selling rests at the ask.
      expect(modify!.order.price).toBe(101);
      expect(result.exitPrice).toBe(101);
    });

    it("falls back to a market exit when the ticker is unavailable", async () => {
      state.ticker = null;
      state.trades = [
        makeTrade(10, [
          { entityType: "EntryOrder", status: "Filled" },
          { entityType: "TakeProfitOrder", status: "Placed" },
        ]),
      ];

      const result = await closeSmartTrade(10, "limit");

      expect(result.outcome).toBe("closed");
      expect(state.orderCalls.find((c) => c.method === "modify")!.order.type).toBe("Market");
    });
  });
});

describe("closeBotTrades", () => {
  it("reports a result for every deal rather than stopping at the first", async () => {
    state.trades = [
      makeTrade(11, [
        { entityType: "EntryOrder", status: "Filled" },
        { entityType: "TakeProfitOrder", status: "Placed" },
      ]),
      makeTrade(12, [
        { entityType: "EntryOrder", status: "Filled" },
        { entityType: "TakeProfitOrder", status: "Filled" },
      ]),
      makeTrade(13, [{ entityType: "EntryOrder", status: "Placed" }]),
    ];

    const results = await closeBotTrades(7);

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.outcome)).toEqual(["closed", "already_closed", "canceled_unfilled"]);
  });

  it("only touches deals belonging to the requested bot", async () => {
    state.trades = [
      makeTrade(14, [{ entityType: "EntryOrder", status: "Placed" }], 7),
      makeTrade(15, [{ entityType: "EntryOrder", status: "Placed" }], 99),
    ];

    const results = await closeBotTrades(7);

    expect(results).toHaveLength(1);
    expect(results[0].smartTradeId).toBe(14);
  });
});
