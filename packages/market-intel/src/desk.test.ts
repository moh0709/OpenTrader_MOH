import { afterEach, describe, expect, it, vi } from "vitest";
import { IntelDesk, TECHNICAL_MAX_AGE_MS } from "./desk.js";
import { buildColumns } from "./tradingview.js";
import { parseSentiment } from "./sentiment.js";

const columns = buildColumns();

function technicalRow(rating: number, ticker = "BINANCE:BTCUSDT") {
  return { s: ticker, d: columns.map((column) => (column === "Recommend.All" ? rating : null)) };
}

describe("parseSentiment", () => {
  it("reads the vendor payload and converts its seconds to milliseconds", () => {
    const reading = parseSentiment({ data: [{ value: "72", value_classification: "Greed", timestamp: "1700000000" }] });

    expect(reading).toEqual({ source: "alternative.me", value: 72, label: "Greed", asOf: 1_700_000_000_000 });
  });

  it("refuses a reading outside the published range", () => {
    expect(parseSentiment({ data: [{ value: "150" }] })).toBeNull();
    expect(parseSentiment({ data: [] })).toBeNull();
    expect(parseSentiment(null)).toBeNull();
  });
});

describe("IntelDesk", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** One stub answering both endpoints, so a pass exercises the real batching. */
  function stubSources(rating: number, sentiment: number) {
    const spy = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes("alternative")
          ? { data: [{ value: String(sentiment), value_classification: "Greed", timestamp: "1700000000" }] }
          : { data: [technicalRow(rating)] },
    }));

    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("gathers both sources and keys the result by symbol", async () => {
    stubSources(0.4, 72);
    const desk = new IntelDesk({
      tradingView: { baseUrl: "https://scanner.example" },
      sentiment: { url: "https://alternative.example/fng" },
    });

    const intel = await desk.gather(["BTC/USDT"]);
    const btc = intel.get("BTC/USDT")!;

    expect(btc.technical!.rating).toBeCloseTo(0.4, 5);
    expect(btc.sentiment!.value).toBe(72);
  });

  it("serves the cache instead of re-asking inside the TTL", async () => {
    const spy = stubSources(0.4, 72);
    const desk = new IntelDesk({
      tradingView: { baseUrl: "https://scanner.example" },
      sentiment: { url: "https://alternative.example/fng" },
    });

    await desk.gather(["BTC/USDT"]);
    await desk.gather(["BTC/USDT"]);

    // Two sources, one call each — the second pass hit the cache.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("stops serving a reading once it is older than the hard limit", async () => {
    let now = 1_000_000;
    stubSources(0.4, 72);
    const desk = new IntelDesk({
      tradingView: { baseUrl: "https://scanner.example" },
      sentiment: null,
      now: () => now,
    });

    await desk.gather(["BTC/USDT"]);

    // Push time past the refresh TTL and the hard age limit, then make the
    // vendor fail: the desk must report nothing rather than a stale opinion.
    now += TECHNICAL_MAX_AGE_MS + 1;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    const intel = await desk.gather(["BTC/USDT"]);
    expect(intel.get("BTC/USDT")!.technical).toBeNull();
  });

  it("makes no network calls at all when both sources are switched off", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    const desk = new IntelDesk({ tradingView: null, sentiment: null });
    const intel = await desk.gather(["BTC/USDT"]);

    expect(spy).not.toHaveBeenCalled();
    expect(intel.get("BTC/USDT")).toEqual({ symbol: "BTC/USDT", technical: null, sentiment: null });
  });
});
