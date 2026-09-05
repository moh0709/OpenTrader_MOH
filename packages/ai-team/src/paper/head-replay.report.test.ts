import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_HEAD_LIMITS, type HeadLimits } from "../head.js";
import type { AgentOpinion, Candle, MarketSnapshot } from "../types.js";
import {
  aggregate,
  replayHead,
  type HeadReplayOptions,
  type HeadReplayResult,
  type HeadReplayStats,
  type HeadTrade,
} from "./head-replay.js";

/**
 * The head's expectancy, measured on real candles.
 *
 * Opt in with `HEAD_REPLAY=1` and point `HEAD_REPLAY_DATA` at a directory of
 * candle files — `SYMBOL-BASE-tf.json`, each an array of
 * `{timestamp, open, high, low, close, volume}`. It reads no network and places
 * no orders; it is a measuring instrument, not a trading path, and it is out of
 * the default suite because it needs data the repository does not carry.
 *
 * Every scenario below runs against the identical candles, so the only thing
 * that differs between two rows is the policy. That is what makes the
 * comparison worth anything: the market is held constant and the settings are
 * not.
 *
 * Three questions, in the order they have to be answered before anything is
 * armed:
 *
 *   1. Does it make money after costs?          — the scenario table
 *   2. Does it make money in each regime?        — the per-year and half split
 *   3. Does the *signal* make money, or do the
 *      exit rules just harvest the drift?        — the coin-flip null model
 *
 * A system that passes 1 and fails 3 is beta with a stop loss. That is not
 * worthless, but it is not what an autonomous head is for, and it is exactly
 * what a long-only trend rule looks like over a decade in which the underlying
 * went up six-fold.
 *
 * One honest limitation, stated because it moves the numbers: the replay has no
 * outside technical read, no sentiment index and no research conviction, so the
 * council votes with two of its seven seats. Production has a third, the
 * research council, through the local mirror. That makes these confidence
 * figures — and therefore the ticket sizes — a floor rather than a forecast.
 */

const RUN = process.env.HEAD_REPLAY === "1";
const DATA = process.env.HEAD_REPLAY_DATA ?? "";
const FLOOR = Number(process.env.HEAD_REPLAY_FLOOR) || 3;
/** Bar size the candle files hold, so hold and cooldown windows can be scaled to it. */
const BAR_MS = Number(process.env.HEAD_REPLAY_BAR_MS) || 3_600_000;
/** How many coin-flip runs the null model draws. Slow on hourly data; fine on daily. */
const NULL_RUNS = Number(process.env.HEAD_REPLAY_NULL_RUNS) || 0;

/** Costs charged on both sides. 10 bps taker, 5 bps adverse slippage. */
const PAPER = { startingCashQuote: 10_000, feeBps: 10, slippageBps: 5 };

const DAY = 86_400_000;

/** Production risk envelope, held constant so only the rules under test vary. */
const ENVELOPE = {
  equityQuote: 10_000,
  maxTotalExposureQuote: 1000,
  maxOpenPositions: 4,
  maxDailyOpenNotionalQuote: 2000,
  maxDailyLossQuote: 300,
} satisfies Partial<HeadLimits>;

/**
 * Hold and cooldown windows scaled to the bar.
 *
 * The shipped values are minutes, sized for an hourly loop. On daily bars a
 * 15-minute minimum hold and a 10-minute cooldown are no constraint at all, and
 * the five-day dead-money rule would close most positions before they had a
 * chance to work. One bar of each, and a hold cap the Int32 column can store.
 */
const WINDOWS =
  BAR_MS >= DAY
    ? { minHoldMs: BAR_MS, cooldownMs: BAR_MS, maxHoldMs: 23 * DAY }
    : { minHoldMs: DEFAULT_HEAD_LIMITS.minHoldMs, cooldownMs: DEFAULT_HEAD_LIMITS.cooldownMs, maxHoldMs: DEFAULT_HEAD_LIMITS.maxHoldMs };

type Scenario = { name: string; note: string; limits: HeadLimits; entry?: HeadReplayOptions["entry"] };

