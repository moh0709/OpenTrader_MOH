import { describe, expect, it, vi } from "vitest";
import { TickerCache } from "./ticker-cache.js";

const REQUEST = [{ exchangeCode: "COINBASE", symbol: "BTC/USD" }];

function makeClock(start = 1_000_000) {
  let now = start;

  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("TickerCache", () => {
  it("stores a fetched price and reports it as fresh", async () => {
    const clock = makeClock();
    const fetcher = vi.fn().mockResolvedValue({ last: 65_025, bid: 65_024, ask: 65_026, timestamp: clock.now() });
    const cache = new TickerCache(fetcher, 10_000, 120_000, clock.now);

    await cache.refresh(REQUEST);

    const [ticker] = cache.list();
    expect(ticker!.last).toBe(65_025);
    expect(ticker!.stale).toBe(false);
    expect(ticker!.error).toBeNull();
  });

  it("serves from cache inside the TTL instead of hitting the exchange again", async () => {
    const clock = makeClock();
    const fetcher = vi.fn().mockResolvedValue({ last: 1, bid: 1, ask: 1, timestamp: clock.now() });
    const cache = new TickerCache(fetcher, 10_000, 120_000, clock.now);

    await cache.refresh(REQUEST);
    clock.advance(5_000);
    await cache.refresh(REQUEST);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL has passed", async () => {
    const clock = makeClock();
    const fetcher = vi.fn().mockResolvedValue({ last: 1, bid: 1, ask: 1, timestamp: clock.now() });
    const cache = new TickerCache(fetcher, 10_000, 120_000, clock.now);

    await cache.refresh(REQUEST);
    clock.advance(11_000);
    await cache.refresh(REQUEST);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent requests for the same symbol into one call", async () => {
    // Several dashboard clients refreshing at once must not multiply exchange load.
    const clock = makeClock();
    let resolve!: (value: unknown) => void;
    const fetcher = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    const cache = new TickerCache(fetcher, 10_000, 120_000, clock.now);

    const first = cache.refresh(REQUEST);
    const second = cache.refresh(REQUEST);
    resolve({ last: 1, bid: 1, ask: 1, timestamp: clock.now() });
    await Promise.all([first, second]);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("deduplicates repeated symbols within one refresh", async () => {
    const clock = makeClock();
    const fetcher = vi.fn().mockResolvedValue({ last: 1, bid: 1, ask: 1, timestamp: clock.now() });
    const cache = new TickerCache(fetcher, 10_000, 120_000, clock.now);

    await cache.refresh([...REQUEST, ...REQUEST, ...REQUEST]);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps serving the last good price when a refresh fails", async () => {
    // A brief exchange outage should not blank out every position on the dashboard.
    const clock = makeClock();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ last: 65_025, bid: 65_024, ask: 65_026, timestamp: clock.now() })
      .mockRejectedValueOnce(new Error("network timeout"));
    const cache = new TickerCache(fetcher, 10_000, 120_000, clock.now);

    await cache.refresh(REQUEST);
    clock.advance(11_000);
    await cache.refresh(REQUEST);

    const [ticker] = cache.list();
    expect(ticker!.last).toBe(65_025);
    expect(ticker!.error).toBe("network timeout");
    expect(ticker!.stale).toBe(true);
  });

  it("drops a price that has gone too stale to trust", async () => {
    const clock = makeClock();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ last: 65_025, bid: 65_024, ask: 65_026, timestamp: clock.now() })
      .mockRejectedValue(new Error("still down"));
    const cache = new TickerCache(fetcher, 10_000, 120_000, clock.now);

    await cache.refresh(REQUEST);
    clock.advance(200_000);
    await cache.refresh(REQUEST);

    expect(cache.list()[0]!.last).toBeNull();
  });

  it("counts consecutive failures so a persistent outage is visible", async () => {
    const clock = makeClock();
    const fetcher = vi.fn().mockRejectedValue(new Error("down"));
    const cache = new TickerCache(fetcher, 0, 120_000, clock.now);

    await cache.refresh(REQUEST);
    await cache.refresh(REQUEST);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.list()[0]!.error).toBe("down");
  });

  it("never rejects, so one bad symbol cannot fail a whole refresh", async () => {
    const clock = makeClock();
    const fetcher = vi.fn().mockImplementation((_code: string, symbol: string) =>
      symbol === "BAD/USD" ? Promise.reject(new Error("no such market")) : Promise.resolve({ last: 5, bid: 5, ask: 5, timestamp: clock.now() }),
    );
    const cache = new TickerCache(fetcher, 10_000, 120_000, clock.now);

    await expect(
      cache.refresh([{ exchangeCode: "COINBASE", symbol: "BAD/USD" }, { exchangeCode: "COINBASE", symbol: "BTC/USD" }]),
    ).resolves.toBeUndefined();

    expect(cache.bySymbol().get("BTC/USD")!.last).toBe(5);
    expect(cache.bySymbol().get("BAD/USD")!.error).toBe("no such market");
  });

  it("reports no fetch age before anything has been priced", () => {
    const clock = makeClock();
    const cache = new TickerCache(vi.fn(), 10_000, 120_000, clock.now);

    expect(cache.oldestFetchAge()).toBeNull();
  });

  it("reports the stalest fetch age, so one lagging symbol is not hidden by a fresh one", async () => {
    const clock = makeClock();
    const fetcher = vi.fn().mockResolvedValue({ last: 1, bid: 1, ask: 1, timestamp: clock.now() });
    const cache = new TickerCache(fetcher, 10_000, 120_000, clock.now);

    await cache.refresh([{ exchangeCode: "COINBASE", symbol: "BTC/USD" }]);
    clock.advance(90_000);
    await cache.refresh([{ exchangeCode: "COINBASE", symbol: "ETH/USD" }]);

    expect(cache.oldestFetchAge()).toBe(90_000);
  });

  it("waits for the fetch when asked to, so the caller reads a price it just took", async () => {
    const clock = makeClock();
    const fetcher = vi.fn().mockResolvedValue({ last: 42, bid: 42, ask: 42, timestamp: clock.now() });
    const cache = new TickerCache(fetcher, 10_000, 120_000, clock.now);

    await cache.refreshWithin(REQUEST, 5_000);

    expect(cache.list()[0]!.last).toBe(42);
    expect(cache.oldestFetchAge()).toBe(0);
  });

  it("gives up waiting on a hung exchange rather than hanging the caller", async () => {
    // An exchange call with no answer must leave the reading visibly stale, not
    // block the dashboard and the health probe behind it.
    const clock = makeClock();
    const fetcher = vi.fn().mockReturnValue(new Promise(() => {}));
    const cache = new TickerCache(fetcher, 10_000, 120_000, clock.now);

    await expect(cache.refreshWithin(REQUEST, 20)).resolves.toBeUndefined();

    expect(cache.list()).toHaveLength(0);
  });

  it("ages a reading from its exchange timestamp, not from when it was cached", async () => {
    const clock = makeClock();
    const fetcher = vi.fn().mockResolvedValue({ last: 1, bid: 1, ask: 1, timestamp: clock.now() - 30_000 });
    const cache = new TickerCache(fetcher, 10_000, 120_000, clock.now);

    await cache.refresh(REQUEST);

    expect(cache.list()[0]!.ageMs).toBe(30_000);
  });
});
