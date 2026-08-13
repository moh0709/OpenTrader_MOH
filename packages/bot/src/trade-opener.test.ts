import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for force-opening a deal.
 *
 * This is the one operation in the system that increases exposure while
 * deliberately bypassing the strategy that would normally decide entries, so
 * the tests that matter are the ones proving it refuses: over the per-order
 * cap, over the position count, over the daily budget, off the allowlist, and
 * when switched off entirely.
 */

const state = vi.hoisted(() => ({
  bot: { id: 1, symbol: "BTC/USDT", exchangeAccountId: 9, ownerId: 1, exchangeAccount: { id: 9 } } as Record<string, unknown> | null,
  trades: [] as Record<string, unknown>[],
  created: [] as Record<string, unknown>[],
  ticker: { bid: 99, ask: 100 } as { bid: number; ask: number } | null,
  emitted: [] as string[],
}));

vi.mock("@opentrader/db", () => ({
  xprisma: {
    bot: { findUnique: async () => state.bot },
    smartTrade: {
      findMany: async () => state.trades,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        // Keep the payload as submitted — the orders it carries are what the
        // tests assert on. The returned row mimics prisma's own shape.
        state.created.push(data);
        return { id: 500 + state.created.length, ...data, orders: [] };
      },
    },
  },
}));

vi.mock("@opentrader/event-bus", () => ({
  eventBus: { emit: async (n: string) => void state.emitted.push(n) },
}));

vi.mock("@opentrader/exchanges", () => ({
  exchangeProvider: {
    fromAccount: () => ({
      getTicker: async () => {
        if (!state.ticker) throw new Error("no ticker");
        return state.ticker;
      },
    }),
  },
}));

const { openSmartTrade, DEFAULT_MANUAL_LIMITS, manualLimitsFromEnv, MANUAL_REF_PREFIX } = await import("./trade-opener.js");

const limits = { ...DEFAULT_MANUAL_LIMITS };

/** A manual trade in the "still open" state, for position-count tests. */
function openManualTrade(id: number, qty = 0.1, price = 100) {
  return {
    id,
    ref: `${MANUAL_REF_PREFIX}${id}`,
    createdAt: new Date(),
    orders: [
      { entityType: "EntryOrder", status: "Filled", quantity: qty, price, filledPrice: price },
    ],
  };
}

beforeEach(() => {
  state.bot = { id: 1, symbol: "BTC/USDT", exchangeAccountId: 9, ownerId: 1, exchangeAccount: { id: 9 } };
  state.trades = [];
  state.created = [];
  state.ticker = { bid: 99, ask: 100 };
  state.emitted = [];
});