const SCENARIOS: Scenario[] = [
  {
    name: "db-defaults (before)",
    note: "what a fresh db push seeded before the floor",
    limits: {
      ...DEFAULT_HEAD_LIMITS,
      ...ENVELOPE,
      ...WINDOWS,
      maxPositionQuote: 100,
      minConfidence: 0.45,
      minNetProfitQuote: 0,
      takeProfitPercent: 1.5,
      stopLossPercent: 2.5,
      trailStartPercent: 1.0,
      trailGivebackPercent: 0.5,
    },
  },
  {
    name: "production (audited)",
    note: "vps2 as audited: cap 250, 3.0/2.0, entry bar 0.28, no floor",
    limits: { ...DEFAULT_HEAD_LIMITS, ...ENVELOPE, ...WINDOWS, maxPositionQuote: 250, minConfidence: 0.28, minNetProfitQuote: 0 },
  },
  {
    name: "production + $3 floor",
    note: "the same policy with minNetProfitQuote = 3",
    limits: { ...DEFAULT_HEAD_LIMITS, ...ENVELOPE, ...WINDOWS, maxPositionQuote: 250, minConfidence: 0.28, minNetProfitQuote: 3 },
  },
  {
    name: "floor + maker entries",
    note: "resting entries at the decision price, maker fee 8 bps",
    limits: { ...DEFAULT_HEAD_LIMITS, ...ENVELOPE, ...WINDOWS, maxPositionQuote: 250, minConfidence: 0.28, minNetProfitQuote: 3 },
    entry: { fill: "maker", makerFeeBps: 8 },
  },
  {
    name: "floor, thresholds x5",
    note: "15/10/10/4 — the hourly thresholds scaled to a daily bar's range",
    limits: {
      ...DEFAULT_HEAD_LIMITS,
      ...ENVELOPE,
      ...WINDOWS,
      maxPositionQuote: 250,
      minConfidence: 0.28,
      minNetProfitQuote: 3,
      takeProfitPercent: 15,
      stopLossPercent: 10,
      trailStartPercent: 10,
      trailGivebackPercent: 4,
    },
  },
];

/** The scenario the null model is drawn against: the last one listed. */
const NULL_SCENARIO = SCENARIOS[SCENARIOS.length - 1];

function loadCandles(dir: string): Map<string, Candle[]> {
  const out = new Map<string, Candle[]>();

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as Candle[];
    if (!Array.isArray(raw) || raw.length === 0) continue;

    const symbol = file.replace(/-\w+\.json$/, "").replace("-", "/");
    out.set(symbol, raw);
  }

  return out;
}

async function runScenario(markets: Map<string, Candle[]>, scenario: Scenario, council?: HeadReplayOptions["council"]) {
  const results: HeadReplayResult[] = [];

  for (const [symbol, candles] of markets) {
    results.push(
      await replayHead(symbol, candles, {
        limits: scenario.limits,
        paper: PAPER,
        warmup: 60,
        profitFloorQuote: FLOOR,
        entry: scenario.entry,
        council,
      }),
    );
  }

  return results;
}

function money(n: number, width = 9): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2).padStart(width - 1);
}

function reportRow(label: string, s: HeadReplayStats): string {
  const pf = s.profitFactor === Number.POSITIVE_INFINITY ? "  inf" : s.profitFactor.toFixed(2).padStart(5);

  return (
    `${label.padEnd(26)} ${String(s.trades).padStart(5)} ${(s.winRate * 100).toFixed(0).padStart(4)}% ` +
    `${money(s.netPnl, 11)} ${money(s.expectancy, 9)} ${s.avgWin.toFixed(2).padStart(8)} ` +
    `${s.avgLoss.toFixed(2).padStart(8)} ${pf} ${String(s.winsUnderFloor).padStart(6)} ${String(s.winsAtOrOverFloor).padStart(6)}`
  );
}

const HEADER =
  `${"scenario".padEnd(26)} ${"trades".padStart(5)} ${"win%".padStart(5)} ${"net".padStart(10)} ` +
  `${"per-trade".padStart(9)} ${"avg win".padStart(8)} ${"avg loss".padStart(8)} ${"   PF"} ` +
  `${`<$${FLOOR}`.padStart(6)} ${`>=$${FLOOR}`.padStart(6)}`;

