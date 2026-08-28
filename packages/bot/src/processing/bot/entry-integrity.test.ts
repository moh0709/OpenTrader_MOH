import { describe, expect, it } from "vitest";
import { XEntityType, XOrderSide, XOrderStatus, XOrderType } from "@opentrader/types";
import type { CreateOrder } from "@opentrader/bot-processor";
import { bornStatus, claimsUnearnedFill } from "./entry-integrity.js";
import { OrderNormalizer } from "./normalizer.js";

const meta = { entityType: XEntityType.EntryOrder, symbol: "PAXG/USDT", exchangeAccountId: 2 };

describe("bornStatus", () => {
  it("is always Idle", () => {
    expect(bornStatus()).toBe(XOrderStatus.Idle);
  });
});

describe("claimsUnearnedFill", () => {
  it("flags the states only an exchange can grant", () => {
    expect(claimsUnearnedFill(XOrderStatus.Filled)).toBe(true);
    expect(claimsUnearnedFill(XOrderStatus.Placed)).toBe(true);
  });

  it("does not flag an honest request", () => {
    expect(claimsUnearnedFill(XOrderStatus.Idle)).toBe(false);
    expect(claimsUnearnedFill(undefined)).toBe(false);
  });
});

describe("OrderNormalizer.fromPayload", () => {
  // The grid asks for this on every ladder line at or above the current price.
  // It is the exact payload that put 28,264 of imaginary capital on a 1000 cap.
  const gridLineAboveMarket: CreateOrder = {
    type: XOrderType.Limit,
    side: XOrderSide.Buy,
    price: 4664,
    quantity: 0.22,
    status: XOrderStatus.Filled,
  };

  it("refuses to open a position the exchange never filled", () => {
    const row = OrderNormalizer.fromPayload(gridLineAboveMarket, meta);

    expect(row.status).toBe(XOrderStatus.Idle);
    expect(row.filledPrice).toBeNull();
    expect(row.filledAt).toBeNull();
    expect(row.placedAt).toBeNull();
  });

  it("keeps the price and size the strategy asked for", () => {
    const row = OrderNormalizer.fromPayload(gridLineAboveMarket, meta);

    // Demotion is about what the exchange has done, not about second-guessing
    // where the strategy wants to trade.
    expect(row.price).toBe(4664);
    expect(row.quantity).toBe(0.22);
    expect(row.side).toBe("Buy");
  });

  it("does not let a strategy claim an order is already resting", () => {
    const row = OrderNormalizer.fromPayload({ ...gridLineAboveMarket, status: XOrderStatus.Placed }, meta);

    expect(row.status).toBe(XOrderStatus.Idle);
    expect(row.placedAt).toBeNull();
  });

  it("leaves an honest Idle request untouched", () => {
    const row = OrderNormalizer.fromPayload({ ...gridLineAboveMarket, status: XOrderStatus.Idle }, meta);

    expect(row.status).toBe(XOrderStatus.Idle);
    expect(row.filledPrice).toBeNull();
  });
});
