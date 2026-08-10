import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotSupported } from "ccxt";
import type { BarSize, ICandlestick } from "@opentrader/types";
import type { IExchange } from "@opentrader/exchanges";
import { CandlesChannel } from "./candles.channel.js";

function createMockExchange(): IExchange {
  return {
    exchangeCode: "BINANCE",
    watchCandles: vi.fn(),
    getCandlesticks: vi.fn(),
  } as unknown as IExchange;
}

function getBaseAlignedTimestamp(): number {
  const ONE_MINUTE_MS = 60_000;
  return Math.floor(Date.now() / ONE_MINUTE_MS) * ONE_MINUTE_MS;
}

function createCandle(timestamp: number, price: number): ICandlestick {
  return {
    timestamp,
    open: price,
    high: price + 10,
    low: price - 5,
    close: price,
    volume: 100,
  };
}

describe("CandlesChannel", () => {
  const symbol = "BTC/USDT";
  const timeframe: BarSize = "5m";
  const bucketSize = 5;
  let channel: CandlesChannel;

  beforeEach(() => {
    const exchange = createMockExchange();
    channel = new CandlesChannel(symbol, timeframe, exchange);
    channel["enabled"] = true;
  });

  it("initializes correctly", async () => {
    await channel.init();
    expect(channel).toBeInstanceOf(CandlesChannel);
  });

  it("emits an aggregated candle after a full bucket", async () => {
    const baseTimestamp = getBaseAlignedTimestamp();
    const candles = Array.from({ length: bucketSize + 1 }, (_, i) => createCandle(baseTimestamp + i * 60000, 100 + i));

    return new Promise<void>((resolve) => {
      channel.on("candle", (candle, history) => {
        expect(candle.open).toBe(100);
        expect(candle.close).toBe(104);
        expect(history).toHaveLength(1);
        resolve();
      });

      for (const candle of candles) {
        channel["handleCandle"](candle);
      }
    });
  });

  it("fills gaps between candles with previous close values", () => {
    const baseTimestamp = getBaseAlignedTimestamp();
    const firstCandle = createCandle(baseTimestamp, 100);
    const lateCandle = createCandle(baseTimestamp + 4 * 60000, 200);

    channel["handleCandle"](firstCandle);
    channel["handleCandle"](lateCandle);

    expect(channel["bucket"]).toHaveLength(5);
    expect(channel["bucket"][1].timestamp).toBe(baseTimestamp + 60000);
    expect(channel["bucket"][1].close).toBe(100);
  });

  it("skips outdated candles", () => {
    const baseTimestamp = getBaseAlignedTimestamp();
    const validCandle = createCandle(baseTimestamp, 100);
    const outdatedCandle = createCandle(baseTimestamp - 60000, 90);

    channel["handleCandle"](validCandle);
    channel["handleCandle"](outdatedCandle);

    expect(channel["bucket"]).toHaveLength(1);
    expect(channel["bucket"][0].timestamp).toBe(baseTimestamp);
  });

  it("updates duplicate timestamp candles correctly", () => {
    const alignedTimestamp = getBaseAlignedTimestamp();
    const originalCandle = createCandle(alignedTimestamp, 100);
    const updatedCandle = createCandle(alignedTimestamp, 110);

    channel["handleCandle"](originalCandle);
    channel["handleCandle"](updatedCandle);

    const result = channel["bucket"][0];
    expect(result.high).toBe(120);
    expect(result.low).toBe(95);
    expect(result.close).toBe(110);
  });

  it("initializes a completed candle from sparse exchange data", async () => {
    const baseTimestamp = getBaseAlignedTimestamp() - 10 * 60000;
    const exchange = createMockExchange();
    const sparseChannel = new CandlesChannel(symbol, timeframe, exchange);

    vi.mocked(exchange.getCandlesticks)
      .mockResolvedValueOnce([
        createCandle(baseTimestamp, 100),
        createCandle(baseTimestamp + 4 * 60000, 105),
        createCandle(baseTimestamp + 5 * 60000, 106),
      ])
      .mockResolvedValueOnce([]);

    await sparseChannel.init(1);

    expect(sparseChannel["candlesHistory"]).toHaveLength(1);
    expect(sparseChannel["candlesHistory"][0]).toMatchObject({
      timestamp: baseTimestamp,
      close: 105,
    });
  });

  it("does not request candles after the current minute", async () => {
    const currentMinute = getBaseAlignedTimestamp();
    const exchange = createMockExchange();
    const oneMinuteChannel = new CandlesChannel(symbol, "1m", exchange);

    vi.mocked(exchange.getCandlesticks).mockImplementation(async ({ since }) => {
      if (since > currentMinute) {
        throw new Error("Exchange request begins in the future");
      }

      return [
        createCandle(currentMinute - 2 * 60000, 100),
        createCandle(currentMinute - 60000, 101),
        createCandle(currentMinute, 102),
      ];
    });

    await oneMinuteChannel.init();

    expect(oneMinuteChannel["candlesHistory"]).toHaveLength(1);
    expect(oneMinuteChannel["candlesHistory"][0]).toMatchObject({
      timestamp: currentMinute - 2 * 60000,
      close: 100,
    });
  });

  it("initializes from the last available completed interval when recent candles are delayed", async () => {
    const currentMinute = getBaseAlignedTimestamp();
    const currentWindowStart =
      (Math.floor(currentMinute / 60000) - (Math.floor(currentMinute / 60000) % bucketSize)) * 60000;
    const previousWindowStart = currentWindowStart - bucketSize * 60000;
    const olderWindowStart = previousWindowStart - bucketSize * 60000;
    const exchange = createMockExchange();
    const delayedChannel = new CandlesChannel(symbol, timeframe, exchange);

    vi.mocked(exchange.getCandlesticks).mockImplementation(async ({ since }) => {
      if (since < previousWindowStart) {
        return Array.from({ length: bucketSize }, (_, index) =>
          createCandle(olderWindowStart + index * 60000, 100 + index),
        );
      }

      if (since === previousWindowStart) {
        return Array.from({ length: 4 }, (_, index) => createCandle(previousWindowStart + index * 60000, 110 + index));
      }

      return [];
    });

    await delayedChannel.init(1);

    expect(delayedChannel["candlesHistory"]).toHaveLength(1);
    expect(delayedChannel["candlesHistory"][0]).toMatchObject({
      timestamp: olderWindowStart,
      close: 104,
    });
  });

  it("falls back to REST polling when candle streaming is unsupported", async () => {
    vi.useFakeTimers();
    const baseTimestamp = getBaseAlignedTimestamp();
    const exchange = createMockExchange();
    const pollingChannel = new CandlesChannel(symbol, timeframe, exchange);
    pollingChannel["enabled"] = true;

    vi.mocked(exchange.watchCandles).mockRejectedValue(new NotSupported("watchOHLCV is not supported"));
    vi.mocked(exchange.getCandlesticks).mockResolvedValue([createCandle(baseTimestamp, 100)]);

    try {
      const watcher = pollingChannel["watchCandles"]();
      await vi.advanceTimersByTimeAsync(0);

      expect(pollingChannel["bucket"]).toHaveLength(1);
      expect(pollingChannel["bucket"][0]).toMatchObject({
        timestamp: baseTimestamp,
        close: 100,
      });

      pollingChannel.stop();
      await vi.advanceTimersByTimeAsync(15000);
      await watcher;
    } finally {
      vi.useRealTimers();
    }
  });
});
