/**
 * Regression tests for the paper matcher's view of what is still open.
 *
 * The matcher walks an in-memory snapshot of the open orders. Cancelling wrote
 * "canceled" to the row and left the order in that snapshot, so the matcher
 * went on comparing it against the ticker and filled it anyway, writing
 * "filled" over the cancellation.
 *
 * It cost money. Closing a position cancels its resting stop and sells at
 * market; the stop stayed live in the snapshot, price kept falling through it,
 * and three head positions were sold a second time they no longer owned - 279.77
 * of inventory that did not exist, with the loss on each booked twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<number, { id: number; status: string }>();

vi.mock("@opentrader/db", () => ({
  xprisma: {
    paperOrder: {
      update: vi.fn(async ({ where, data }: { where: { id: number }; data: { status: string } }) => {
        const row = { ...(rows.get(where.id) ?? { id: where.id, status: "open" }), ...data };
        rows.set(where.id, row);

        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: number } }) => rows.get(where.id) ?? null),
      findMany: vi.fn(async () => [...rows.values()].filter((row) => row.status === "open")),
    },
  },
}));

const { PaperExchange } = await import("./paper-exchange.js");

type Internals = {
  openOrders: Array<{ id: number; symbol: string }>;
  stillOpen(id: number): Promise<boolean>;
};

const internals = (exchange: unknown) => exchange as unknown as Internals;

function makeExchange(open: Array<{ id: number; symbol: string }>) {
  const exchange = new PaperExchange("OKX" as never);
  for (const order of open) rows.set(order.id, { id: order.id, status: "open" });
  internals(exchange).openOrders = [...open];

  return exchange;
}

beforeEach(() => rows.clear());

describe("PaperExchange cancellation", () => {
  it("drops a cancelled order from the matcher's snapshot, not just the table", async () => {
    const exchange = makeExchange([
      { id: 1, symbol: "ETH/USDT" },
      { id: 2, symbol: "SOL/USDT" },
    ]);

    await exchange.cancelLimitOrder({ orderId: "1", symbol: "ETH/USDT" } as never);

    expect(rows.get(1)!.status).toBe("canceled");
    // The part that was missing: still present here, the matcher fills it later.
    expect(internals(exchange).openOrders.map((order) => order.id)).toEqual([2]);
  });

  it("does not consider a cancelled order fillable", async () => {
    const exchange = makeExchange([{ id: 1, symbol: "ETH/USDT" }]);

    expect(await internals(exchange).stillOpen(1)).toBe(true);

    await exchange.cancelLimitOrder({ orderId: "1", symbol: "ETH/USDT" } as never);

    expect(await internals(exchange).stillOpen(1)).toBe(false);
  });

  it("does not consider an already filled order fillable", async () => {
    const exchange = makeExchange([{ id: 1, symbol: "ETH/USDT" }]);
    rows.set(1, { id: 1, status: "filled" });

    // Guards the other direction too: a stale snapshot must not fill twice.
    expect(await internals(exchange).stillOpen(1)).toBe(false);
  });

  it("leaves an untouched order fillable", async () => {
    const exchange = makeExchange([{ id: 7, symbol: "XRP/USDT" }]);

    expect(await internals(exchange).stillOpen(7)).toBe(true);
    expect(internals(exchange).openOrders.map((order) => order.id)).toEqual([7]);
  });
});
