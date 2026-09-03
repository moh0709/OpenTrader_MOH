import { afterEach, describe, expect, it, vi } from "vitest";
import { buildColumns, fetchTechnicalRatings, parseRow, parseTickerOverrides, toTicker } from "./tradingview.js";

const columns = buildColumns();

/** Build a response row with the columns in the order the client asked for them. */
function row(values: Record<string, number | null>, ticker = "BINANCE:BTCUSDT") {
  return { s: ticker, d: columns.map((column) => values[column] ?? null) };
}

describe("toTicker", () => {
  it("maps an exchange symbol onto the vendor's format", () => {
    expect(toTicker("BTC/USDT")).toBe("BINANCE:BTCUSDT");
    expect(toTicker("PAXG/USDT", "OKX")).toBe("OKX:PAXGUSDT");
  });

  it("passes through anything that already names an exchange", () => {
    expect(toTicker("KRAKEN:XBTUSD")).toBe("KRAKEN:XBTUSD");
  });

  it("prefers an explicit override over the default exchange", () => {
    expect(toTicker("BTC/USDT", "BINANCE", { "BTC/USDT": "COINBASE:BTCUSD" })).toBe("COINBASE:BTCUSD");
  });
});

describe("parseTickerOverrides", () => {
  it("reads a comma separated mapping", () => {
    expect(parseTickerOverrides("BTC/USDT=OKX:BTCUSDT, ETH/USDT=BINANCE:ETHUSDT")).toEqual({
      "BTC/USDT": "OKX:BTCUSDT",
      "ETH/USDT": "BINANCE:ETHUSDT",
    });
  });

  it("ignores malformed entries rather than throwing", () => {
    expect(parseTickerOverrides("nonsense,,=,BTC/USDT=X:Y")).toEqual({ "BTC/USDT": "X:Y" });
  });
});

describe("parseRow", () => {
  it("blends the timeframes and reports how many agree", () => {
    const rating = parseRow(
      row({
        "Recommend.All": 0.6,
        "Recommend.All|60": 0.4,
        "Recommend.All|240": 0.5,
        RSI: 61,
        ADX: 28,
        close: 63000,
        change: 1.2,
      }),
      "BTC/USDT",
      columns,
      1000,
    );

    expect(rating).not.toBeNull();
    expect(rating!.rating).toBeCloseTo(0.5, 5);
    expect(rating!.label).toBe("strong_buy");
    expect(rating!.timeframes).toBe(3);
    expect(rating!.alignment).toBe(1);
    expect(rating!.rsi).toBe(61);
    expect(rating!.adx).toBe(28);
    expect(rating!.asOf).toBe(1000);
  });

  it("scores a market that disagrees with itself below one", () => {
    const rating = parseRow(
      row({ "Recommend.All": 0.6, "Recommend.All|60": -0.4, "Recommend.All|15": -0.2 }),
      "BTC/USDT",
      columns,
      1000,
    );

    // Blend is negative, so the two bearish timeframes are the ones agreeing.
    expect(rating!.rating).toBeLessThan(0);
    expect(rating!.alignment).toBeCloseTo(2 / 3, 5);
  });

  it("returns null when nothing was reported, rather than a neutral zero", () => {
    expect(parseRow(row({}), "BTC/USDT", columns, 1000)).toBeNull();
    expect(parseRow({ s: "X", d: "not an array" }, "BTC/USDT", columns, 1000)).toBeNull();
  });
});

describe("fetchTechnicalRatings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (payload: unknown, ok = true) => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok,
      status: ok ? 200 : 503,
      json: async () => payload,
    }));

    vi.stubGlobal("fetch", spy);

    return spy;
  };

  it("asks for every symbol in one request", async () => {
    const spy = stubFetch({ data: [row({ "Recommend.All": 0.3 }, "BINANCE:BTCUSDT")] });

    const result = await fetchTechnicalRatings(["BTC/USDT", "ETH/USDT"]);

    expect(spy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(spy.mock.calls[0][1]?.body));
    expect(body.symbols.tickers).toEqual(["BINANCE:BTCUSDT", "BINANCE:ETHUSDT"]);
    // Only the symbol the vendor answered for is present.
    expect([...result.keys()]).toEqual(["BTC/USDT"]);
  });

  it("returns an empty map when the vendor fails", async () => {
    stubFetch({}, false);
    expect((await fetchTechnicalRatings(["BTC/USDT"])).size).toBe(0);
  });

  it("returns an empty map when the vendor answers with something else entirely", async () => {
    stubFetch({ error: "moved" });
    expect((await fetchTechnicalRatings(["BTC/USDT"])).size).toBe(0);
  });

  it("never calls out for an empty watchlist", async () => {
    const spy = stubFetch({ data: [] });
    expect((await fetchTechnicalRatings([])).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
