/**
 * Making an order the venue will actually accept.
 *
 * Nothing in this fork ever did this. A size was computed as
 * `quoteAmount / price` and sent as whatever float that produced —
 * `1664.349495033157 HBAR`, `0.00042871934 BTC` — and a price was sent to eight
 * decimal places whatever the tick size was. Paper accepted all of it, because
 * `PaperExchange` accepts anything. A real venue does not: the order is
 * rejected, or silently rounded into something that is no longer the trade that
 * was decided on.
 *
 * Two separate jobs, split here because only one of them needs ccxt:
 *
 *   - **Rounding** to the market's step and tick. ccxt already knows how to do
 *     this for every exchange and every precision mode, so the glue in
 *     `CCXTExchange.conformOrder` calls `amountToPrecision`/`priceToPrecision`
 *     rather than reimplementing a decimal library badly.
 *   - **Deciding whether what is left is still worth sending**, which is pure
 *     arithmetic over the market's limits, lives here, and is tested without a
 *     network or an exchange.
 *
 * The rounding direction matters and is not symmetric. Quantity always rounds
 * **down**: the caller asked for at most this much exposure, and a venue's step
 * size is not permission to exceed a cap. Price rounds to the nearest tick,
 * where the error is a fraction of a tick and has no direction worth defending.
 */

/** What a venue will accept for one market. */
export type MarketRules = {
  /** Smallest tradable increment of the base asset. */
  amountStep: number | null;
  /** Smallest price increment. */
  priceTick: number | null;
  /** Smallest order size, in base units. */
  minAmount: number | null;
  /** Smallest order value, in quote units. This is the one that usually bites. */
  minCost: number | null;
};

export type ConformedOrder = {
  quantity: number;
  price: number | null;
  /** False when the order cannot legally be sent, whatever we round it to. */
  ok: boolean;
  /** Why it cannot, phrased for a log an operator will read at 3am. */
  reason?: string;
  /** Set when rounding changed something, for the audit trail. */
  adjusted?: string;
};

/** Round down to a multiple of `step`, guarding the float error that division leaves behind. */
export function floorToStep(value: number, step: number | null): number {
  if (!step || step <= 0 || !Number.isFinite(value)) return value;

  /*
   * Flooring the raw quotient is wrong, and rounding it to a fixed number of
   * places is wrong in the other direction.
   *
   * 7.999 / 0.001 is 7998.999999999999, so a plain floor loses an entire step.
   * Rounding the quotient first fixes that case and breaks the opposite one:
   * a value genuinely just under a boundary gets rounded *up*, which would
   * place more size than was asked for — the one direction this must never go.
   *
   * So: snap to the nearest whole step only when the gap is float noise, and
   * floor otherwise. The tolerance is relative, because the absolute error in a
   * quotient near 1e9 is far larger than one near 1.
   */
  const raw = value / step;
  const nearest = Math.round(raw);
  const noise = Math.max(1e-9, Math.abs(raw) * 1e-12);
  const steps = Math.abs(raw - nearest) < noise ? nearest : Math.floor(raw);

  return Number((steps * step).toFixed(12));
}

/**
 * Is this order still worth sending once it has been rounded?
 *
 * Refuses rather than adjusts. A size below the venue's minimum is not a smaller
 * trade, it is no trade — and quietly rounding it *up* to the minimum would
 * place a position larger than the risk limits authorised, which is the one
 * direction this system must never move in.
 */
export function checkOrderLimits(quantity: number, price: number | null, rules: MarketRules): ConformedOrder {
  const refuse = (reason: string): ConformedOrder => ({ quantity, price, ok: false, reason });

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return refuse(`quantity ${quantity} is not a size`);
  }

  if (rules.minAmount !== null && quantity < rules.minAmount) {
    return refuse(`quantity ${quantity} is under the venue minimum of ${rules.minAmount}`);
  }

  if (rules.minCost !== null && price !== null && price > 0) {
    const cost = quantity * price;
    if (cost < rules.minCost) {
      return refuse(`order value ${cost.toFixed(4)} is under the venue minimum of ${rules.minCost}`);
    }
  }

  return { quantity, price, ok: true };
}

/**
 * Round a size and price to what the market accepts, then say whether the result
 * is still sendable.
 *
 * `roundAmount` and `roundPrice` are injected so the ccxt implementations can be
 * used in production and exact arithmetic in tests — the rounding rules differ
 * per venue and are not this module's to guess.
 */
export function conformOrder(
  quantity: number,
  price: number | null,
  rules: MarketRules,
  roundAmount: (value: number) => number = (v) => floorToStep(v, rules.amountStep),
  roundPrice: (value: number) => number = (v) => v,
): ConformedOrder {
  const roundedQuantity = roundAmount(quantity);
  const roundedPrice = price === null ? null : roundPrice(price);

  const notes: string[] = [];
  if (roundedQuantity !== quantity) notes.push(`quantity ${quantity} -> ${roundedQuantity}`);
  if (roundedPrice !== null && price !== null && roundedPrice !== price) notes.push(`price ${price} -> ${roundedPrice}`);

  const checked = checkOrderLimits(roundedQuantity, roundedPrice, rules);

  return notes.length > 0 ? { ...checked, adjusted: notes.join(", ") } : checked;
}
