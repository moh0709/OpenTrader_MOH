/**
 * How long a single venue may take before it is dropped from a scan.
 *
 * Chosen well under the exchange layer's own 30s timeout (`EXCHANGE_TIMEOUT_MS`)
 * on purpose. A scan is read by a person looking at a screen: a venue that has
 * not answered in three seconds is not going to produce a book worth comparing,
 * and holding the whole sweep for it means every other venue's answer is
 * discarded along with it.
 */
export const DEFAULT_VENUE_TIMEOUT_MS = 3_000;

export class VenueTimeoutError extends Error {
  constructor(venue: string, ms: number) {
    super(`${venue} did not answer within ${ms}ms`);
    this.name = "VenueTimeoutError";
  }
}

/**
 * Reject after `ms` unless `promise` settles first.
 *
 * `Promise.allSettled` isolates a venue that *errors*, but has nothing to say
 * about a venue that simply never replies — and a socket left open against a
 * stalled exchange is exactly that. Without this, one hanging venue makes the
 * scan take as long as the slowest participant, which is the failure that made
 * the analytics page look broken.
 *
 * The timer is always cleared, including on success, so a completed request
 * cannot leak a pending timer holding the event loop open.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
