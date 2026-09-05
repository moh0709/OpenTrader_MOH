import { describe, expect, it } from "vitest";
import { DEFAULT_HEAD_LIMITS, type HeadLimits } from "../head.js";
import type { Candle } from "../types.js";
import { aggregate, replayHead } from "./head-replay.js";
import { fixedLlmAnalyst } from "./simulator.js";

const HOUR = 3_600_000;
const START = Date.UTC(2025, 0, 1);

/**
 * A candle series from a price path.
 *
 * Highs and lows are placed a fixed fraction either side of the close, so the
 * peak the trail reads is a known function of the path rather than noise.
 */
function series(prices: number[], wick = 0.001): Candle[] {
  return prices.map((close, i) => ({
    open: i === 0 ? close : prices[i - 1],
    high: close * (1 + wick),
    low: close * (1 - wick),
    close,
    volume: 100,
    timestamp: START + i * HOUR,
  }));
}

/** Flat warmup, then a steady climb. Enough trend to vote, gentle enough not to peg RSI. */
function climb(flatBars: number, risingBars: number, perBarPct: number, base = 1000): number[] {
  const prices: number[] = [];
  for (let i = 0; i < flatBars; i++) prices.push(base + (i % 2 === 0 ? 0.5 : -0.5));

  let price = base;
  for (let i = 0; i < risingBars; i++) {
    price *= 1 + perBarPct / 100;
    prices.push(price);
  }

  return prices;
}

/** The strategist stub, so the council reliably reaches a directional verdict. */
const bullish = {
  llmAnalyst: fixedLlmAnalyst({
    agent: "llm-strategist",
    signal: "buy" as const,
    confidence: 0.9,
    rationale: "test",
    source: "llm" as const,
  }),
};

const limits: HeadLimits = {
  ...DEFAULT_HEAD_LIMITS,
  maxPositionQuote: 250,
  minConfidence: 0.3,
  // The cooldown and the minimum hold are measured in wall-clock milliseconds
  // and the replay advances an hour a bar, so they behave as they do live.
  cooldownMs: 2 * HOUR,
};

const paper = { startingCashQuote: 10_000, feeBps: 10, slippageBps: 5 };

