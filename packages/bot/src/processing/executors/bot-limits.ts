/**
 * Per-bot trading limits.
 *
 * Two guards a strategy does not provide for itself:
 *
 *  - **Capital cap** - the most quote currency a bot may have committed at once.
 *    A grid bot will happily place an entry on every level it has, which on a
 *    wide grid is far more money than you intended to expose. With a cap set,
 *    entries stop being placed once the committed total would exceed it.
 *
 *  - **Minimum profit** - the least a cycle must earn before its exit is allowed
 *    to close it. Grid spacing is set in price, not in money, so a tight grid on
 *    a small quantity can close for fractions of a cent. Rather than block the
 *    exit, which would strand the position, the take profit is lifted to the
 *    price that actually earns the floor.
 *
 * Both are pure functions of data the caller already has, so the thresholds are
 * testable without a database, an exchange, or a running bot.
 */
export type BotLimits = {
  /** Maximum quote-currency capital committed at once. Null means no cap. */
  maxCapital: number | null;
  /** Minimum quote-currency profit a cycle must make. Null means no floor. */
  minProfit: number | null;
};

export const NO_LIMITS: BotLimits = { maxCapital: null, minProfit: null };

/** Reads a limit column, treating zero and negatives as "not set". */
export function toLimit(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function toBotLimits(bot: { maxCapital?: number | null; minProfit?: number | null } | null): BotLimits {
  return { maxCapital: toLimit(bot?.maxCapital), minProfit: toLimit(bot?.minProfit) };
}

type LimitOrder = {
  id?: number;
  entityType: string;
  status: string;
  price: number | null;
  filledPrice: number | null;
  quantity: number;
};

type LimitTrade = { orders: LimitOrder[] };

const ENTRY_TYPES = ["EntryOrder", "SafetyOrder"];
const EXIT_TYPES = ["TakeProfitOrder", "StopLossOrder"];
const RESTING = ["Idle", "Placed"];

const isEntry = (o: LimitOrder) => ENTRY_TYPES.includes(o.entityType);
const isExit = (o: LimitOrder) => EXIT_TYPES.includes(o.entityType);

/**
 * Quote currency the bot currently has at stake.
 *
 * Counts both money already spent on positions that have not closed, and money
 * earmarked by entry orders resting on the book - an order that is about to fill
 * is a commitment, not spare capacity, and ignoring it would let a grid blow
 * straight through its cap the moment the price moved.
 *
 * `excludeOrderId` leaves out one order. The caller deciding whether to place an
 * entry needs it: that entry is already stored as `Idle`, so counting it here and
 * then adding its notional on top would charge it twice and halve the real cap.
 */
export function committedCapital(trades: LimitTrade[], excludeOrderId?: number): number {
  let committed = 0;

  for (const trade of trades) {
    const closed = trade.orders.some((o) => isExit(o) && o.status === "Filled");

    for (const order of trade.orders) {
      if (!isEntry(order)) continue;
      if (excludeOrderId !== undefined && order.id === excludeOrderId) continue;

      if (order.status === "Filled") {
        // Spent, and still held until an exit closes the cycle.
        if (!closed) committed += (order.filledPrice ?? order.price ?? 0) * order.quantity;
      } else if (RESTING.includes(order.status)) {
        committed += (order.price ?? 0) * order.quantity;
      }
    }
  }

  return committed;
}

/** The quote-currency value an order would commit. */
export function orderNotional(order: { price: number | null; quantity: number }): number {
  return (order.price ?? 0) * order.quantity;
}

export type EntryDecision = { allowed: boolean; reason: string | null };

/**
 * Whether one more entry fits inside the capital cap.
 *
 * A market order has no price to measure, so it cannot be checked against the
 * cap and is allowed through rather than blocked on a number we do not have.
 */
export function allowsEntry(limits: BotLimits, committed: number, notional: number): EntryDecision {
  if (limits.maxCapital === null) return { allowed: true, reason: null };
  if (notional <= 0) return { allowed: true, reason: null };

  const projected = committed + notional;
  if (projected <= limits.maxCapital) return { allowed: true, reason: null };

  return {
    allowed: false,
    reason: `capital limit reached: ${projected.toFixed(2)} would exceed ${limits.maxCapital.toFixed(2)} (already committed ${committed.toFixed(2)})`,
  };
}

/**
 * Whether this refusal is worth a log line.
 *
 * A grid always has more levels than its cap allows, so once the cap engages
 * every tick refuses the same level for the same reason - 16,866 identical
 * lines in two minutes, on a fleet of five bots. The signal is the transition
 * into the refusal and any change in the numbers, not its persistence, so the
 * reason is remembered per bot and repeats are dropped until it differs.
 *
 * Keyed by reason rather than a boolean so a cap that starts biting harder, or
 * a different level being refused, still reports itself.
 */
const lastRefusal = new Map<number, string>();

export function shouldLogRefusal(botId: number, reason: string): boolean {
  if (lastRefusal.get(botId) === reason) return false;

  lastRefusal.set(botId, reason);

  return true;
}

/** Forget a bot refusal history once it places again, so the next one reports. */
export function clearRefusal(botId: number): void {
  lastRefusal.delete(botId);
}

// Grid levels can be processed concurrently. Serialize entry checks per bot so
// two workers cannot both observe the same committed balance and oversubscribe
// the cap before either order is placed.
const entryLocks = new Map<number, Promise<void>>();

export async function withBotEntryLock<T>(botId: number, work: () => Promise<T>): Promise<T> {
  const previous = entryLocks.get(botId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  entryLocks.set(botId, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (entryLocks.get(botId) === queued) entryLocks.delete(botId);
  }
}

/**
 * The exit price that earns at least the minimum profit.
 *
 * Returns the requested price untouched when it already clears the floor, so a
 * strategy that is doing the right thing is never second-guessed. Blocking the
 * exit instead of lifting it would leave the position with nothing to close it,
 * which is the failure this codebase has already been bitten by once.
 */
export function exitPriceForMinProfit(
  limits: BotLimits,
  entryPrice: number,
  quantity: number,
  requestedPrice: number,
): number {
  if (limits.minProfit === null) return requestedPrice;
  if (quantity <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) return requestedPrice;

  const required = entryPrice + limits.minProfit / quantity;

  return requestedPrice >= required ? requestedPrice : required;
}

/** Profit a cycle would make if its exit filled at this price. */
export function projectedProfit(entryPrice: number, quantity: number, exitPrice: number): number {
  return (exitPrice - entryPrice) * quantity;
}
