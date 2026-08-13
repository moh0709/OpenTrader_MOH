import type { Candle } from "./types.js";

/**
 * Small, self-contained indicator set.
 *
 * Kept local rather than pulled from a library so the council's inputs are
 * exactly reproducible in tests — an agent's opinion is only auditable if the
 * numbers behind it are.
 */

export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const window = values.slice(-period);
  return window.reduce((a, b) => a + b, 0) / period;
}

/**
 * Wilder's RSI. Returns null when there is not enough history to warm it up.
 */
export function rsi(values: number[], period = 14): number | null {
  if (period <= 0 || values.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  // Seed from the first `period` deltas.
  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder smoothing across the remainder.
  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Average true range as a percentage of the last close — a scale-free
 * volatility read that can be compared across symbols.
 */
export function atrPercent(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }

  const atr = sma(trueRanges, period);
  const lastClose = candles[candles.length - 1].close;
  if (atr === null || lastClose <= 0) return null;

  return (atr / lastClose) * 100;
}

/**
 * Slope of the last `period` closes, expressed as percent change per candle.
 */
export function slopePercent(values: number[], period = 10): number | null {
  if (values.length < period || period < 2) return null;
  const window = values.slice(-period);
  const first = window[0];
  const last = window[window.length - 1];
  if (first <= 0) return null;
  return ((last - first) / first / (period - 1)) * 100;
}