describe("replayHead", () => {
  it("drives the real planner: opens, then closes at the take profit", async () => {
    const result = await replayHead("TEST/USDT", series(climb(40, 60, 0.35)), {
      limits,
      paper,
      council: bullish,
      warmup: 35,
    });

    expect(result.trades.length).toBeGreaterThan(0);

    const first = result.trades[0];
    expect(first.exitAction).toBe("take_profit");
    expect(first.netPnl).toBeGreaterThan(0);
    // The planner takes profit at 3% net of its own fee estimate, so the booked
    // figure lands near 3% of the ticket and cannot be a rounding artefact.
    expect(first.netPnl / first.notional).toBeGreaterThan(0.02);
  });

  it("stops out when the market turns against a filled entry", async () => {
    const up = climb(40, 20, 0.4);
    const peak = up[up.length - 1];

    // A hard slide: past the 2% stop, and past the fees on top of it.
    const down: number[] = [];
    let price = peak;
    for (let i = 0; i < 25; i++) {
      price *= 0.994;
      down.push(price);
    }

    const result = await replayHead("TEST/USDT", series([...up, ...down]), {
      limits,
      paper,
      council: bullish,
      warmup: 35,
    });

    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades.some((t) => t.exitAction === "stop_out")).toBe(true);

    const stopped = result.trades.find((t) => t.exitAction === "stop_out")!;
    expect(stopped.netPnl).toBeLessThan(0);
  });

  it("charges both fees against every round trip", async () => {
    const result = await replayHead("TEST/USDT", series(climb(40, 60, 0.35)), {
      limits,
      paper,
      council: bullish,
      warmup: 35,
    });

    for (const trade of result.trades) {
      expect(trade.entryFee).toBeGreaterThan(0);
      expect(trade.exitFee).toBeGreaterThan(0);

      // Net is gross less both fees, exactly. No hidden allowance anywhere.
      const gross = (trade.exitPrice - trade.entryPrice) * trade.quantity;
      expect(trade.netPnl).toBeCloseTo(gross - trade.entryFee - trade.exitFee, 8);
    }

    expect(result.stats.feesPaid).toBeGreaterThan(0);
  });

  it("never opens before the warmup is complete", async () => {
    const warmup = 50;
    const result = await replayHead("TEST/USDT", series(climb(55, 60, 0.35)), {
      limits,
      paper,
      council: bullish,
      warmup,
    });

    for (const trade of result.trades) {
      expect(trade.openedAt).toBeGreaterThanOrEqual(START + warmup * HOUR);
    }
  });

  it("holds everything when the kill switch is on", async () => {
    const result = await replayHead("TEST/USDT", series(climb(40, 60, 0.35)), {
      limits: { ...limits, killSwitch: true },
      paper,
      council: bullish,
      warmup: 35,
    });

    expect(result.trades).toHaveLength(0);
    expect(result.openAtEnd).toBeNull();
    expect(result.decisions).toBeGreaterThan(0);
  });

  it("reports a position still open when the data runs out", async () => {
    // Rises enough to open, then goes flat so nothing closes it.
    const prices = [...climb(40, 12, 0.4)];
    const last = prices[prices.length - 1];
    for (let i = 0; i < 10; i++) prices.push(last);

    const result = await replayHead("TEST/USDT", series(prices), {
      limits,
      paper,
      council: bullish,
      warmup: 35,
    });

    if (result.openAtEnd) {
      expect(result.openAtEnd.quantity).toBeGreaterThan(0);
      // An unclosed position is not a trade. Counting it as one is how a
      // backtest reports a win it never took.
      expect(result.trades.every((t) => t.closedAt > 0)).toBe(true);
    }
  });

  it("counts winners against the profit floor", async () => {
    const result = await replayHead("TEST/USDT", series(climb(40, 60, 0.35)), {
      limits,
      paper,
      council: bullish,
      warmup: 35,
      profitFloorQuote: 3,
    });

    const { stats } = result;
    expect(stats.winsUnderFloor + stats.winsAtOrOverFloor).toBe(stats.wins);

    const winners = result.trades.filter((t) => t.netPnl > 0);
    expect(stats.winsAtOrOverFloor).toBe(winners.filter((t) => t.netPnl >= 3).length);
  });

  it("summarises a mixed run correctly", async () => {
    const stats = aggregate(
      [
        {
          symbol: "A",
          candles: 0,
          decisions: 0,
          openAtEnd: null,
          buyHoldReturnPct: 0,
          stats: {} as never,
          trades: [
            { netPnl: 10, closedAt: 3, exitAction: "take_profit", entryFee: 1, exitFee: 1 },
            { netPnl: -4, closedAt: 1, exitAction: "stop_out", entryFee: 1, exitFee: 1 },
            { netPnl: 2, closedAt: 2, exitAction: "trail_exit", entryFee: 1, exitFee: 1 },
          ] as never,
        },
      ],
      3,
    );

    expect(stats.trades).toBe(3);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.netPnl).toBe(8);
    expect(stats.grossProfit).toBe(12);
    expect(stats.grossLoss).toBe(4);
    expect(stats.profitFactor).toBe(3);
    expect(stats.expectancy).toBeCloseTo(8 / 3, 10);
    expect(stats.feesPaid).toBe(6);

    // The $2 trail win is a win that did not clear the floor. That distinction
    // is the whole point of the metric.
    expect(stats.winsUnderFloor).toBe(1);
    expect(stats.winsAtOrOverFloor).toBe(1);

    expect(stats.byExit.take_profit).toEqual({ count: 1, netPnl: 10 });
    expect(stats.byExit.stop_out).toEqual({ count: 1, netPnl: -4 });

    // Sorted by close time: -4 then +2 then +10, so the trough is 4 below the start.
    expect(stats.maxDrawdown).toBe(4);
  });

  it("reports an undefined profit factor as zero, not infinity", () => {
    const noTrades = aggregate([], 3);
    expect(noTrades.profitFactor).toBe(0);
    expect(noTrades.expectancy).toBe(0);
    expect(noTrades.winRate).toBe(0);
  });
});
