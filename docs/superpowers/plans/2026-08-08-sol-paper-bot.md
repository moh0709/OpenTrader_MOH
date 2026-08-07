# SOL Paper Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate and create one fee-aware, USD 1,000-capped SOL/USD DCA bot on OpenTrader's existing Coinbase paper account, then start and monitor it only if every approved validation gate passes.

**Architecture:** A small dependency-free Node.js validator fetches Coinbase 4-hour candles, calculates Wilder RSI, simulates the approved long-only DCA lifecycle, and emits a machine-readable report. An operator script consumes a passing report, re-verifies paper-account and market state, creates the bot through authenticated tRPC, reads it back, starts it, and checks service logs.

**Tech Stack:** Node.js 22 built-in `fetch` and test runner, Coinbase Exchange public REST API, OpenTrader tRPC, SQLite, systemd.

## Global Constraints

- Bot name is exactly `SOL`; symbol is exactly `SOL/USD`; template is exactly `dca`.
- Exchange account ID 1 must have `isPaperAccount=1` and `expired=0`.
- Modeled capital including fees is at most USD 1,000.
- Entry rule is RSI(14) on 4-hour candles less than or equal to 28.
- Safety orders are 5%, 10%, and 15% below initial entry; TP is 4%; SL is 20%.
- Simulation uses 0.6% per fill/exit and 0.1% slippage on market/stop fills.
- Validation requires positive net return, drawdown <=15%, profit factor >=1.15, at least 10 completed validation trades, and valid candle continuity.
- No real account may be changed or used.
- Never print or persist the OpenTrader authorization secret.

---

### Task 1: Deterministic DCA simulation core

**Files:**
- Create: `scripts/lib/sol-dca-validator.mjs`
- Create: `scripts/lib/sol-dca-validator.test.mjs`

**Interfaces:**
- Consumes: normalized candles `{timestamp, open, high, low, close, volume}`.
- Produces: `calculateRsi(candles, periods)`, `simulateDca(candles, options)`, and `evaluateGates(report, gates)`.

- [ ] **Step 1: Write failing unit tests**

Cover Wilder RSI warm-up, four-entry weighted average, safety fills, TP after fees, conservative SL precedence when TP and SL occur in one candle, maximum drawdown, and all validation-gate failures.

- [ ] **Step 2: Run tests and verify red**

Run:

`node --test scripts/lib/sol-dca-validator.test.mjs`

Expected: FAIL because `sol-dca-validator.mjs` does not exist.

- [ ] **Step 3: Implement the simulation core**

Export:

```js
export function calculateRsi(candles, periods = 14) {}
export function simulateDca(candles, {
  tradeStartIndex,
  rsiThreshold = 28,
  quantity,
  safetyDeviations = [0.05, 0.10, 0.15],
  takeProfit = 0.04,
  stopLoss = 0.20,
  feeRate = 0.006,
  slippageRate = 0.001,
  initialCapital = 1000,
}) {}
export function evaluateGates(report, {
  maxDrawdown = 0.15,
  minProfitFactor = 1.15,
  minCompletedTrades = 10,
}) {}
```

Use candle close for an entry signal. On subsequent candles, process stop loss before same-candle profit, fill crossed safety levels from nearest to farthest, recompute weighted average, and then evaluate take profit. Mark open positions to the candle close for drawdown. Exclude an unfinished final trade from completed-trade statistics but include its marked value in ending equity.

- [ ] **Step 4: Run tests and verify green**

Run:

`node --test scripts/lib/sol-dca-validator.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit the core**

```bash
git add scripts/lib/sol-dca-validator.mjs scripts/lib/sol-dca-validator.test.mjs
git commit -m "feat(backtesting): add SOL DCA validator"
```

### Task 2: Coinbase history fetcher and report CLI

**Files:**
- Modify: `scripts/lib/sol-dca-validator.mjs`
- Modify: `scripts/lib/sol-dca-validator.test.mjs`
- Create: `scripts/validate-sol-dca.mjs`

**Interfaces:**
- Produces: `fetchCoinbaseCandles({productId, granularity, start, end, fetchImpl})` with ascending, de-duplicated candles.
- CLI arguments: `--months 18 --capital 1000 --output <absolute-path>`.
- CLI output: JSON report including configuration, data interval, train/validation split, metrics, gates, and `passed`.

- [ ] **Step 1: Write failing fetch tests**

Inject a fake `fetchImpl` and test pagination, descending Coinbase responses, duplicate removal, invalid rows, HTTP errors, and 4-hour continuity reporting.

- [ ] **Step 2: Run tests and verify red**

Run:

`node --test scripts/lib/sol-dca-validator.test.mjs`

Expected: FAIL because `fetchCoinbaseCandles` is not exported.

- [ ] **Step 3: Implement fetch and CLI**

Fetch windows of at most 300 4-hour candles from
`https://api.exchange.coinbase.com/products/SOL-USD/candles`. Sort ascending,
remove duplicate timestamps, reject malformed OHLC values, and report every
non-4-hour gap. Reserve the last 30% for validation while supplying earlier
candles only for RSI warm-up.

