#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { aggregateCandles, buildValidationReport, fetchCoinbaseCandles } from "./lib/sol-dca-validator.mjs";
const options = {
  months: 18,
  capital: 1000,
  output: "/root/.hermes/home/.opentrader/sol-dca-validation.json",
};

for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!value || !["--months", "--capital", "--output"].includes(name)) {
    throw new Error("Usage: validate-sol-dca.mjs --months 18 --capital 1000 --output <path>");
  }
  options[name.slice(2)] = value;
}

options.months = Number(options.months);
options.capital = Number(options.capital);
if (!(options.months > 0) || !(options.capital > 0)) {
  throw new Error("Months and capital must be positive numbers");
}

const productId = "SOL-USD";
const apiBase = "https://api.exchange.coinbase.com";
const [productResponse, tickerResponse] = await Promise.all([
  fetch(`${apiBase}/products/${productId}`),
  fetch(`${apiBase}/products/${productId}/ticker`),
]);

if (!productResponse.ok) {
  throw new Error(`Coinbase product request failed with HTTP ${productResponse.status}`);
}
if (!tickerResponse.ok) {
  throw new Error(`Coinbase ticker request failed with HTTP ${tickerResponse.status}`);
}

const product = await productResponse.json();
const ticker = await tickerResponse.json();
const currentPrice = Number(ticker.price);
const baseIncrement = Number(product.base_increment);

if (product.status !== "online" || product.trading_disabled || !(currentPrice > 0) || !(baseIncrement > 0)) {
  throw new Error(
    `SOL-USD is not tradeable: ${JSON.stringify({
      status: product.status,
      tradingDisabled: product.trading_disabled,
      currentPrice,
      baseIncrement,
    })}`,
  );
}

const sourceGranularity = 60 * 60;
const sourceInterval = sourceGranularity * 1000;
const interval = 4 * sourceInterval;
const currentWindowStart = Math.floor(Date.now() / interval) * interval;
const end = currentWindowStart - 1;
const monthDuration = 30.4375 * 24 * 60 * 60 * 1000;
const start = Math.floor((end - options.months * monthDuration) / interval) * interval;

const hourlyCandles = await fetchCoinbaseCandles({
  productId,
  granularity: sourceGranularity,
  start,
  end,
});
const candles = aggregateCandles(hourlyCandles, sourceInterval, interval);
const report = buildValidationReport({
  candles,
  currentPrice,
  baseIncrement,
  capital: options.capital,
});
report.market = {
  status: product.status,
  tradingDisabled: product.trading_disabled,
  currentPrice,
  baseIncrement,
};

const serialized = JSON.stringify(
  report,
  (_key, value) => (typeof value === "number" && !Number.isFinite(value) ? String(value) : value),
  2,
);
await mkdir(dirname(options.output), { recursive: true });
await writeFile(options.output, `${serialized}\n`, {
  encoding: "utf8",
  mode: 0o600,
});

console.log(
  JSON.stringify({
    output: options.output,
    passed: report.passed,
    quantity: report.quantity,
    candleCount: report.data.candleCount,
    validationCandles: report.split.validationCandles,
    completedTrades: report.metrics.completedTrades,
    netReturn: report.metrics.netReturn,
    maxDrawdownPct: report.metrics.maxDrawdownPct,
    profitFactor: report.metrics.profitFactor,
    failures: report.gates.failures,
  }),
);

process.exitCode = report.passed ? 0 : 2;