/** Student's t on per-trade P&L against zero. Rough, and honest about being rough. */
function tStat(trades: HeadTrade[]): number {
  const n = trades.length;
  if (n < 2) return 0;

  const mean = trades.reduce((a, t) => a + t.netPnl, 0) / n;
  const variance = trades.reduce((a, t) => a + (t.netPnl - mean) ** 2, 0) / (n - 1);

  return variance > 0 ? mean / Math.sqrt(variance / n) : 0;
}

/**
 * The same result cut by calendar year and by half.
 *
 * A strategy with no fitted parameters can be bucketed after a single run —
 * there is no training set to leak. What the cut shows is whether the total
 * came from everywhere or from one year, and whether the second half of the
 * data would have been forecast by the first.
 */
function breakdown(trades: HeadTrade[]): void {
  const years = [...new Set(trades.map((t) => new Date(t.closedAt).getUTCFullYear()))].sort();
  if (years.length < 2) return;

  const cell = (label: string, subset: HeadTrade[]) => {
    const s = aggregate([{ trades: subset } as HeadReplayResult], FLOOR);
    const pf = s.profitFactor === Number.POSITIVE_INFINITY ? " inf" : s.profitFactor.toFixed(2).padStart(4);

    return `${label} ${String(s.trades).padStart(3)}t ${money(s.netPnl, 8)} pf${pf}`;
  };

  console.log(`  by year:  ${years.map((y) => cell(String(y), trades.filter((t) => new Date(t.closedAt).getUTCFullYear() === y))).join("  |  ")}`);

  const mid = trades[Math.floor(trades.length / 2)].closedAt;
  console.log(
    `  halves:   ${cell("first", trades.filter((t) => t.closedAt < mid))}  |  ${cell("second", trades.filter((t) => t.closedAt >= mid))}` +
      `   t-stat ${tStat(trades).toFixed(2)}`,
  );
}

// --- the null model ----------------------------------------------------------

/** Every real seat weighted to nothing, so only the coin is at the table. */
const COIN_ONLY = {
  "market-analyst": 0,
  "quant-analyst": 0,
  "arbitrage-scout": 0,
  "technical-analyst": 0,
  "research-council": 0,
  "sentiment-analyst": 0,
  "llm-strategist": 1,
};

/** mulberry32. Seedable, so a percentile is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A council of one coin: buy with probability p, sell with probability p, else hold. */
function coin(seed: number, p: number) {
  const next = rng(seed);

  return async (_snapshot: MarketSnapshot): Promise<AgentOpinion> => {
    const r = next();
    const signal = r < p ? "buy" : r < 2 * p ? "sell" : "hold";

    return { agent: "llm-strategist", signal, confidence: signal === "hold" ? 0 : 0.5, rationale: "coin", source: "llm" };
  };
}

