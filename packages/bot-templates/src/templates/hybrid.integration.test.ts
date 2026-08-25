import { aiActivity } from "@opentrader/ai-team";
import { StrategyRunner, type IBotControl } from "@opentrader/bot-processor";
import type { IExchange } from "@opentrader/exchanges";
import type { ICandlestick, MarketData, MarketId } from "@opentrader/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hybrid } from "./hybrid.js";

/**
 * End-to-end integration: the hybrid strategy driven by the real StrategyRunner.
 *
 * This exercises the parts this strategy actually owns — the generator protocol
 * (including the promise-yield path the council depends on), the effects it
 * emits, and its state handling. The smart-trade machinery behind the effects is
 * OpenTrader's own and is mocked at the IBotControl boundary.
 */

function candle(close: number, i: number): ICandlestick {
  return {
    open: close,
    high: close * 1.004,
    low: close * 0.996,
    close,
    volume: 10,
    timestamp: 1_700_000_000_000 + i * 3_600_000,
  } as ICandlestick;
}

/**
 * A gentle uptrend with regular pullbacks.
 *
 * The drift is deliberately slow relative to the pullbacks: the moving averages
 * separate enough for the trend agent to commit, while gains and losses stay
 * balanced enough to keep RSI mid-range so the mean-reversion agent abstains
 * rather than opposing. A steeper ramp drives RSI overbought, the two agents
 * cancel, and the council correctly declines to trade — which is right
 * behaviour, but tests nothing downstream of the vote.
 */
function risingCandles(count = 80): ICandlestick[] {
  return Array.from({ length: count }, (_, i) => candle(100 + i * 0.25 + Math.sin((i * Math.PI) / 2) * 1.1, i));
}

function flatCandles(count = 80): ICandlestick[] {
  return Array.from({ length: count }, (_, i) => candle(100, i));
}

function orderbook(bid: number, ask: number, symbol: string) {
  return {
    symbol,
    timestamp: Date.now(),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: bid - i * 0.5, quantity: 5 })),
    asks: Array.from({ length: 10 }, (_, i) => ({ price: ask + i * 0.5, quantity: 5 })),
  };
}

type ControlMock = IBotControl & { __calls: string[] };

/**
 * @param openPosition when set, `getSmartTrade` reports a filled entry with no
 * exit working — the state a force-liquidation has to act on.
 */
function createControl(openPosition = false): ControlMock {
  const calls: string[] = [];
  const trade = {
    ref: "hybrid",
    entryOrder: { status: "Idle", side: "Buy", type: "Market", quantity: 1 },
    tpOrder: null,
  };
  const filledTrade = {
    ref: "hybrid",
    entryOrder: { status: "Filled", side: "Buy", type: "Market", quantity: 1 },
    tpOrder: null,
  };

  return {
    __calls: calls,
    stop: vi.fn(async () => {
      calls.push("stop");
    }),
    getSmartTrade: vi.fn(async () => {
      calls.push("getSmartTrade");
      return openPosition ? (filledTrade as never) : null;
    }),
    updateSmartTrade: vi.fn(async () => {
      calls.push("updateSmartTrade");
      return filledTrade as never;
    }),
    createSmartTrade: vi.fn(async () => {
      calls.push("createSmartTrade");
      return trade as never;
    }),
    getOrCreateSmartTrade: vi.fn(async () => {
      calls.push("getOrCreateSmartTrade");
      return trade as never;
    }),
    replaceSmartTrade: vi.fn(async () => trade as never),
    cancelSmartTrade: vi.fn(async () => {
      calls.push("cancelSmartTrade");
      return true;
    }),
    getOpenTrades: vi.fn(async () => []),
    getExchange: vi.fn(async () => null),
  } as unknown as ControlMock;
}

const SYMBOL = "BTC/USDT";

const botConfig = {
  id: 1,
  symbol: SYMBOL,
  timeframe: "1h",
  settings: hybrid.schema.parse({}),
};

function makeRunner(control: IBotControl) {
  const exchange = {} as IExchange;
  return new StrategyRunner(control, botConfig as never, exchange, [], hybrid as never);
}

function marketData(candles: ICandlestick[]): MarketData {
  return { candles, candle: candles[candles.length - 1] };
}

function marketsWithBooks(): Record<MarketId, MarketData> {
  return {
    [`BINANCE:${SYMBOL}` as MarketId]: { candles: [], orderbook: orderbook(100.0, 100.1, SYMBOL) },
    [`OKX:${SYMBOL}` as MarketId]: { candles: [], orderbook: orderbook(100.2, 100.3, SYMBOL) },
  };
}

