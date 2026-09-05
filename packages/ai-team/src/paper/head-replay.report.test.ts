import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_HEAD_LIMITS, type HeadLimits } from "../head.js";
import type { Candle } from "../types.js";
import { aggregate, replayHead, type HeadReplayResult, type HeadReplayStats } from "./head-replay.js";

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
 * One honest limitation, stated because it moves the numbers: the replay has no
 * outside technical read, no sentiment index and no research conviction, so the
 * council votes with two of its seven seats. Production has a third, the
 * research council, through the local mirror. That makes these confidence
 * figures — and therefore the ticket sizes — a floor rather than a forecast.
 */

const RUN = process.env.HEAD_REPLAY === "1";
const DATA = process.env.HEAD_REPLAY_DATA ?? "";
const FLOOR = Number(process.env.HEAD_REPLAY_FLOOR) || 3;

/** Costs charged on both sides. 10 bps taker, 5 bps adverse slippage. */
const PAPER = { startingCashQuote: 10_000, feeBps: 10, slippageBps: 5 };

/** Production risk envelope, held constant so only the rules under test vary. */
const ENVELOPE = {
  equityQuote: 10_000,
  maxTotalExposureQuote: 1000,
  maxOpenPositions: 4,
  maxDailyOpenNotionalQuote: 2000,
  maxDailyLossQuote: 300,
} satisfies Partial<HeadLimits>;

type Scenario = { name: string; note: string; limits: HeadLimits };

const SCENARIOS: Scenario[] = [
  {
    name: "db-defaults (before)",
    note: "what a fresh db push seeded before this change",
    limits: {
      ...DEFAULT_HEAD_LIMITS,
      ...ENVELOPE,
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
    limits: {
      ...DEFAULT_HEAD_LIMITS,
      ...ENVELOPE,
      maxPositionQuote: 250,
      minConfidence: 0.28,
      minNetProfitQuote: 0,
    },
  },
  {
    name: "production + $3 floor",
    note: "the same policy with minNetProfitQuote = 3",
    limits: {
      ...DEFAULT_HEAD_LIMITS,
      ...ENVELOPE,
      maxPositionQuote: 250,
      minConfidence: 0.28,
      minNetProfitQuote: 3,
    },
  },
  {
    name: "shipped defaults + floor",
    note: "what a fresh install now seeds, at the shipped cap",
    limits: { ...DEFAULT_HEAD_LIMITS, ...ENVELOPE, maxPositionQuote: 100 },
  },
];

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
      console.log(`costs: ${PAPER.feeBps}bps fee + ${PAPER.slippageBps}bps slippage per side | profit floor $${FLOOR}`);
      console.log(`${"=".repeat(108)}\n${HEADER}\n${"-".repeat(108)}`);

      const summaries = new Map<string, HeadReplayStats>();

      for (const scenario of SCENARIOS) {
        const results: HeadReplayResult[] = [];

        for (const [symbol, candles] of markets) {
          results.push(
            await replayHead(symbol, candles, {
              limits: scenario.limits,
              paper: PAPER,
              warmup: 60,
              profitFloorQuote: FLOOR,
            }),
          );
        }

        const stats = aggregate(results, FLOOR);
        summaries.set(scenario.name, stats);
        console.log(reportRow(scenario.name, stats));

        for (const result of results) {
          if (result.stats.trades === 0) continue;
          console.log(`  ${reportRow(`  ${result.symbol}`, result.stats).trimEnd()}`);
        }

        const exits = Object.entries(stats.byExit)
          .sort((a, b) => b[1].count - a[1].count)
          .map(([action, v]) => `${action} ${v.count} (${money(v.netPnl, 7).trim()})`)
          .join(", ");
        console.log(`  exits: ${exits || "none"}   max drawdown ${stats.maxDrawdown.toFixed(2)}\n`);
      }

      console.log(`${"=".repeat(108)}\n`);

      // The report is the deliverable, but a run that produced no decision at
      // all is a broken harness rather than a quiet market, and must fail.
      expect([...summaries.values()].some((s) => s.trades > 0)).toBe(true);
    },
    { timeout: 600_000 },
  );
});
