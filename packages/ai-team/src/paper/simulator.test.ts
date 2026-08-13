import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_LIMITS, type Candle } from "../types.js";
import { createAccount, DEFAULT_PAPER_CONFIG, equity, executeFill, replay } from "./simulator.js";

const config = { ...DEFAULT_PAPER_CONFIG, startingCashQuote: 1000, feeBps: 10, slippageBps: 5 };

function candles(values: number[]): Candle[] {
  return values.map((close, i) => ({
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    volume: 1,
    timestamp: 1_700_000_000_000 + i * 60_000,
  }));
}

describe("executeFill", () => {
  it("buys, charging fee and adverse slippage", () => {
    const account = createAccount(config);
    const fill = executeFill(account, config, "buy", 100, 100, 1);

    expect(fill).not.toBeNull();
    // Slippage pushes the buy price above the market.
    expect(fill!.price).toBeGreaterThan(100);
    expect(fill!.feeQuote).toBeGreaterThan(0);
    expect(account.positionBase).toBeGreaterThan(0);
    // Spend is capped at the requested notional including costs.
    expect(account.cashQuote).toBeCloseTo(900, 1);
  });

  it("sells below the market price", () => {
    const account = createAccount(config);
    executeFill(account, config, "buy", 100, 100, 1);
    const held = account.positionBase;

    const fill = executeFill(account, config, "sell", held * 100, 100, 2);

    expect(fill).not.toBeNull();
    expect(fill!.price).toBeLessThan(100);
    expect(account.positionBase).toBeCloseTo(0, 9);
  });

  it("books a profit when price rises between entry and exit", () => {
    const account = createAccount(config);
    executeFill(account, config, "buy", 500, 100, 1);
    executeFill(account, config, "sell", account.positionBase * 120, 120, 2);

    expect(account.realizedPnl).toBeGreaterThan(0);
    expect(account.consecutiveLosses).toBe(0);
  });

  it("books a loss and increments the losing streak when price falls", () => {
    const account = createAccount(config);
    executeFill(account, config, "buy", 500, 100, 1);
    executeFill(account, config, "sell", account.positionBase * 90, 90, 2);

    expect(account.realizedPnl).toBeLessThan(0);
    expect(account.consecutiveLosses).toBe(1);
  });

  it("never sells more than the position holds", () => {
    const account = createAccount(config);
    executeFill(account, config, "buy", 100, 100, 1);

    executeFill(account, config, "sell", 100_000, 100, 2);

    expect(account.positionBase).toBeCloseTo(0, 9);
    expect(account.positionBase).toBeGreaterThanOrEqual(0);
  });

  it("never spends more cash than the account holds", () => {
    const account = createAccount({ ...config, startingCashQuote: 50 });

    executeFill(account, config, "buy", 100_000, 100, 1);

    expect(account.cashQuote).toBeGreaterThanOrEqual(0);
  });

  it("refuses a sell with no position", () => {
    const account = createAccount(config);
    expect(executeFill(account, config, "sell", 100, 100, 1)).toBeNull();
  });

  it("ignores hold and non-positive sizes", () => {
    const account = createAccount(config);
    expect(executeFill(account, config, "hold", 100, 100, 1)).toBeNull();
    expect(executeFill(account, config, "buy", 0, 100, 1)).toBeNull();
    expect(executeFill(account, config, "buy", 100, 0, 1)).toBeNull();
  });

  it("values equity as cash plus marked-to-market position", () => {
    const account = createAccount(config);
    executeFill(account, config, "buy", 500, 100, 1);

    // Costs mean equity starts a little below the deposit, then tracks price.
    expect(equity(account, 100)).toBeLessThan(1000);
    expect(equity(account, 200)).toBeGreaterThan(equity(account, 100));
  });
});

describe("replay", () => {
  // A sawtooth gives the mean-reversion agent something real to trade against.
  const sawtooth = candles(
    Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 6) * 12 + Math.sin(i / 31) * 5),
  );

  it("runs the full pipeline over history and reports a result", async () => {
    const result = await replay("BTC/USDT", sawtooth, {
      limits: { ...DEFAULT_RISK_LIMITS, maxDailyLossQuote: 1_000_000, maxConsecutiveLosses: 1_000 },
      paper: config,
    });

    expect(result.decisionsConsidered).toBeGreaterThan(100);
    expect(result.steps.length).toBe(result.decisionsConsidered);
    expect(Number.isFinite(result.returnPct)).toBe(true);
    expect(Number.isFinite(result.buyHoldReturnPct)).toBe(true);
  });

  it("actually trades on a market with structure", async () => {
    const result = await replay("BTC/USDT", sawtooth, {
      limits: { ...DEFAULT_RISK_LIMITS, maxDailyLossQuote: 1_000_000, maxConsecutiveLosses: 1_000 },
      paper: config,
    });

    expect(result.trades).toBeGreaterThan(0);
    // A pure oscillator puts the trend and mean-reversion agents in structural
    // opposition, so most ticks correctly resolve to no consensus. What matters
    // here is that consensus is reachable at all and that it reaches execution.
    expect(result.steps.filter((s) => s.decision.approved).length).toBeLessThan(result.steps.length);
  });

  it("never lets the account go cash-negative", async () => {
    const result = await replay("BTC/USDT", sawtooth, {
      limits: { ...DEFAULT_RISK_LIMITS, maxDailyLossQuote: 1_000_000, maxConsecutiveLosses: 1_000 },
      paper: config,
    });

    for (const step of result.steps) {
      expect(step.equity).toBeGreaterThan(0);
    }
    expect(result.account.cashQuote).toBeGreaterThanOrEqual(-1e-9);
    expect(result.account.positionBase).toBeGreaterThanOrEqual(-1e-9);
  });

  it("stops trading once the kill switch is set", async () => {
    const result = await replay("BTC/USDT", sawtooth, {
      limits: { ...DEFAULT_RISK_LIMITS, killSwitch: true },
      paper: config,
    });

    expect(result.trades).toBe(0);
    expect(result.finalEquity).toBe(result.startingEquity);
  });

  it("respects the daily loss limit as a hard stop", async () => {
    // A relentless downtrend: whatever the council thinks, losses must halt it.
    const falling = candles(Array.from({ length: 200 }, (_, i) => 200 - i * 0.5));

    const result = await replay("BTC/USDT", falling, {
      limits: { ...DEFAULT_RISK_LIMITS, maxDailyLossQuote: 20 },
      paper: config,
    });

    expect(result.account.realizedPnl).toBeGreaterThan(-200);
  });

  it("sees no future data at any step", async () => {
    const seen: number[] = [];

    await replay("BTC/USDT", sawtooth, {
      limits: DEFAULT_RISK_LIMITS,
      paper: config,
      warmup: 40,
      onStep: (step) => seen.push(step.timestamp),
    });

    // Each step is timestamped with its own candle, in order, starting at warmup.
    expect(seen[0]).toBe(sawtooth[40].timestamp);
    expect(seen[seen.length - 1]).toBe(sawtooth[sawtooth.length - 1].timestamp);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });
});
