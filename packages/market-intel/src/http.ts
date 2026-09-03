import { logger } from "@opentrader/logger";

/**
 * One JSON call to a public endpoint, with a deadline and no exceptions.
 *
 * Every consumer of this module sits on a trading loop, so the contract is that
 * a source either answers within its timeout or is simply not there this pass.
 * Failures are logged at debug: while a vendor is down this fires on every tick,
 * and a log that floods is a log nobody reads.
 */
export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<unknown | null> {
  const { timeoutMs = 6000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        // Some public endpoints refuse a request with no user agent at all.
        "user-agent": "OpenTrader/1.0 (+https://github.com/bludnic/opentrader)",
        ...rest.headers,
      },
    });

    if (!response.ok) {
      logger.debug(`[Intel] ${url} returned ${response.status}`);
      return null;
    }

    return await response.json();
  } catch (error) {
    logger.debug(`[Intel] ${url} unreachable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Finite numbers only. Anything else — null, a string, NaN — is "not reported". */
export function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
