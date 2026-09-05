/**
 * What a paper fill costs.
 *
 * Paper trading charged nothing at all until now: `PaperOrder.fee` defaulted to
 * zero and nothing ever wrote it, so every realised P&L this system reported —
 * the trading head's book, the analytics round trips, the dashboard — was gross.
 * A strategy that clears its costs by a basis point looked identical to one that
 * did not, which is precisely the distinction paper trading exists to draw.
 *
 * The spread was always modelled: a market buy fills at the ask and a sell at
 * the bid. This is the other half of the cost, and with it a paper result is
 * comparable to a live one.
 *
 * Charged in the quote currency on both sides, because that is what the rest of
 * the system expects — see `feeInQuoteCurrency` in `normalize.ts`, which exists
 * to convert real venues' base-denominated buy fees into the same units.
 */

/** Spot taker fee on the venues this fork trades. 10 bps a side, 20 the round trip. */
export const DEFAULT_PAPER_FEE_BPS = 10;

/**
 * The configured rate, in basis points per side.
 *
 * `PAPER_FEE_BPS=0` is honoured — an operator comparing against a zero-fee
 * baseline should be able to ask for one — so the guard is on finiteness and
 * sign, not on truthiness.
 */
export function paperFeeBps(env: NodeJS.ProcessEnv = process.env): number {
  const text = env.PAPER_FEE_BPS?.trim();

  // An empty or absent variable is "not configured", not "charge nothing".
  // `Number("")` is 0, so without this a blank `PAPER_FEE_BPS=` line in an env
  // file would silently restore free paper trading — the exact bug this exists
  // to fix, reintroduced by a stray keystroke.
  if (!text) return DEFAULT_PAPER_FEE_BPS;

  const raw = Number(text);

  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_PAPER_FEE_BPS;
}

/** Fee for one fill, in quote currency. Never negative, never NaN. */
export function paperFeeQuote(quantity: number, price: number, bps: number = paperFeeBps()): number {
  if (!Number.isFinite(quantity) || !Number.isFinite(price) || !Number.isFinite(bps)) return 0;
  if (quantity <= 0 || price <= 0 || bps <= 0) return 0;

  return quantity * price * (bps / 10_000);
}