Compute:

`quantity = floorToIncrement(1000 / (4 * 1.006 * currentPrice), baseIncrement)`

The CLI exits 0 only when every gate passes and exits 2 for a valid report that
fails a gate.

- [ ] **Step 4: Verify tests and a real report**

Run:

```bash
node --test scripts/lib/sol-dca-validator.test.mjs
node scripts/validate-sol-dca.mjs --months 18 --capital 1000 --output /root/.hermes/home/.opentrader/sol-dca-validation.json
```

Expected: tests pass; the CLI writes a complete report and clearly returns pass
or gate failure without exposing credentials.

- [ ] **Step 5: Commit the CLI**

```bash
git add scripts/lib/sol-dca-validator.mjs scripts/lib/sol-dca-validator.test.mjs scripts/validate-sol-dca.mjs
git commit -m "feat(backtesting): validate SOL DCA configuration"
```

### Task 3: Create and verify the paper bot

**Files:**
- Read: `/root/.hermes/home/.opentrader/opentrader.db`
- Read: `/root/.hermes/home/.opentrader/sol-dca-validation.json`

**Interfaces:**
- Consumes: passing report and exact approved configuration.
- Produces: one persisted bot named `SOL` and its numeric bot ID.

- [ ] **Step 1: Re-verify safety preconditions**

Query `ExchangeAccount` for ID 1 and abort unless paper is true and expired is
false. Query `Bot` and abort creation if `SOL` already exists; validate the
existing record instead of creating a duplicate.

- [ ] **Step 2: Verify public market state**

Confirm Coinbase `SOL-USD` is online, the ticker is positive, and the base
increment supports the report quantity.

- [ ] **Step 3: Create via authenticated tRPC**

POST `bot.create` with account ID 1 and:

```json
{
  "name": "SOL",
  "symbol": "SOL/USD",
  "template": "dca",
  "timeframe": "1m",
  "logging": true,
  "settings": {
    "entry": {
      "quantity": "<validated quantity>",
      "type": "Market",
      "conditions": {
        "combinator": "and",
        "rules": [{
          "field": "RSI",
          "operator": "<=",
          "value": {"indicatorValue": "28", "timeframe": "4h", "periods": "14"},
          "id": "sol-rsi-entry"
        }],
        "id": "sol-entry"
      }
    },
    "tp": {"percent": 4},
    "sl": {"percent": 20},
    "safetyOrders": [
      {"quantity": "<validated quantity>", "priceDeviation": 5},
      {"quantity": "<validated quantity>", "priceDeviation": 10},
      {"quantity": "<validated quantity>", "priceDeviation": 15}
    ]
  }
}
```

- [ ] **Step 4: Read back and compare**

Use `bot.getOne` and a direct database query. Verify every field, decoded
setting, account ID, paper status, and total modeled exposure.

### Task 4: Start and monitor

**Files:**
- Read: systemd journal for `opentrader.service`

**Interfaces:**
- Consumes: verified SOL bot ID.
- Produces: running paper bot with monitored healthy startup.

- [ ] **Step 1: Start through authenticated tRPC**

Call `bot.start` once and require HTTP 200 with `{"ok":true}`.

- [ ] **Step 2: Monitor for at least 60 seconds**

Require RSI/DCA startup, indicator warm-up, candle subscription or documented
REST fallback, active `opentrader.service`, and no candle, order, strategy, or
service errors.

- [ ] **Step 3: Run final verification**

Run unit tests, `git diff --check`, query the saved bot, confirm service
health, and scan logs since start. Report the validation metrics and whether
the bot remains running.