describe("hybrid strategy — StrategyRunner integration", () => {
  let control: ControlMock;

  beforeEach(() => {
    control = createControl();
  });

  it("runs the start command without touching the exchange", async () => {
    const runner = makeRunner(control);

    await expect(runner.start({})).resolves.toBeUndefined();
    expect(control.__calls).toEqual([]);
  });

  it("cancels its open trade on stop", async () => {
    const runner = makeRunner(control);

    await runner.stop({});

    expect(control.__calls).toContain("cancelSmartTrade");
  });

  it("holds during warm-up instead of trading on thin history", async () => {
    const runner = makeRunner(control);
    const state = {};

    await runner.process(state, "onCandleClosed", marketData(risingCandles(10)), {});

    expect(control.__calls).toEqual([]);
  });

  // The load-bearing case: a full tick that reaches a real buy effect. This is
  // the path that proves the promise-yield (the async council) survives the
  // runner's generator loop.
  it("completes a full tick and emits a buy effect on a confirmed uptrend", async () => {
    const runner = makeRunner(control);
    const state: Record<string, unknown> = {};

    await runner.process(state, "onCandleClosed", marketData(risingCandles()), marketsWithBooks());

    expect(control.__calls).toContain("getOrCreateSmartTrade");

    const [, payload] = (control.getOrCreateSmartTrade as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.type).toBe("Trade");
    expect(payload.entry.side).toBe("Buy");
    expect(payload.entry.type).toBe("Market");
    expect(payload.entry.quantity).toBeGreaterThan(0);
    expect(Number.isFinite(payload.entry.quantity)).toBe(true);
  });

  it("records exposure in bot state after entering", async () => {
    const runner = makeRunner(control);
    const state: Record<string, unknown> = {};

    await runner.process(state, "onCandleClosed", marketData(risingCandles()), marketsWithBooks());

    expect(state.openExposureQuote).toBeGreaterThan(0);
    expect(state.day).toBeTypeOf("string");
  });

  it("does not re-enter on the next tick while already positioned", async () => {
    const runner = makeRunner(control);
    const state: Record<string, unknown> = {};

    await runner.process(state, "onCandleClosed", marketData(risingCandles()), marketsWithBooks());
    const afterFirst = control.__calls.filter((c: string) => c === "getOrCreateSmartTrade").length;

    await runner.process(state, "onCandleClosed", marketData(risingCandles()), marketsWithBooks());
    const afterSecond = control.__calls.filter((c: string) => c === "getOrCreateSmartTrade").length;

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
  });

  it("stays flat in a directionless market", async () => {
    const runner = makeRunner(control);

    await runner.process({}, "onCandleClosed", marketData(flatCandles()), marketsWithBooks());

    expect(control.__calls).toEqual([]);
  });

  it("blocks every trade while the kill switch is set", async () => {
    const killed = {
      ...botConfig,
      settings: hybrid.schema.parse({ killSwitch: true }),
    };
    const runner = new StrategyRunner(control, killed as never, {} as IExchange, [], hybrid as never);

    await runner.process({}, "onCandleClosed", marketData(risingCandles()), marketsWithBooks());

    expect(control.__calls).toEqual([]);
  });

  describe("auto-liquidation on a tripped loss limit", () => {
    // A bot that is 80 quote long and has already lost its daily budget.
    const breached = () => ({
      day: new Date().toISOString().slice(0, 10),
      openExposureQuote: 80,
      realizedPnlToday: -999,
      consecutiveLosses: 0,
    });

    it("places a market exit for the open position", async () => {
      const positioned = createControl(true);
      const runner = makeRunner(positioned);

      await runner.process(breached(), "onCandleClosed", marketData(risingCandles()), marketsWithBooks());

      expect(positioned.__calls).toContain("updateSmartTrade");

      const [, payload] = (positioned.updateSmartTrade as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(payload.tp.side).toBe("Sell");
      expect(payload.tp.type).toBe("Market");
      expect(payload.tp.quantity).toBeGreaterThan(0);
    });

    it("clears tracked exposure so it does not try to exit twice", async () => {
      const positioned = createControl(true);
      const runner = makeRunner(positioned);
      const state = breached();

      await runner.process(state, "onCandleClosed", marketData(risingCandles()), marketsWithBooks());

      expect(state.openExposureQuote).toBe(0);
    });

    it("does not buy on the same tick it liquidates", async () => {
      const positioned = createControl(true);
      const runner = makeRunner(positioned);

      await runner.process(breached(), "onCandleClosed", marketData(risingCandles()), marketsWithBooks());

      expect(positioned.__calls).not.toContain("getOrCreateSmartTrade");
    });

    it("does nothing when the limit trips but the bot is already flat", async () => {
      const flat = createControl(true);
      const runner = makeRunner(flat);

      await runner.process(
        { ...breached(), openExposureQuote: 0 },
        "onCandleClosed",
        marketData(risingCandles()),
        marketsWithBooks(),
      );

      expect(flat.__calls).not.toContain("updateSmartTrade");
    });

    it("leaves positions alone when liquidateOnBreach is turned off", async () => {
      const positioned = createControl(true);
      const blockOnly = {
        ...botConfig,
        settings: hybrid.schema.parse({ liquidateOnBreach: false }),
      };
      const runner = new StrategyRunner(positioned, blockOnly as never, {} as IExchange, [], hybrid as never);

      await runner.process(breached(), "onCandleClosed", marketData(risingCandles()), marketsWithBooks());

      expect(positioned.__calls).not.toContain("updateSmartTrade");
    });

    it("does not liquidate on the kill switch, which only pauses", async () => {
      const positioned = createControl(true);
      const killed = { ...botConfig, settings: hybrid.schema.parse({ killSwitch: true }) };
      const runner = new StrategyRunner(positioned, killed as never, {} as IExchange, [], hybrid as never);

      await runner.process(breached(), "onCandleClosed", marketData(risingCandles()), marketsWithBooks());

      expect(positioned.__calls).not.toContain("updateSmartTrade");
    });
  });

  it("runs without any order books present", async () => {
    const runner = makeRunner(control);

    await expect(runner.process({}, "onCandleClosed", marketData(risingCandles()), {})).resolves.toBeUndefined();
  });

  it("tolerates a market entry with a missing order book", async () => {
    const runner = makeRunner(control);
    const markets = {
      [`BINANCE:${SYMBOL}` as MarketId]: { candles: [] } as MarketData,
      [`OKX:${SYMBOL}` as MarketId]: { candles: [], orderbook: orderbook(100.2, 100.3, SYMBOL) },
    };

    await expect(runner.process({}, "onCandleClosed", marketData(risingCandles()), markets)).resolves.toBeUndefined();
  });

  /**
   * What the dashboard's AI action feed is fed.
   *
   * The feed is only useful if it reads like news, so the flood-control claim is
   * worth pinning down: a council that has been saying the same thing for hours
   * must write one entry, not one per candle.
   */
  describe("AI action feed", () => {
    beforeEach(() => aiActivity.clear());

    it("records the order it placed, against the bot and symbol that placed it", async () => {
      const runner = makeRunner(control);

      await runner.process({}, "onCandleClosed", marketData(risingCandles()), marketsWithBooks());

      const opened = aiActivity.since(0).find((entry) => entry.chip === "open");

      expect(opened).toBeDefined();
      expect(opened!.botId).toBe(botConfig.id);
      expect(opened!.symbol).toBe(SYMBOL);
      // The dashboard points at a row using this.
      expect(opened!.target).toEqual({ botId: botConfig.id });
    });

    it("records the council's view when it changes", async () => {
      const runner = makeRunner(control);

      await runner.process({}, "onCandleClosed", marketData(risingCandles()), marketsWithBooks());

      expect(aiActivity.since(0).some((entry) => entry.chip === "analysis")).toBe(true);
    });

    it("does not restate an unchanged council view on every candle", async () => {
      const runner = makeRunner(control);
      const state: Record<string, unknown> = {};

      for (let tick = 0; tick < 5; tick += 1) {
        await runner.process(state, "onCandleClosed", marketData(flatCandles()), marketsWithBooks());
      }

      const analyses = aiActivity.since(0).filter((entry) => entry.chip === "analysis");

      expect(analyses).toHaveLength(1);
    });

    it("keeps every entry short enough to read in a bubble", async () => {
      const runner = makeRunner(control);

      await runner.process({}, "onCandleClosed", marketData(risingCandles()), marketsWithBooks());

      for (const entry of aiActivity.since(0)) {
        expect(entry.title.length).toBeLessThanOrEqual(48);
        expect(entry.detail.length).toBeLessThanOrEqual(140);
      }
    });
  });
});
