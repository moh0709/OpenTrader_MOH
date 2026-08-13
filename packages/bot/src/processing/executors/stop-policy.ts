/**
 * What happens to a smart trade's orders when its bot stops.
 *
 * Stopping a bot used to cancel every order on every trade, unconditionally.
 * For an entry that had not filled that is correct: nothing was bought, so
 * nothing is exposed, and pulling the order is the clean thing to do.
 *
 * For an exit sitting against an entry that HAS filled it is not. Cancelling it
 * does not reduce exposure - the asset is still owned - it only removes the way
 * out, leaving a position with no order able to close it. The trade also had its
 * `ref` cleared, and since a bot re-adopts its trades by ref, that made the
 * orphaning permanent: on restart the bot could no longer find the position and
 * simply opened a new one at the same level.
 *
 * So the rule is asymmetric, and deliberately so:
 *
 *   - entry side, not filled  -> cancel; no position exists
 *   - exit side, entry filled -> leave working; it is the only way out
 *   - trade still holds stock -> keep the ref, so the bot re-adopts it
 *
 * A take profit left resting can still fill while the bot is stopped, which is
 * the desired outcome: the position closes at its target instead of sitting
 * indefinitely.
 */
import { XEntityType } from "@opentrader/types";

/** The order shape this policy needs. Kept minimal so it is trivial to test. */
export type StopPolicyOrder = {
  entityType: string;
  status: string;
};

const ENTRY_TYPES: string[] = [XEntityType.EntryOrder, XEntityType.SafetyOrder];
const EXIT_TYPES: string[] = [XEntityType.TakeProfitOrder, XEntityType.StopLossOrder];

const isEntry = (order: StopPolicyOrder) => ENTRY_TYPES.includes(order.entityType);
const isExit = (order: StopPolicyOrder) => EXIT_TYPES.includes(order.entityType);

/**
 * True when the trade currently owns an asset: an entry filled and no exit has
 * closed it yet.
 */
export function holdsPosition(orders: StopPolicyOrder[]): boolean {
  const entryFilled = orders.some((order) => isEntry(order) && order.status === "Filled");
  const exitFilled = orders.some((order) => isExit(order) && order.status === "Filled");

  return entryFilled && !exitFilled;
}

/**
 * Whether this order should be cancelled as its bot stops.
 *
 * Only exits are ever spared, and only while the position they protect is still
 * held. Everything else is cancelled exactly as before.
 */
export function shouldCancelOnStop(order: StopPolicyOrder, orders: StopPolicyOrder[]): boolean {
  if (!isExit(order)) return true;

  return !holdsPosition(orders);
}

/**
 * Whether the trade's `ref` may be cleared.
 *
 * Clearing it detaches the trade from its bot for good, so it is only safe once
 * nothing is held. A held position keeps its ref and is re-adopted on restart.
 */
export function canClearRef(orders: StopPolicyOrder[]): boolean {
  return !holdsPosition(orders);
}
