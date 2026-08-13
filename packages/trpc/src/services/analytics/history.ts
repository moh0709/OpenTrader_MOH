/**
 * Time series and distributions derived from closed round trips.
 *
 * Everything here is computed from the trades themselves rather than from
 * account balances, because the paper exchange reports no balances
 * (`exchange.getAssets` returns an empty list for a paper account), so realised
 * P&L is the only trustworthy basis for an equity curve.
 */
import type { RoundTrip } from "./types.js";
import { EPSILON } from "./types.js";

export type EquityPoint = {
  /** Bucket start, epoch ms. */
  t: number;
  /** Net profit realised inside this bucket. */
  pnl: number;
  /** Running total of net profit up to and including this bucket. */
  cumulative: number;
  trades: number;
};

export const BUCKET_MS = {
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
} as const;

export type BucketSize = keyof typeof BUCKET_MS;

/**
 * Cumulative realised P&L over time.
 *
 * Empty buckets are emitted so the curve advances with the clock instead of
 * jumping between trades, which would misrepresent a quiet period as a steep one.
 */
export function buildEquityCurve(
  roundTrips: RoundTrip[],
  bucket: BucketSize,
  from?: number,
  to?: number,
): EquityPoint[] {
  if (roundTrips.length === 0) return [];

  const size = BUCKET_MS[bucket];
  const chronological = [...roundTrips].sort((a, b) => a.exitAt - b.exitAt);

  const start = Math.floor((from ?? chronological[0]!.exitAt) / size) * size;
  const end = Math.floor((to ?? chronological[chronological.length - 1]!.exitAt) / size) * size;

  const byBucket = new Map<number, { pnl: number; trades: number }>();
  for (const rt of chronological) {
    const key = Math.floor(rt.exitAt / size) * size;
    if (key < start || key > end) continue;

    const entry = byBucket.get(key);
    if (entry) {
      entry.pnl += rt.netPnl;
      entry.trades += 1;
    } else {
      byBucket.set(key, { pnl: rt.netPnl, trades: 1 });
    }
  }

  // Guard against an unbounded series if a very small bucket meets a long range.
  const maxPoints = 2000;
  const points: EquityPoint[] = [];
  let cumulative = 0;

  for (let t = start; t <= end && points.length < maxPoints; t += size) {
    const entry = byBucket.get(t);
    cumulative += entry?.pnl ?? 0;
    points.push({ t, pnl: entry?.pnl ?? 0, cumulative, trades: entry?.trades ?? 0 });
  }

  return points;
}

/** Cumulative P&L sampled down to a fixed number of points, for sparklines. */
export function buildSparkline(roundTrips: RoundTrip[], points = 40): number[] {
  if (roundTrips.length === 0) return [];

  const chronological = [...roundTrips].sort((a, b) => a.exitAt - b.exitAt);
  const cumulative: number[] = [];
  let running = 0;

  for (const rt of chronological) {
    running += rt.netPnl;
    cumulative.push(running);
  }

  if (cumulative.length <= points) return cumulative;

  const sampled: number[] = [];
  for (let i = 0; i < points; i += 1) {
    sampled.push(cumulative[Math.floor((i * (cumulative.length - 1)) / (points - 1))]!);
  }

  return sampled;
}

export type HistogramBin = {
  from: number;
  to: number;
  count: number;
  /** Total net P&L of the trades in this bin. */
  total: number;
};

/** Distribution of per-trade net profit. */
export function buildPnlDistribution(roundTrips: RoundTrip[], binCount = 12): HistogramBin[] {
  if (roundTrips.length === 0) return [];

  const values = roundTrips.map((rt) => rt.netPnl);
  const min = Math.min(...values);
  const max = Math.max(...values);

  // A fleet of grid bots can produce near-identical profits, which collapses the
  // range to zero. One bin is the honest answer there.
  if (max - min < EPSILON) {
    return [{ from: min, to: max, count: values.length, total: values.reduce((a, b) => a + b, 0) }];
  }

  const width = (max - min) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    count: 0,
    total: 0,
  }));

  for (const value of values) {
    const index = Math.min(binCount - 1, Math.floor((value - min) / width));
    bins[index]!.count += 1;
    bins[index]!.total += value;
  }

  return bins;
}

export type HoldTimeBucket = {
  label: string;
  maxMs: number;
  count: number;
  averagePnl: number;
};

const HOLD_TIME_BUCKETS: Array<{ label: string; maxMs: number }> = [
  { label: "< 1m", maxMs: 60_000 },
  { label: "1-5m", maxMs: 300_000 },
  { label: "5-15m", maxMs: 900_000 },
  { label: "15-30m", maxMs: 1_800_000 },
  { label: "30-60m", maxMs: 3_600_000 },
  { label: "1-4h", maxMs: 14_400_000 },
  { label: "4-24h", maxMs: 86_400_000 },
  { label: "> 1d", maxMs: Number.POSITIVE_INFINITY },
];

/** How long trades are held, and whether holding longer actually pays. */
export function buildHoldTimeDistribution(roundTrips: RoundTrip[]): HoldTimeBucket[] {
  const buckets = HOLD_TIME_BUCKETS.map((b) => ({ ...b, count: 0, total: 0 }));

  for (const rt of roundTrips) {
    const bucket = buckets.find((b) => rt.holdMs < b.maxMs) ?? buckets[buckets.length - 1]!;
    bucket.count += 1;
    bucket.total += rt.netPnl;
  }

  return buckets.map(({ label, maxMs, count, total }) => ({
    label,
    maxMs,
    count,
    averagePnl: count > 0 ? total / count : 0,
  }));
}

export type HeatmapCell = {
  /** 0 = Sunday, matching Date.getUTCDay. */
  day: number;
  hour: number;
  count: number;
  pnl: number;
};

/** Trades closed by hour and weekday, in UTC. */
export function buildActivityHeatmap(roundTrips: RoundTrip[]): HeatmapCell[] {
  const cells: HeatmapCell[] = [];
  for (let day = 0; day < 7; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) cells.push({ day, hour, count: 0, pnl: 0 });
  }

  for (const rt of roundTrips) {
    const date = new Date(rt.exitAt);
    const cell = cells[date.getUTCDay() * 24 + date.getUTCHours()]!;
    cell.count += 1;
    cell.pnl += rt.netPnl;
  }

  return cells;
}

export type FeeBreakdown = {
  gross: number;
  fees: number;
  net: number;
  /** Fees as a percent of gross profit. Null when gross profit is zero. */
  feeRatio: number | null;
};

export function buildFeeBreakdown(roundTrips: RoundTrip[]): FeeBreakdown {
  const gross = roundTrips.reduce((sum, rt) => sum + rt.grossPnl, 0);
  const fees = roundTrips.reduce((sum, rt) => sum + rt.fees, 0);

  return {
    gross,
    fees,
    net: gross - fees,
    feeRatio: Math.abs(gross) > EPSILON ? (fees / Math.abs(gross)) * 100 : null,
  };
}

/** Rolling window totals used by the KPI strip. */
export function windowTotals(roundTrips: RoundTrip[], now: number, windowMs: number) {
  const cutoff = now - windowMs;
  const inWindow = roundTrips.filter((rt) => rt.exitAt >= cutoff);

  return {
    trades: inWindow.length,
    netPnl: inWindow.reduce((sum, rt) => sum + rt.netPnl, 0),
    wins: inWindow.filter((rt) => rt.outcome === "win").length,
    losses: inWindow.filter((rt) => rt.outcome === "loss").length,
  };
}
