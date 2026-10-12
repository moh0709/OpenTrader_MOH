/**
 * The scanner's tolerance for a venue that misbehaves.
 *
 * `Promise.allSettled` has always dropped a venue that *rejects*. What it could
 * not do was drop a venue that never replies at all, and that is the case that
 * mattered: the sweep waited for the slowest participant, so one stalled
 * exchange set the latency for every request and every other venue's book was
 * thrown away with it.
 */
import { describe, expect, it, vi } from "vitest";
import type { IOrderbook } from "@opentrader/types";
import { collectQuotes, scanSymbol } from "./scanner.js";
import { DEFAULT_ARBITRAGE_CONFIG } from "./types.js";

const NOW = 1_700_000_000_000;

function book(price = 100): IOrderbook {
  return {
    symbol: "BTC/USDT",
    timestamp: NOW,
    asks: [{ price, quantity: 10 }],
    bids: [{ price: price - 0.1, quantity: 10 }],
  } as IOrderbook;
}

/** A venue that answers immediately. */
function fast(venue: string, price = 100) {
  return { venue, getOrderbook: async () => book(price) };
}

/** A venue whose socket is held open and never answers. */
function stalled(venue: string) {
  return { venue, getOrderbook: () => new Promise<IOrderbook>(() => {}) };
}

describe("collectQuotes — a venue that never answers", () => {
  it("drops the stalled venue and keeps the others", async () => {
    vi.useFakeTimers();

    const sources = [fast("BINANCE"), stalled("BYBIT"), fast("KRAKEN", 100.5)];
    const promise = collectQuotes(sources, "BTC/USDT", DEFAULT_ARBITRAGE_CONFIG, 50);

    // The two good venues resolve on their own; advancing the clock is what
    // trips the stalled one's deadline.
    await vi.advanceTimersByTimeAsync(50);
    const { quotes, failures } = await promise;

    expect(quotes.map((q) => q.venue).sort()).toEqual(["BINANCE", "KRAKEN"]);
    expect(failures).toEqual([{ venue: "BYBIT", error: "did not answer within 50ms" }]);

    vi.useRealTimers();
  });

  it("does not wait longer than the deadline, however many venues are stalled", async () => {
    vi.useFakeTimers();

    const promise = collectQuotes(
      [stalled("A"), stalled("B"), stalled("C")],
      "BTC/USDT",
      DEFAULT_ARBITRAGE_CONFIG,
      50,
    );

    await vi.advanceTimersByTimeAsync(50);
    const { quotes, failures } = await promise;

    expect(quotes).toEqual([]);
    expect(failures.map((f) => f.venue)).toEqual(["A", "B", "C"]);

    vi.useRealTimers();
  });

  it("keeps working when every venue answers in time", async () => {
    const { quotes, failures } = await collectQuotes(
      [fast("BINANCE"), fast("BYBIT", 100.2)],
      "BTC/USDT",
      DEFAULT_ARBITRAGE_CONFIG,
      1_000,
    );

    expect(failures).toEqual([]);
    expect(quotes).toHaveLength(2);
  });
});

describe("scanSymbol with a stalled venue", () => {
  it("still evaluates the pair it can see", async () => {
    vi.useFakeTimers();

    const promise = scanSymbol(
      [fast("BINANCE"), fast("BYBIT", 100.5), stalled("KRAKEN")],
      "BTC/USDT",
      DEFAULT_ARBITRAGE_CONFIG,
      50,
      NOW,
    );

    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(result.venuesQuoted.sort()).toEqual(["BINANCE", "BYBIT"]);
    expect(result.venuesFailed).toEqual([{ venue: "KRAKEN", error: "did not answer within 50ms" }]);
    expect(result.evaluations.length).toBeGreaterThan(0);

    vi.useRealTimers();
  });
});
