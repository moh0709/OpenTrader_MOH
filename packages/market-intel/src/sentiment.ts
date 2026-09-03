import { fetchJson, numberOrNull } from "./http.js";
import type { SentimentReading } from "./types.js";

/**
 * The crypto fear and greed index.
 *
 * One number for the whole asset class, published daily and free. It says
 * nothing about any particular market, which is exactly why it is useful: it is
 * the only input the desk has that is not derived from the price series it is
 * about to trade.
 *
 * The head uses it as a brake, never as a reason. Extreme greed argues for
 * smaller entries and quicker profit taking; extreme fear argues for patience.
 * Neither is allowed to open a position on its own.
 */

const DEFAULT_URL = "https://api.alternative.me/fng/?limit=1";

export type SentimentOptions = {
  url?: string;
  timeoutMs?: number;
};

export function sentimentOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SentimentOptions {
  return {
    url: env.SENTIMENT_URL || DEFAULT_URL,
    timeoutMs: Number(env.SENTIMENT_TIMEOUT_MS) || 6000,
  };
}

/** Narrow the vendor's payload to a reading, or null if it is not one. */
export function parseSentiment(payload: unknown): SentimentReading | null {
  if (!payload || typeof payload !== "object") return null;

  const rows = (payload as { data?: unknown }).data;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const row = rows[0];
  if (!row || typeof row !== "object") return null;

  const record = row as Record<string, unknown>;
  const value = numberOrNull(record.value);
  if (value === null || value < 0 || value > 100) return null;

  // The vendor publishes seconds; everything else in this codebase is epoch ms.
  const seconds = numberOrNull(record.timestamp);

  return {
    source: "alternative.me",
    value,
    label: typeof record.value_classification === "string" ? record.value_classification : "unknown",
    asOf: seconds !== null ? seconds * 1000 : Date.now(),
  };
}

export async function fetchSentiment(options: SentimentOptions = {}): Promise<SentimentReading | null> {
  const payload = await fetchJson(options.url ?? DEFAULT_URL, { timeoutMs: options.timeoutMs });

  return parseSentiment(payload);
}