describe("openSmartTrade", () => {
  it("opens a market buy within the limits", async () => {
    const result = await openSmartTrade({ botId: 1, side: "buy", quoteAmount: 50, orderType: "market" }, limits);

    expect(result.ok).toBe(true);
    expect(result.smartTradeId).toBeDefined();
    expect(result.notionalQuote).toBeCloseTo(50, 6);
    // Sized off the ask when buying.
    expect(result.quantity).toBeCloseTo(0.5, 6);
    expect(state.emitted).toContain("placeTrade");
  });

  it("tags the deal so it counts against the manual budget", async () => {
    await openSmartTrade({ botId: 1, side: "buy", quantity: 0.1, orderType: "market" }, limits);

    expect(String(state.created[0].ref)).toMatch(/^manual:/);
  });

  it("accepts an explicit base quantity", async () => {
    const result = await openSmartTrade({ botId: 1, side: "buy", quantity: 0.25, orderType: "market" }, limits);

    expect(result.ok).toBe(true);
    expect(result.quantity).toBe(0.25);
  });

  it("attaches a take profit when asked", async () => {
    const result = await openSmartTrade(
      { botId: 1, side: "buy", quantity: 0.1, orderType: "limit", price: 95, takeProfitPrice: 120 },
      limits,
    );

    expect(result.ok).toBe(true);
    const orders = (state.created[0].orders as { createMany: { data: Record<string, unknown>[] } }).createMany.data;
    expect(orders).toHaveLength(2);
    expect(orders[1].entityType).toBe("TakeProfitOrder");
    expect(orders[1].side).toBe("Sell");
    expect(orders[1].price).toBe(120);
  });

  it("exits on the opposite side for a sell entry", async () => {
    await openSmartTrade(
      { botId: 1, side: "sell", quantity: 0.1, orderType: "limit", price: 105, takeProfitPrice: 90 },
      limits,
    );

    const orders = (state.created[0].orders as { createMany: { data: Record<string, unknown>[] } }).createMany.data;
    expect(orders[0].side).toBe("Sell");
    expect(orders[1].side).toBe("Buy");
  });

  describe("limits", () => {
    it("refuses an order above the per-order cap", async () => {
      const result = await openSmartTrade({ botId: 1, side: "buy", quoteAmount: 500, orderType: "market" }, limits);

      expect(result.ok).toBe(false);
      expect(result.rejections.join(" ")).toContain("per-order cap");
      expect(state.created).toHaveLength(0);
      expect(state.emitted).not.toContain("placeTrade");
    });

    it("refuses once too many manual positions are open", async () => {
      state.trades = Array.from({ length: limits.maxOpenPositions }, (_, i) => openManualTrade(i + 1, 0.01, 10));

      const result = await openSmartTrade({ botId: 1, side: "buy", quoteAmount: 10, orderType: "market" }, limits);

      expect(result.ok).toBe(false);
      expect(result.rejections.join(" ")).toContain("manual positions already open");
      expect(state.created).toHaveLength(0);
    });

    it("refuses when the daily budget would be exceeded", async () => {
      // 990 of a 1000 budget already used today.
      state.trades = [openManualTrade(1, 9.9, 100)];

      const result = await openSmartTrade({ botId: 1, side: "buy", quoteAmount: 50, orderType: "market" }, limits);

      expect(result.ok).toBe(false);
      expect(result.rejections.join(" ")).toContain("daily manual budget");
      expect(state.created).toHaveLength(0);
    });

    it("refuses a symbol outside the allowlist", async () => {
      const result = await openSmartTrade(
        { botId: 1, symbol: "DOGE/USDT", side: "buy", quantity: 1, orderType: "market" },
        { ...limits, allowedSymbols: ["BTC/USDT"] },
      );

      expect(result.ok).toBe(false);
      expect(result.rejections.join(" ")).toContain("allowlist");
    });

    it("allows a symbol that is on the allowlist", async () => {
      const result = await openSmartTrade(
        { botId: 1, symbol: "BTC/USDT", side: "buy", quantity: 0.1, orderType: "market" },
        { ...limits, allowedSymbols: ["BTC/USDT"] },
      );

      expect(result.ok).toBe(true);
    });

    it("refuses everything when manual trading is switched off", async () => {
      const result = await openSmartTrade(
        { botId: 1, side: "buy", quantity: 0.001, orderType: "market" },
        { ...limits, enabled: false },
      );

      expect(result.ok).toBe(false);
      expect(result.rejections.join(" ")).toContain("disabled");
      expect(state.created).toHaveLength(0);
    });

    // Refusing beats silently resizing: a shrunk entry is not the trade asked for.
    it("refuses rather than clamping an oversized order", async () => {
      const result = await openSmartTrade({ botId: 1, side: "buy", quoteAmount: 100_000, orderType: "market" }, limits);

      expect(result.ok).toBe(false);
      expect(result.smartTradeId).toBeUndefined();
    });
  });

  describe("input validation", () => {
    it("rejects a limit order with no price", async () => {
      const result = await openSmartTrade({ botId: 1, side: "buy", quantity: 1, orderType: "limit" }, limits);

      expect(result.ok).toBe(false);
      expect(result.rejections.join(" ")).toContain("require a price");
    });

    it("rejects a request with no size", async () => {
      const result = await openSmartTrade({ botId: 1, side: "buy", orderType: "market" }, limits);

      expect(result.ok).toBe(false);
      expect(result.rejections.join(" ")).toContain("no size given");
    });

    it("rejects an unknown bot", async () => {
      state.bot = null;

      const result = await openSmartTrade({ botId: 42, side: "buy", quantity: 1, orderType: "market" }, limits);

      expect(result.ok).toBe(false);
      expect(result.rejections.join(" ")).toContain("not found");
    });

    // Without a price the notional cannot be checked, so it must not proceed.
    it("refuses when the market cannot be priced", async () => {
      state.ticker = null;

      const result = await openSmartTrade({ botId: 1, side: "buy", quantity: 1, orderType: "market" }, limits);

      expect(result.ok).toBe(false);
      expect(result.rejections.join(" ")).toContain("could not price");
      expect(state.created).toHaveLength(0);
    });
  });
});

describe("manualLimitsFromEnv", () => {
  it("is enabled by default with conservative caps", () => {
    const l = manualLimitsFromEnv({} as NodeJS.ProcessEnv);

    expect(l.enabled).toBe(true);
    expect(l.maxNotionalQuote).toBe(100);
    expect(l.maxOpenPositions).toBe(5);
    expect(l.maxDailyNotionalQuote).toBe(1000);
    expect(l.allowedSymbols).toEqual([]);
  });

  it("can be switched off entirely", () => {
    expect(manualLimitsFromEnv({ MANUAL_TRADING: "0" } as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  it("reads caps and the allowlist from the environment", () => {
    const l = manualLimitsFromEnv({
      MANUAL_TRADING_MAX_NOTIONAL: "25",
      MANUAL_TRADING_MAX_POSITIONS: "2",
      MANUAL_TRADING_DAILY_NOTIONAL: "250",
      MANUAL_TRADING_SYMBOLS: "BTC/USDT, ETH/USDT",
    } as NodeJS.ProcessEnv);

    expect(l.maxNotionalQuote).toBe(25);
    expect(l.maxOpenPositions).toBe(2);
    expect(l.maxDailyNotionalQuote).toBe(250);
    expect(l.allowedSymbols).toEqual(["BTC/USDT", "ETH/USDT"]);
  });
});
