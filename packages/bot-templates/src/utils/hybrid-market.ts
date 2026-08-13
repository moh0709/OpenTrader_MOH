import { DEFAULT_ARBITRAGE_CONFIG, evaluatePair, type ArbEvaluation, type VenueQuote } from "@opentrader/arbitrage";
import type { MarketData, MarketId } from "@opentrader/types";

/**
 * Market-shaping helpers for the Hybrid Trader strategy.
 *
 * These deliberately live outside `src/templates/`. Everything exported from a
 * file under that directory is re-exported through the templates barrel, and the
 * app treats every runtime export of that barrel as a selectable strategy — so a
 * helper exported from a template file shows up in the strategy picker and
 * crashes the runner when chosen (it is not a generator). Keeping them here
 * means they stay unit-testable without polluting the registry.
 */

/**
 * Turn the watcher-populated markets into venue quotes the arbitrage engine can
 * price. Markets are keyed `EXCHANGE:BASE/QUOTE`, so the venue name is the
 * prefix; entries without an order book are skipped rather than faked.
 */
export function collectVenueQuotes(
  markets: Record<MarketId, MarketData>,
  symbol: string,
  takerFeeBps: number,
): VenueQuote[] {
  const quotes: VenueQuote[] = [];

  for (const [marketId, data] of Object.entries(markets) as [MarketId, MarketData][]) {
    if (!data?.orderbook) continue;
    const [venue, pair] = marketId.split(":");
    if (!venue || pair !== symbol) continue;

    quotes.push({ venue, symbol, book: data.orderbook, takerFeeBps });
  }

  return quotes;
}

/**
 * Best fully-costed opportunity across every quoted venue pair, or null when
 * fewer than two venues reported a usable book.
 */
export function bestArbitrage(
  quotes: VenueQuote[],
  tradeQty: number,
  minNetSpreadBps: number,
  now: number,
): ArbEvaluation | null {
  if (quotes.length < 2) return null;

  const config = { ...DEFAULT_ARBITRAGE_CONFIG, tradeQty, minNetSpreadBps };
  const evaluations: ArbEvaluation[] = [];

  for (let i = 0; i < quotes.length; i++) {
    for (let j = i + 1; j < quotes.length; j++) {
      evaluations.push(...evaluatePair(quotes[i], quotes[j], config, now));
    }
  }

  if (evaluations.length === 0) return null;
  evaluations.sort((a, b) => b.netSpreadBps - a.netSpreadBps);

  // Prefer a genuinely executable edge; otherwise report the best rejected one
  // so the council can see why nothing qualified.
  return evaluations.find((e) => e.executable) ?? evaluations[0];
}
