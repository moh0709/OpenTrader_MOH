/**
 * The venue-prices widget's refresh discipline.
 *
 * This widget used to re-request on every dashboard snapshot — five seconds —
 * while a single cross-venue scan takes around ten. Each tick therefore started
 * another sweep before the last finished, and the page appeared to hang. The
 * widget now keeps its own, slower cadence and cancels what it supersedes.
 *
 * Tested in node against a fake `query` rather than in a browser: what is being
 * asserted is request *discipline*, not layout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryCalls = [];
let abortSignals = [];

vi.mock("../lib/api.js", () => ({
  query: (path, input, options) => {
    queryCalls.push({ path, input, signal: options?.signal });
    if (options?.signal) abortSignals.push(options.signal);

    return Promise.resolve({
      symbol: input.symbol,
      venuesQuoted: [
        { venue: "BINANCE", bid: 100, ask: 100.5, bidLevels: 10, askLevels: 10 },
        { venue: "BYBIT", bid: 100.2, ask: 100.7, bidLevels: 5, askLevels: 5 },
      ],
      venuesFailed: [],
      evaluations: [],
      summary: { pairsEvaluated: 1, overstatedByTopOfBook: 0, executable: 0 },
    });
  },
}));

/** Minimal stand-ins for the DOM helpers the widget uses to draw. */
vi.mock("../lib/dom.js", () => ({
  el: (tag, attrs = {}) => ({ tag, ...attrs, children: [] }),
  mount: () => {},
  emptyState: (message) => ({ tag: "p", text: message }),
  note: (text) => ({ tag: "p", text }),
  select: () => ({ tag: "select" }),
}));

const { arbitrageVenuesWidget } = await import("./arbitrage.js");

/**
 * These tests run in node, where there is no `window`. The widget only needs
 * `setInterval`/`clearInterval`, which fake timers provide through the global
 * `setInterval` — so a minimal stand-in is enough and stays in step with them.
 */
globalThis.window ??= {
  setInterval: (...args) => setInterval(...args),
  clearInterval: (...args) => clearInterval(...args),
};

function makeCtx(config = {}) {
  return {
    body: {},
    config: { symbol: "BTC/USDT", ...config },
    setConfig: () => {},
    store: { subscribe: () => () => {} },
  };
}

describe("arbitrageVenues refresh", () => {
  beforeEach(() => {
    queryCalls.length = 0;
    abortSignals = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches once on mount, not once per snapshot", async () => {
    arbitrageVenuesWidget.render(makeCtx());

    expect(queryCalls).toHaveLength(1);
  });

  it("does not fetch again on the dashboard's five-second tick", async () => {
    arbitrageVenuesWidget.render(makeCtx());
    const initial = queryCalls.length;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(queryCalls).toHaveLength(initial);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(queryCalls).toHaveLength(initial);
  });

  it("refreshes on its own slower cadence", async () => {
    arbitrageVenuesWidget.render(makeCtx());
    const initial = queryCalls.length;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(queryCalls.length).toBeGreaterThan(initial);
  });

  it("passes an abort signal so a superseded scan can be cancelled", async () => {
    arbitrageVenuesWidget.render(makeCtx());

    expect(abortSignals).toHaveLength(1);
    expect(abortSignals[0]).toBeInstanceOf(AbortController === undefined ? Object : AbortSignal);
  });

  it("stops refreshing once disposed", async () => {
    const { dispose } = arbitrageVenuesWidget.render(makeCtx());
    const initial = queryCalls.length;

    dispose();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(queryCalls).toHaveLength(initial);
  });

  it("aborts an in-flight request on dispose", async () => {
    const { dispose } = arbitrageVenuesWidget.render(makeCtx());
    const signal = abortSignals[0];

    expect(signal.aborted).toBe(false);
    dispose();
    expect(signal.aborted).toBe(true);
  });
});