describe.runIf(RUN && DATA)("trading head — expectancy on real candles", () => {
  it(
    "replays every scenario over the same history and reports what each would have made",
    async () => {
      const markets = loadCandles(DATA);
      expect(markets.size).toBeGreaterThan(0);

      const span = [...markets.values()][0];
      console.log(`\n${"=".repeat(108)}`);
      console.log(`TRADING HEAD — HISTORICAL EXPECTANCY`);
      console.log(
        `${markets.size} markets, ${span.length} bars each, ` +
          `${new Date(span[0].timestamp).toISOString().slice(0, 10)} to ${new Date(span[span.length - 1].timestamp).toISOString().slice(0, 10)}`,
      );
      console.log(`costs: ${PAPER.feeBps}bps fee + ${PAPER.slippageBps}bps slippage per side | profit floor $${FLOOR} | bar ${BAR_MS / 3_600_000}h`);
      console.log(`${"=".repeat(108)}\n${HEADER}\n${"-".repeat(108)}`);

      const summaries = new Map<string, HeadReplayStats>();

      for (const scenario of SCENARIOS) {
        const results = await runScenario(markets, scenario);
        const stats = aggregate(results, FLOOR);
        summaries.set(scenario.name, stats);
        console.log(reportRow(scenario.name, stats));

        for (const result of results) {
          if (result.stats.trades === 0) continue;
          console.log(`  ${reportRow(`  ${result.symbol}`, result.stats).trimEnd()}`);
        }

        const planned = results.reduce((n, r) => n + r.entriesPlanned, 0);
        const filled = results.reduce((n, r) => n + r.entriesFilled, 0);
        const exits = Object.entries(stats.byExit)
          .sort((a, b) => b[1].count - a[1].count)
          .map(([action, v]) => `${action} ${v.count} (${money(v.netPnl, 7).trim()})`)
          .join(", ");
        console.log(
          `  exits: ${exits || "none"}   max drawdown ${stats.maxDrawdown.toFixed(2)}` +
            (planned > 0 ? `   fills ${filled}/${planned} (${((filled / planned) * 100).toFixed(0)}%)` : ""),
        );

        breakdown(results.flatMap((r) => r.trades).sort((a, b) => a.closedAt - b.closedAt));
        console.log();
      }

      console.log(`${"=".repeat(108)}\n`);

      // The report is the deliverable, but a run that produced no decision at
      // all is a broken harness rather than a quiet market, and must fail.
      expect([...summaries.values()].some((s) => s.trades > 0)).toBe(true);
    },
    { timeout: 1_800_000 },
  );

  it.runIf(NULL_RUNS > 0)(
    "places the last scenario inside the distribution of coin-flip entries",
    async () => {
      const markets = loadCandles(DATA);
      const real = aggregate(await runScenario(markets, NULL_SCENARIO), FLOOR);

      console.log(`\nNULL MODEL against "${NULL_SCENARIO.name}": ${real.trades} trades, net ${money(real.netPnl).trim()}, PF ${real.profitFactor.toFixed(2)}`);

      // Calibrate p so the coin trades about as often as the real system and
      // pays about the same in costs. A coin that trades more pays more and
      // makes the real signal look better than it is.
      let p = 0.05;
      let closest = Number.POSITIVE_INFINITY;
      for (const candidate of [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.15]) {
        const probe = aggregate(await runScenario(markets, NULL_SCENARIO, { weights: COIN_ONLY, llmAnalyst: coin(1, candidate) }), FLOOR);
        const gap = Math.abs(probe.trades - real.trades);
        if (gap < closest) {
          closest = gap;
          p = candidate;
        }
      }

      const nets: number[] = [];
      let tradeSum = 0;
      for (let seed = 1; seed <= NULL_RUNS; seed++) {
        const s = aggregate(await runScenario(markets, NULL_SCENARIO, { weights: COIN_ONLY, llmAnalyst: coin(seed * 7919, p) }), FLOOR);
        nets.push(s.netPnl);
        tradeSum += s.trades;
      }
      nets.sort((a, b) => a - b);

      const q = (f: number) => nets[Math.min(nets.length - 1, Math.floor(f * nets.length))];
      const beaten = nets.filter((n) => n < real.netPnl).length;
      const profitable = nets.filter((n) => n > 0).length;

      console.log(`coin x${NULL_RUNS} at p=${p}, avg ${(tradeSum / NULL_RUNS).toFixed(0)} trades`);
      console.log(`  net  p05 ${money(q(0.05), 8)}  p25 ${money(q(0.25), 8)}  median ${money(q(0.5), 8)}  p75 ${money(q(0.75), 8)}  p95 ${money(q(0.95), 8)}`);
      console.log(`  coins profitable: ${profitable}/${NULL_RUNS}   real signal beats ${beaten}/${NULL_RUNS}  ->  percentile ${Math.round((beaten / NULL_RUNS) * 100)}`);
      console.log(
        `  read: ${
          beaten / NULL_RUNS >= 0.95
            ? "the signal adds something the exits alone do not"
            : profitable / NULL_RUNS >= 0.8
              ? "the exits harvest the drift; the signal is not distinguishable from a coin"
              : "neither the signal nor the drift is carrying this"
        }\n`,
      );

      expect(nets.length).toBe(NULL_RUNS);
    },
    { timeout: 3_600_000 },
  );
});
