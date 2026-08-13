import { DEFAULT_ARBITRAGE_CONFIG, evaluatePair, type ArbEvaluation, type VenueQuote } from "@opentrader/arbitrage";
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
 * Scan every venue pair for a real, costed arbitrage opportunity.
 *
 * A venue that fails is dropped from the scan rather than failing the sweep —
 * one dead exchange must never blind the scan to the others.
 */
export async function scanArbitrage({ input }: Options): Promise<ArbitrageScanResult> {
  const { symbol, tradeQty, minNetSpreadBps, takerFeeBps } = input;
  const codes = (input.venues?.length ? input.venues : Object.values(ExchangeCode)) as ExchangeCode[];
  const now = Date.now();

  const settled = await Promise.allSettled(
    codes.map(async (code) => {
      const exchange = exchangeProvider.fromCode(code, false);
      return { code, book: await exchange.getOrderbook(symbol) };
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
