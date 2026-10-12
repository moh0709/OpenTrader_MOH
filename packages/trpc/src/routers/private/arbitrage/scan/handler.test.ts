/**
 * The scan endpoint's caching and de-duplication.
 *
 * Both exist for the same reason. Two arbitrage widgets share this endpoint, and
 * one of them used to re-request on the dashboard's five-second snapshot tick —
 * so the same seven-venue sweep was started over and over while the previous one
 * was still running. Nothing about that is visible in a unit test of the
 * evaluation logic; it only shows up as latency on a live page, which is exactly
 * why it needs asserting here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IOrderbook } from "@opentrader/types";

const NOW = 1_700_000_000_000;

function book(price: number): IOrderbook {
  return {
    symbol: "BTC/USDT",
    timestamp: NOW,
    asks: [{ price, quantity: 10 }],
    bids: [{ price: price - 1, quantity: 10 }],
  } as unknown as IOrderbook;
}

/** Records every call so a test can prove the sweep ran once, not twice. */
const calls: string[] = [];

vi.mock("@opentrader/exchanges", () => ({
  exchangeProvider: {
    fromCode: (code: string) => ({
      getOrderbook: async (symbol: string) => {
        calls.push(`${code}:${symbol}`);
        return book(100);
      },
    }),
  },
}));

const { scanArbitrage } = await import("./handler.js");

const ctx = { user: {} } as never;

function input(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "BTC/USDT",
    tradeQty: 0.01,
    minNetSpreadBps: 8,
    takerFeeBps: 10,
    ...overrides,
  } as never;
}

describe("scanArbitrage", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.useRealTimers();
  });

  it("serves a second identical request from cache without re-querying venues", async () => {
    await scanArbitrage({ ctx, input: input() });
    const first = calls.length;
    expect(first).toBeGreaterThan(0);

    await scanArbitrage({ ctx, input: input() });
    expect(calls.length).toBe(first);
  });

  it("does not de-duplicate a different symbol into the same cache entry", async () => {
    await scanArbitrage({ ctx, input: input() });
    const first = calls.length;

    await scanArbitrage({ ctx, input: input({ symbol: "ETH/USDT" }) });
    expect(calls.length).toBeGreaterThan(first);
  });

  it("collapses two concurrent identical requests into one sweep", async () => {
    const [a, b] = await Promise.all([
      scanArbitrage({ ctx, input: input() }),
      scanArbitrage({ ctx, input: input() }),
    ]);

    // One sweep's worth of venue calls, not two.
    const unique = new Set(calls);
    expect(calls.length).toBe(unique.size);
    expect(a.scannedAt).toBe(b.scannedAt);
  });

  it("re-queries once the cache entry has expired", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await scanArbitrage({ ctx, input: input() });
    const first = calls.length;

    await vi.advanceTimersByTimeAsync(20_000);
    await scanArbitrage({ ctx, input: input() });

    expect(calls.length).toBeGreaterThan(first);

    vi.useRealTimers();
  });

  it("drops a venue that never answers instead of hanging the request", async () => {
    vi.doMock("@opentrader/exchanges", () => ({
      exchangeProvider: {
        fromCode: (code: string) => ({
          getOrderbook: () =>
            code === "BYBIT" ? new Promise(() => {}) : Promise.resolve(book(100)),
        }),
      },
    }));

    vi.resetModules();
    const fresh = await import("./handler.js");

    vi.useFakeTimers();
    const promise = fresh.scanArbitrage({ ctx, input: input({ venues: ["BINANCE", "BYBIT"] }) });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(result.venuesQuoted.map((v) => v.venue)).toEqual(["BINANCE"]);
    expect(result.venuesFailed[0].venue).toBe("BYBIT");
    expect(result.venuesFailed[0].error).toContain("did not answer");

    vi.useRealTimers();
    vi.doUnmock("@opentrader/exchanges");
    vi.resetModules();
  });
});
