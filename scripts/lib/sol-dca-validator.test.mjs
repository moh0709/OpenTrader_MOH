import test from "node:test";
import assert from "node:assert/strict";

import {
  buildValidationReport,
  aggregateCandles,
  calculateRsi,
  evaluateGates,
  fetchCoinbaseCandles,
  findCandleGaps,
  floorToIncrement,
  simulateDca,
} from "./sol-dca-validator.mjs";

const FOUR_HOURS = 4 * 60 * 60 * 1000;

function candle(index, { open = 100, high = 100, low = 100, close = 100 } = {}) {
  return {
    timestamp: index * FOUR_HOURS,
    open,
    high,
    low,
    close,
    volume: 1,
  };
}

function warmupCandles() {
  return Array.from({ length: 15 }, (_, index) => candle(index));
}

test("Wilder RSI reports 100 after fourteen consecutive gains", () => {
  const candles = Array.from({ length: 15 }, (_, index) =>
    candle(index, {
      open: 100 + index,
      high: 100 + index,
      low: 100 + index,
      close: 100 + index,
    }),
  );

  const values = calculateRsi(candles, 14);

  assert.equal(values.length, 15);
  assert.equal(values[13], undefined);
  assert.equal(values[14], 100);
});

test("DCA fills all safety levels and takes profit from weighted average", () => {
  const candles = [
    ...warmupCandles(),
    candle(15, { open: 100, high: 100, low: 94, close: 95 }),
    candle(16, { open: 95, high: 96, low: 89, close: 90 }),
    candle(17, { open: 90, high: 95, low: 84, close: 85 }),
    candle(18, { open: 90, high: 97, low: 90, close: 96 }),
  ];

  const report = simulateDca(candles, {
    tradeStartIndex: 0,
    rsiThreshold: 100,
    quantity: 1,
    feeRate: 0,
    slippageRate: 0,
    initialCapital: 1000,
  });

  assert.equal(report.completedTrades, 1);
  assert.equal(report.trades[0].exitReason, "take-profit");
  assert.equal(report.trades[0].fills.length, 4);
  assert.equal(report.trades[0].averageEntry, 92.5);
  assert.equal(report.trades[0].exitPrice, 96.2);
  assert.ok(Math.abs(report.trades[0].netPnl - 14.8) < 1e-9);
});

test("stop loss wins when a candle also reaches take profit", () => {
  const candles = [...warmupCandles(), candle(15, { open: 100, high: 110, low: 79, close: 105 })];

  const report = simulateDca(candles, {
    tradeStartIndex: 0,
    rsiThreshold: 100,
    quantity: 1,
    safetyDeviations: [],
    feeRate: 0,
    slippageRate: 0,
    initialCapital: 1000,
  });

  assert.equal(report.completedTrades, 1);
  assert.equal(report.trades[0].exitReason, "stop-loss");
  assert.equal(report.trades[0].exitPrice, 80);
  assert.equal(report.trades[0].netPnl, -20);
  assert.equal(report.maxDrawdownPct, 0.02);
});

test("round-trip fees are deducted from net profit", () => {
  const candles = [...warmupCandles(), candle(15, { open: 100, high: 105, low: 100, close: 104 })];

  const report = simulateDca(candles, {
    tradeStartIndex: 0,
    rsiThreshold: 100,
    quantity: 1,
    safetyDeviations: [],
    feeRate: 0.006,
    slippageRate: 0,
    initialCapital: 1000,
  });

  assert.equal(report.completedTrades, 1);
  assert.ok(Math.abs(report.trades[0].netPnl - 2.776) < 1e-9);
});

test("an unfinished trade is marked to market but is not counted as completed", () => {
  const candles = [...warmupCandles(), candle(15, { open: 100, high: 101, low: 99, close: 99 })];

  const report = simulateDca(candles, {
    tradeStartIndex: 0,
    rsiThreshold: 100,
    quantity: 1,
    safetyDeviations: [],
    feeRate: 0,
    slippageRate: 0,
    initialCapital: 1000,
  });

  assert.equal(report.completedTrades, 0);
  assert.equal(report.openTrade, true);
  assert.equal(report.endingEquity, 999);
  assert.equal(report.maxDrawdownPct, 0.001);
});

test("validation gates report every failed requirement", () => {
  const result = evaluateGates(
    {
      netReturn: -0.01,
      maxDrawdownPct: 0.16,
      profitFactor: 1.1,
      completedTrades: 9,
      dataValid: false,
    },
    {
      maxDrawdown: 0.15,
      minProfitFactor: 1.15,
      minCompletedTrades: 10,
    },
  );

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [
    "net return must be positive",
    "maximum drawdown exceeds 15.00%",
    "profit factor is below 1.15",
    "completed trades are below 10",
    "market data is incomplete or invalid",
  ]);
});

