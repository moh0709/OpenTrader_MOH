import test from "node:test";
import assert from "node:assert/strict";

import { calculateRsi, evaluateGates, simulateDca } from "./sol-dca-validator.mjs";

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
