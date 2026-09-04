import { logger } from "@opentrader/logger";

/**
 * Warn once about a recurring condition, then stop repeating yourself.
 *
 * A watcher that loses its connection retries every few seconds, and each retry
 * logs. When the far end is having a bad hour — OKX's orderbook checksum fails
 * are the usual culprit — that is one identical warning roughly every three
 * seconds, per symbol: measured at 1,200 lines an hour on a live host, which is
 * enough to bury everything else in the journal.
 *
 * Suppressing it outright would be worse: a silent reconnect loop is a watcher
 * that looks healthy while delivering nothing. So the first occurrence prints
 * immediately, repeats are counted, and the count is reported when the window
 * lapses — the condition stays visible, its volume does not.
 */
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

type Entry = { at: number; suppressed: number };

const seen = new Map<string, Entry>();

/**
 * @param key   what makes this the "same" warning — usually channel, venue and symbol
 * @param message what to say the first time, and after each window
 */
export function warnThrottled(key: string, message: string, windowMs = DEFAULT_WINDOW_MS, now = Date.now()): void {
  const previous = seen.get(key);

  if (previous && now - previous.at < windowMs) {
    previous.suppressed += 1;

    return;
  }

  const repeats = previous?.suppressed ?? 0;
  logger.warn(repeats > 0 ? `${message} (${repeats} more like this in the last few minutes)` : message);

  seen.set(key, { at: now, suppressed: 0 });
}

/** Forget a key once the condition clears, so its return is reported at once. */
export function clearThrottled(key: string): void {
  seen.delete(key);
}

/** Test seam. */
export function resetThrottled(): void {
  seen.clear();
}
