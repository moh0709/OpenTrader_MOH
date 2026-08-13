import type { IOrderbook } from "@opentrader/types";
import { evaluatePair } from "./spread.js";
import type { ArbEvaluation, ArbitrageConfig, VenueQuote } from "./types.js";

/**
 * Minimal contract the scanner needs from a venue.
 *
 * Deliberately narrower than `IExchange` so the engine stays pure and unit
 * testable; the strategy layer adapts a real exchange into this shape.
 */
export type OrderbookSource = {
  venue: string;
  getOrderbook: (symbol: string) => Promise<IOrderbook>;
  /** Taker fee in bps. Falls back to the config default when omitted. */
  takerFeeBps?: number;
};

export type ScanResult = {
  symbol: string;
  /** Every direction evaluated, best net spread first. */
  evaluations: ArbEvaluation[];
  /** Venues that answered with a usable book. */
  venuesQuoted: string[];
  /** Venues that failed, with the reason. */
  venuesFailed: { venue: string; error: string }[];
  /** The single best executable opportunity, if any cleared every gate. */
  best: ArbEvaluation | null;
  scannedAt: number;
};

/**
 * Fetch books from every source concurrently. A venue that errors or returns an
 * unusable book is dropped from the scan rather than failing the whole sweep —
 * one dead venue must never blind the scanner to the others.
 */
export async function collectQuotes(
  sources: OrderbookSource[],
  symbol: string,
  config: ArbitrageConfig,
): Promise<{ quotes: VenueQuote[]; failures: { venue: string; error: string }[] }> {
  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      const book = await source.getOrderbook(symbol);
      return { source, book };
    }),
  );

  const quotes: VenueQuote[] = [];
  const failures: { venue: string; error: string }[] = [];

  settled.forEach((result, i) => {
    const source = sources[i];
    if (result.status === "rejected") {
      failures.push({ venue: source.venue, error: String(result.reason?.message ?? result.reason) });
      return;
    }

    const { book } = result.value;
    if (!book || !Array.isArray(book.asks) || !Array.isArray(book.bids)) {
      failures.push({ venue: source.venue, error: "malformed orderbook" });
      return;
    }
    if (book.asks.length === 0 || book.bids.length === 0) {
      failures.push({ venue: source.venue, error: "empty orderbook" });
      return;
    }

    quotes.push({
      venue: source.venue,
      symbol,
      book,
      takerFeeBps: source.takerFeeBps ?? config.defaultTakerFeeBps,
    });
  });

  return { quotes, failures };
}

/**
 * Scan one symbol across every venue pair in both directions.
 */
export async function scanSymbol(
  sources: OrderbookSource[],
  symbol: string,
  config: ArbitrageConfig,
  now: number = Date.now(),
): Promise<ScanResult> {
  const { quotes, failures } = await collectQuotes(sources, symbol, config);

  const evaluations: ArbEvaluation[] = [];
  for (let i = 0; i < quotes.length; i++) {
    for (let j = i + 1; j < quotes.length; j++) {
      evaluations.push(...evaluatePair(quotes[i], quotes[j], config, now));
    }
  }

  evaluations.sort((a, b) => b.netSpreadBps - a.netSpreadBps);
  const best = evaluations.find((e) => e.executable) ?? null;

  return {
    symbol,
    evaluations,
    venuesQuoted: quotes.map((q) => q.venue),
    venuesFailed: failures,
    best,
    scannedAt: now,
  };
}

/**
 * One-line summary of a scan.
 *
 * Prints the naive top-of-book spread next to the real net spread on purpose:
 * the gap between them is the number that decides whether an "opportunity" is
 * real, and hiding it is how arbitrage bots end up losing money confidently.
 */
export function summarizeScan(result: ScanResult): string {
  const top = result.evaluations[0];
  if (!top) return `[arb] ${result.symbol}: no comparable venues (${result.venuesFailed.length} failed)`;

  const verdict = result.best
    ? `EXECUTABLE net=${result.best.netSpreadBps.toFixed(2)}bps profit=${result.best.netProfitQuote.toFixed(4)}`
    : `no-trade (${top.rejections.join(",") || "none"})`;

  return (
    `[arb] ${result.symbol} ${top.buyVenue}->${top.sellVenue} ` +
    `topOfBook=${top.topOfBookSpreadBps.toFixed(2)}bps ` +
    `gross=${top.grossSpreadBps.toFixed(2)}bps ` +
    `net=${top.netSpreadBps.toFixed(2)}bps ` +
    `slip=${(top.buySlippageBps + top.sellSlippageBps).toFixed(2)}bps ` +
    `age=${top.bookAgeMs}ms | ${verdict}`
  );
}
