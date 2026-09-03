import { logger } from "@opentrader/logger";
import { fetchJson, numberOrNull } from "./http.js";
import { TIMEFRAMES, ratingLabel, type TechnicalRating, type Timeframe } from "./types.js";

/**
 * TradingView's public screener, read as a second opinion on every market.
 *
 * The desk already computes its own indicators from its own candles. This is
 * deliberately not that: it is an outside read, computed by someone else, on
 * data the desk did not fetch, across six timeframes at once. Its value is in
 * disagreeing — when our trend agent likes a market and every TradingView
 * timeframe leans the other way, that conflict is the signal.
 *
 * The endpoint is public and unauthenticated, and TradingView changes it
 * without notice. So the parser assumes nothing: a moved field, a renamed
 * column, or an HTML error page all resolve to `null`, and the council votes
 * without this member.
 */

const DEFAULT_BASE_URL = "https://scanner.tradingview.com";

/** Which screener to query. Crypto pairs live under `crypto`. */
const SCREENER = "crypto";

/**
 * The aggregate recommendation, plus the two readings worth naming separately.
 *
 * `Recommend.All` blends the moving-average and oscillator groups, which is the
 * number TradingView paints as the gauge. RSI and ADX are carried because the
 * head reasons about them explicitly: RSI says how stretched a market is, ADX
 * says whether a trend is worth trading at all.
 */
const BASE_COLUMNS = ["Recommend.All", "RSI", "ADX", "close", "change"] as const;

/** The daily reading is the unsuffixed column, so it is not requested twice. */
const SUFFIXED: readonly Timeframe[] = TIMEFRAMES.filter((tf) => tf !== "1D");

export type TradingViewOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  /** Exchange prefix for symbols with no explicit mapping. */
  exchange?: string;
  /** Explicit symbol-to-ticker overrides, e.g. `{ "BTC/USDT": "OKX:BTCUSDT" }`. */
  tickers?: Record<string, string>;
};

/**
 * Turn an exchange symbol into a TradingView ticker.
 *
 * `BTC/USDT` on Binance is `BINANCE:BTCUSDT`. Anything already containing a
 * colon is assumed to be a ticker the operator wrote by hand and is passed
 * through untouched.
 */
export function toTicker(symbol: string, exchange = "BINANCE", overrides: Record<string, string> = {}): string {
  const explicit = overrides[symbol];
  if (explicit) return explicit;
  if (symbol.includes(":")) return symbol;

  return `${exchange.toUpperCase()}:${symbol.replace(/[/\-_]/g, "").toUpperCase()}`;
}

/** Parse `BTC/USDT=OKX:BTCUSDT,ETH/USDT=BINANCE:ETHUSDT` into a map. */
export function parseTickerOverrides(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;

  for (const pair of raw.split(",")) {
    const [symbol, ticker] = pair.split("=").map((part) => part.trim());
    if (symbol && ticker) out[symbol] = ticker;
  }

  return out;
}

export function tradingViewOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): TradingViewOptions {
  return {
    baseUrl: env.TRADINGVIEW_URL || DEFAULT_BASE_URL,
    timeoutMs: Number(env.TRADINGVIEW_TIMEOUT_MS) || 6000,
    exchange: env.TRADINGVIEW_EXCHANGE || "BINANCE",
    tickers: parseTickerOverrides(env.TRADINGVIEW_TICKERS),
  };
}

/** The column list, in the order the response rows echo it back. */
export function buildColumns(): string[] {
  return [...BASE_COLUMNS, ...SUFFIXED.map((tf) => `Recommend.All|${tf}`)];
}

type ScanRow = { s?: unknown; d?: unknown };

/**
 * Read one response row into a rating.
 *
 * Returns null when the row carries no usable aggregate at all — a ticker
 * TradingView does not list answers with nulls across the board, and reporting
 * that as a neutral 0 would put a fabricated "no opinion" into the vote.
 */
export function parseRow(row: ScanRow, symbol: string, columns: string[], now: number): TechnicalRating | null {
  const values = Array.isArray(row.d) ? row.d : null;
  if (!values) return null;

  const at = (column: string): number | null => {
    const index = columns.indexOf(column);
    return index === -1 ? null : numberOrNull(values[index]);
  };

  const daily = at("Recommend.All");

  const byTimeframe: Partial<Record<Timeframe, number>> = {};
  if (daily !== null) byTimeframe["1D"] = daily;

  for (const tf of SUFFIXED) {
    const value = at(`Recommend.All|${tf}`);
    if (value !== null) byTimeframe[tf] = value;
  }

  const readings = Object.values(byTimeframe);
  if (readings.length === 0) return null;

  // The headline number is the mean across every timeframe that reported, not
  // the daily one. A single timeframe is a snapshot; the blend is a position.
  const rating = readings.reduce((sum, value) => sum + value, 0) / readings.length;

  // Agreement is measured against the sign of the blend. A flat reading counts
  // as neither agreeing nor dissenting, so a market where every timeframe is
  // asleep scores low alignment rather than a spurious unanimous one.
  const direction = Math.sign(rating);
  const agreeing = direction === 0 ? 0 : readings.filter((value) => Math.sign(value) === direction).length;

  return {
    source: "tradingview",
    symbol,
    ticker: typeof row.s === "string" ? row.s : symbol,
    rating,
    label: ratingLabel(rating),
    byTimeframe,
    alignment: agreeing / readings.length,
    timeframes: readings.length,
    rsi: at("RSI"),
    adx: at("ADX"),
    close: at("close"),
    changePercent: at("change"),
    asOf: now,
  };
}

/**
 * Fetch technical ratings for a batch of symbols.
 *
 * Batched into one call on purpose: the screener prices a request by round trip
 * rather than by ticker, and a desk watching eight markets should not make
 * eight requests a minute at a service doing this for free. Symbols the vendor
 * does not know are simply absent from the result.
 */
export async function fetchTechnicalRatings(
  symbols: string[],
  options: TradingViewOptions = {},
): Promise<Map<string, TechnicalRating>> {
  const out = new Map<string, TechnicalRating>();
  if (symbols.length === 0) return out;

  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const exchange = options.exchange ?? "BINANCE";
  const overrides = options.tickers ?? {};
  const columns = buildColumns();

  // Two symbols can map to one ticker — an override pointing both at the same
  // market. The reverse index keeps the reply attributable to every symbol that
  // asked for it.
  const bySymbol = new Map(symbols.map((symbol) => [symbol, toTicker(symbol, exchange, overrides)] as const));
  const tickers = [...new Set(bySymbol.values())];

  const payload = await fetchJson(`${baseUrl}/${SCREENER}/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbols: { tickers, query: { types: [] } }, columns }),
    timeoutMs: options.timeoutMs,
  });

  if (!payload || typeof payload !== "object") return out;

  const rows = (payload as { data?: unknown }).data;
  if (!Array.isArray(rows)) {
    logger.debug("[Intel] TradingView answered without a data array");
    return out;
  }

  const now = Date.now();
  const byTicker = new Map<string, ScanRow>();
  for (const row of rows) {
    if (row && typeof row === "object" && typeof (row as ScanRow).s === "string") {
      byTicker.set((row as { s: string }).s, row as ScanRow);
    }
  }

  for (const [symbol, ticker] of bySymbol) {
    const row = byTicker.get(ticker);
    if (!row) continue;

    const rating = parseRow(row, symbol, columns, now);
    if (rating) out.set(symbol, rating);
  }

  if (out.size > 0) {
    logger.debug(`[Intel] TradingView rated ${out.size}/${symbols.length} symbols`);
  }

  return out;
}
