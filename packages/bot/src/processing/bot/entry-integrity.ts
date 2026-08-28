import { XOrderStatus } from "@opentrader/types";

/**
 * A position may only exist because an exchange filled an order.
 *
 * A strategy can ask for a trade whose entry is already `Filled`. The grid does
 * it for every ladder line at or above the current price, on the assumption that
 * the operator already holds the coin those lines are there to sell. Nothing ever
 * checked that assumption. The normalizer then invented `filledPrice` and
 * `filledAt` from the requested price, and the row landed in the database as a
 * position that was never bought: no exchange order, no fee, no inventory.
 *
 * Two things follow, and both were observed on a live fleet:
 *
 *  - The capital cap cannot see it. The cap is checked where an entry is placed
 *    on the exchange, and an invented fill is never placed. Seven bots on a 1000
 *    cap reached 28,264 of "committed capital" this way, none of it real.
 *  - Everything downstream is fiction: cost basis, floating P&L, and the exposure
 *    the risk watchers read when deciding whether to stop a bot. A watchdog then
 *    restarted the bots, which minted another ladder, which deepened the fiction.
 *
 * So the rule is simple and has no exceptions: an order that a strategy has just
 * asked for has not been near an exchange yet, therefore it is `Idle`. If a
 * strategy wants to own a level it buys it like anything else - through the
 * executor, against the cap, at a price the exchange agrees to.
 *
 * Demotion is deliberately silent about intent: it does not matter whether the
 * strategy claimed `Filled` or `Placed`, because in both cases it is describing
 * an exchange state that does not exist yet.
 */

/** Statuses a strategy may ask for that assert an exchange already acted. */
const UNEARNED: string[] = [XOrderStatus.Filled, XOrderStatus.Placed];

/**
 * The only status an order may be born with.
 *
 * A constant, not a decision. It is a function so the rule has one name and one
 * place to be tested, and so a caller reads as `bornStatus()` rather than as an
 * unexplained `Idle` literal three layers down from the strategy that asked.
 */
export function bornStatus(): XOrderStatus {
  return XOrderStatus.Idle;
}

/**
 * True when a strategy asked for a state only an exchange can grant.
 *
 * Worth logging when it happens: it is the difference between a bot that owns
 * something and a bot that believes it does.
 */
export function claimsUnearnedFill(requested: string | undefined): boolean {
  return requested !== undefined && UNEARNED.includes(requested);
}