test("validation gates pass an eligible report", () => {
  const result = evaluateGates({
    netReturn: 0.03,
    maxDrawdownPct: 0.1,
    profitFactor: 1.2,
    completedTrades: 10,
    dataValid: true,
  });

  assert.deepEqual(result, { passed: true, failures: [] });
});

test("Coinbase candles are paginated, de-duplicated, and sorted", async () => {
  const baseMs = Date.UTC(2026, 0, 1);
  const baseSeconds = baseMs / 1000;
  const endMs = baseMs + 301_000;

  const fetchImpl = async (url) => {
    const start = new URL(url).searchParams.get("start");
    const rows =
      start === new Date(baseMs).toISOString()
        ? [
            [baseSeconds + 300, 90, 110, 100, 105, 12],
            [baseSeconds, 80, 100, 90, 95, 10],
          ]
        : [
            [baseSeconds + 301, 91, 111, 101, 106, 13],
            [baseSeconds + 300, 90, 110, 100, 105, 12],
          ];

    return {
      ok: true,
      json: async () => rows,
    };
  };

  const candles = await fetchCoinbaseCandles({
    productId: "SOL-USD",
    granularity: 1,
    start: baseMs,
    end: endMs,
    fetchImpl,
    requestDelayMs: 0,
  });

  assert.deepEqual(
    candles.map(({ timestamp, close }) => ({ timestamp, close })),
    [
      { timestamp: baseMs, close: 95 },
      { timestamp: baseMs + 300_000, close: 105 },
      { timestamp: baseMs + 301_000, close: 106 },
    ],
  );
});

test("Coinbase candle fetch rejects malformed OHLC rows", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [[1_700_000_000, 110, 90, 100, 105, 12]],
  });

  await assert.rejects(
    fetchCoinbaseCandles({
      productId: "SOL-USD",
      granularity: 14400,
      start: 1_700_000_000_000,
      end: 1_700_014_400_000,
      fetchImpl,
    }),
    /Invalid Coinbase candle/,
  );
});

test("Coinbase candle fetch reports HTTP failures", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    text: async () => "rate limited",
  });

  await assert.rejects(
    fetchCoinbaseCandles({
      productId: "SOL-USD",
      granularity: 14400,
      start: 1_700_000_000_000,
      end: 1_700_014_400_000,
      fetchImpl,
    }),
    /Coinbase candles request failed with HTTP 429/,
  );
});

test("continuity reports the exact missing candle interval", () => {
  const candles = [candle(0), candle(1), candle(3)];

  assert.deepEqual(findCandleGaps(candles, FOUR_HOURS), [
    {
      after: FOUR_HOURS,
      before: 3 * FOUR_HOURS,
      missingCandles: 1,
    },
  ]);
});

test("quantity is rounded down to the market increment", () => {
  assert.equal(floorToIncrement(3.39214, 0.001), 3.392);
  assert.equal(floorToIncrement(3.39214, 0.01), 3.39);
});

test("validation report reserves fees before rounding bot quantity", () => {
  const candles = [
    ...warmupCandles(),
    candle(15, { open: 100, high: 100, low: 94, close: 95 }),
    candle(16, { open: 95, high: 96, low: 89, close: 90 }),
    candle(17, { open: 90, high: 95, low: 84, close: 85 }),
    candle(18, { open: 90, high: 97, low: 90, close: 96 }),
  ];

  const report = buildValidationReport({
    candles,
    currentPrice: 100,
    baseIncrement: 0.01,
    capital: 1000,
  });

  assert.equal(report.quantity, 2.48);
  assert.equal(report.split.validationIndex, 13);
  assert.equal(report.configuration.feeRate, 0.006);
  assert.equal(report.configuration.slippageRate, 0.001);
  assert.equal(report.data.gaps.length, 0);
  assert.equal(report.passed, false);
  assert.ok(report.gates.failures.includes("completed trades are below 10"));
});

test("one-hour candles aggregate into one complete four-hour candle", () => {
  const oneHour = 60 * 60 * 1000;
  const candles = [
    {
      timestamp: 0,
      open: 100,
      high: 105,
      low: 99,
      close: 103,
      volume: 1,
    },
    {
      timestamp: oneHour,
      open: 103,
      high: 110,
      low: 102,
      close: 108,
      volume: 2,
    },
    {
      timestamp: 2 * oneHour,
      open: 108,
      high: 109,
      low: 101,
      close: 102,
      volume: 3,
    },
    {
      timestamp: 3 * oneHour,
      open: 102,
      high: 106,
      low: 98,
      close: 104,
      volume: 4,
    },
  ];

  assert.deepEqual(aggregateCandles(candles, oneHour, FOUR_HOURS), [
    { timestamp: 0, open: 100, high: 110, low: 98, close: 104, volume: 10 },
  ]);
});
