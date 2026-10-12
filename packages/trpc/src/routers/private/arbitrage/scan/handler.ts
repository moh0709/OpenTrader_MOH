import {
  DEFAULT_ARBITRAGE_CONFIG,
  DEFAULT_VENUE_TIMEOUT_MS,
  evaluatePair,
  type ArbEvaluation,
  type VenueQuote,
  withTimeout,
} from "@opentrader/arbitrage";
import { exchangeProvider } from "@opentrader/exchanges";
import { ExchangeCode } from "@opentrader/types";
import type { Context } from "../../../../utils/context.js";
import type { TArbitrageScanInputSchema } from "./schema.js";

type Options = {
  ctx: { user: NonNullable<Context["user"]> };
  input: TArbitrageScanInputSchema;
};

export type VenueTop = {
  venue: string;
  bid: number;
  ask: number;
  bidLevels: number;
  askLevels: number;
  ageMs: number;
};

export type ArbitrageScanResult = {
  symbol: string;
  scannedAt: number;
  tradeQty: number;
  venuesQuoted: VenueTop[];
  venuesFailed: { venue: string; error: string }[];
  evaluations: ArbEvaluation[];
  best: ArbEvaluation | null;
  summary: {
    pairsEvaluated: number;
    /** Pairs whose top-of-book spread flattered the real, costed number. */
    overstatedByTopOfBook: number;
    executable: number;
  };
};

/**
 * How long a completed scan stays reusable, and how long a venue may take.
 *
 * The TTL is deliberately shorter than the engine's own staleness limit
 * (`maxBookAgeMs`, 5s) is long, which sounds contradictory but is the point: a
 * served scan carries the timestamps of the books it was built from, so the
 * evaluation still rejects anything stale. What the cache removes is the round
 * trip to seven exchanges, not the freshness check.
 */
const CACHE_TTL_MS = 15_000;

const cache = new Map<string, { at: number; result: ArbitrageScanResult }>();

/**
 * One in-flight scan per key.
 *
 * Without this, two widgets asking for the same market in the same tick each
 * start their own seven-venue sweep, and the second one's exchange calls buy
 * nothing. The map holds the promise rather than the result, so a caller that
 * arrives mid-scan waits on the work already underway instead of duplicating it.
 */
const inFlight = new Map<string, Promise<ArbitrageScanResult>>();

function keyFor(input: TArbitrageScanInputSchema, venues: ExchangeCode[]): string {
  return JSON.stringify([
    input.symbol,
    input.tradeQty,
    input.minNetSpreadBps,
    input.takerFeeBps,
    venues.join(","),
  ]);
}

/** Drop expired entries so the map does not grow with every symbol ever scanned. */
function sweep() {
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [key, entry] of cache) {
    if (entry.at < cutoff) cache.delete(key);
  }
}

/**
 * Scan every venue pair for a real, costed arbitrage opportunity.
 *
 * A venue that fails — or that simply never answers — is dropped from the scan
 * rather than failing the sweep, so one dead exchange must never blind the scan
 * to the others. The timeout is what makes "never answers" mean something: the
 * exchange layer will wait 30s for a socket that is merely stalled, and a page
 * waiting on that reads as broken.
 */
export async function scanArbitrage({ input }: Options): Promise<ArbitrageScanResult> {
  const { symbol, tradeQty, minNetSpreadBps, takerFeeBps } = input;
  const codes = (input.venues?.length ? input.venues : Object.values(ExchangeCode)) as ExchangeCode[];
  const timeoutMs = Number(process.env.ARBITRAGE_VENUE_TIMEOUT_MS) || DEFAULT_VENUE_TIMEOUT_MS;

  const key = keyFor(input, codes);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const run = scanVenues({ codes, symbol, tradeQty, minNetSpreadBps, takerFeeBps, timeoutMs });

  inFlight.set(key, run);

  try {
    const result = await run;
    sweep();
    cache.set(key, { at: Date.now(), result });

    return result;
  } finally {
    inFlight.delete(key);
  }
}

async function scanVenues({
  codes,
  symbol,
  tradeQty,
  minNetSpreadBps,
  takerFeeBps,
  timeoutMs,
}: {
  codes: ExchangeCode[];
  symbol: string;
  tradeQty: number;
  minNetSpreadBps: number;
  takerFeeBps: number;
  timeoutMs: number;
}): Promise<ArbitrageScanResult> {
  const now = Date.now();

  const settled = await Promise.allSettled(
    codes.map(async (code) => {
      const exchange = exchangeProvider.fromCode(code, false);
      const book = await withTimeout(
        exchange.getOrderbook(symbol),
        timeoutMs,
        `did not answer within ${timeoutMs}ms`,
      );

      return { code, book };
    }),
  );

  const quotes: VenueQuote[] = [];
  const venuesQuoted: VenueTop[] = [];
  const venuesFailed: { venue: string; error: string }[] = [];

  settled.forEach((result, i) => {
    const venue = codes[i];

    if (result.status === "rejected") {
      venuesFailed.push({ venue, error: String(result.reason?.message ?? result.reason).slice(0, 120) });
      return;
    }

    const { book } = result.value;
    if (!book?.asks?.length || !book?.bids?.length) {
      venuesFailed.push({ venue, error: "no book for this symbol" });
      return;
    }

    quotes.push({ venue, symbol, book, takerFeeBps });
    venuesQuoted.push({
      venue,
      bid: book.bids[0].price,
      ask: book.asks[0].price,
      bidLevels: book.bids.length,
      askLevels: book.asks.length,
      ageMs: book.timestamp > 0 ? Math.max(0, now - book.timestamp) : 0,
    });
  });

  const config = { ...DEFAULT_ARBITRAGE_CONFIG, tradeQty, minNetSpreadBps, defaultTakerFeeBps: takerFeeBps };
  const evaluations: ArbEvaluation[] = [];

  for (let i = 0; i < quotes.length; i++) {
    for (let j = i + 1; j < quotes.length; j++) {
      evaluations.push(...evaluatePair(quotes[i], quotes[j], config, now));
    }
  }

  evaluations.sort((a, b) => b.netSpreadBps - a.netSpreadBps);

  return {
    symbol,
    scannedAt: now,
    tradeQty,
    venuesQuoted: venuesQuoted.sort((a, b) => a.venue.localeCompare(b.venue)),
    venuesFailed,
    evaluations,
    best: evaluations.find((e) => e.executable) ?? null,
    summary: {
      pairsEvaluated: evaluations.length,
      overstatedByTopOfBook: evaluations.filter((e) => e.topOfBookSpreadBps > e.netSpreadBps).length,
      executable: evaluations.filter((e) => e.executable).length,
    },
  };
}
