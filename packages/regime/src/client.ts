import { logger } from "@opentrader/logger";
import { STANCE_FACTOR, clampConfidence, type Conviction, type Stance } from "./types.js";

/**
 * Client for the TradingAgents research service.
 *
 * Every failure path here returns null or an empty map rather than throwing.
 * That is deliberate and load-bearing: the research service is a *strategist*,
 * and a strategist being unreachable must never stop the execution engine from
 * running. A null flows into the governor, the governor passes through to
 * baseline, and the fleet trades exactly as it did before this layer existed.
 *
 * The service is bound to loopback and never proxied, so there is no auth here —
 * reaching it already requires being on the host.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:8801";
const DEFAULT_TIMEOUT_MS = 5000;

export type ResearchClientOptions = {
  baseUrl?: string;
  timeoutMs?: number;
};

export function researchBaseUrl(): string {
  return process.env.RESEARCH_URL || DEFAULT_BASE_URL;
}

/** Narrows arbitrary JSON to a Conviction, or null if it is not one. */
export function parseConviction(raw: unknown): Conviction | null {
  if (!raw || typeof raw !== "object") return null;

  const value = raw as Record<string, unknown>;
  const symbol = value.symbol;
  const stance = value.stance;
  const asOf = value.asOf;

  if (typeof symbol !== "string" || symbol === "") return null;

  // An unrecognised stance is rejected rather than coerced to "hold". Coercion
  // would silently turn a service that has started returning nonsense into one
  // that looks like it is calmly recommending no action.
  if (typeof stance !== "string" || !(stance in STANCE_FACTOR)) return null;

  if (typeof asOf !== "number" || !Number.isFinite(asOf)) return null;

  return {
    symbol,
    stance: stance as Stance,
    confidence: clampConfidence(typeof value.confidence === "number" ? value.confidence : 0),
    asOf,
    summary: typeof value.summary === "string" ? value.summary : "",
    model: typeof value.model === "string" ? value.model : undefined,
    costUsd: typeof value.costUsd === "number" ? value.costUsd : undefined,
  };
}

async function getJson(path: string, options: ResearchClientOptions): Promise<unknown | null> {
  const baseUrl = options.baseUrl ?? researchBaseUrl();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal });

    if (!response.ok) {
      logger.warn(`[Regime] Research service returned ${response.status} for ${path}`);

      return null;
    }

    return await response.json();
  } catch (error) {
    // Debug rather than warn: while the service is down this fires on every
    // poll, and a log that floods is a log nobody reads. The dashboard health
    // check is what makes the outage visible.
    logger.debug(`[Regime] Research service unreachable at ${path}: ${(error as Error).message}`);

    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Latest conviction per symbol, keyed by the symbol the bots use.
 *
 * Symbols the service does not know about are simply absent from the map, which
 * the governor reads as "no conviction" and therefore as baseline.
 */
export async function fetchLatestConvictions(
  symbols: string[],
  options: ResearchClientOptions = {},
): Promise<Map<string, Conviction>> {
  const result = new Map<string, Conviction>();
  if (symbols.length === 0) return result;

  const query = encodeURIComponent(symbols.join(","));
  const payload = await getJson(`/convictions/latest?symbols=${query}`, options);

  if (!payload || typeof payload !== "object") return result;

  const rows = (payload as Record<string, unknown>).convictions;
  if (!Array.isArray(rows)) return result;

  for (const row of rows) {
    const conviction = parseConviction(row);
    if (conviction) result.set(conviction.symbol, conviction);
  }

  return result;
}

export type ResearchHealth = {
  reachable: boolean;
  lastRunAt: number | null;
  costTodayUsd: number | null;
  symbols: string[];
};

export async function fetchResearchHealth(options: ResearchClientOptions = {}): Promise<ResearchHealth> {
  const payload = await getJson("/health", options);

  if (!payload || typeof payload !== "object") {
    return { reachable: false, lastRunAt: null, costTodayUsd: null, symbols: [] };
  }

  const value = payload as Record<string, unknown>;

  return {
    reachable: true,
    lastRunAt: typeof value.lastRunAt === "number" ? value.lastRunAt : null,
    costTodayUsd: typeof value.costTodayUsd === "number" ? value.costTodayUsd : null,
    symbols: Array.isArray(value.symbols) ? value.symbols.filter((s): s is string => typeof s === "string") : [],
  };
}

/** Kicks off a run. Returns false rather than throwing when the service is down. */
export async function requestResearchRun(
  symbols: string[],
  options: ResearchClientOptions = {},
): Promise<boolean> {
  const baseUrl = options.baseUrl ?? researchBaseUrl();
  const controller = new AbortController();
  // A run takes minutes, but this only queues it — the service replies immediately.
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/research/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols }),
      signal: controller.signal,
    });

    return response.ok;
  } catch (error) {
    logger.warn(`[Regime] Could not request a research run: ${(error as Error).message}`);

    return false;
  } finally {
    clearTimeout(timer);
  }
}
