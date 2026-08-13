/**
 * Shared types for the analytics services.
 *
 * These services are deliberately pure: they accept plain row shapes and return
 * plain data, so they can be unit tested without a database or an exchange.
 * The tRPC handlers own all I/O.
 */

/** Subset of the Prisma `Order` row the analytics services need. */
export type AnalyticsOrder = {
  id: number;
  status: string;
  type: string;
  entityType: string;
  side: string;
  price: number | null;
  filledPrice: number | null;
  fee: number | null;
  quantity: number;
  symbol: string;
  smartTradeId: number;
  createdAt: Date;
  placedAt: Date | null;
  syncedAt: Date | null;
  filledAt: Date | null;
  updatedAt: Date;
};

/** Subset of the Prisma `SmartTrade` row plus its orders. */
export type AnalyticsSmartTrade = {
  id: number;
  type: string;
  entryType: string;
  takeProfitType: string;
  symbol: string;
  botId: number | null;
  exchangeAccountId: number;
  createdAt: Date;
  updatedAt: Date;
  orders: AnalyticsOrder[];
};

/** Subset of the Prisma `Bot` row, with `settings`/`state` already parsed. */
export type AnalyticsBot = {
  id: number;
  type: string;
  name: string;
  label: string | null;
  symbol: string;
  enabled: boolean;
  processing: boolean;
  template: string;
  timeframe: string | null;
  createdAt: Date;
  exchangeAccountId: number;
  settings: Record<string, unknown>;
  state: Record<string, unknown>;
};

/** A cached ticker reading for one symbol. */
export type AnalyticsTicker = {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  /** Epoch ms of the reading. */
  timestamp: number;
  /** Epoch ms the value was fetched into the cache. */
  fetchedAt: number;
  /** Age of the reading in ms at the time the snapshot was built. */
  ageMs: number;
  stale: boolean;
  error: string | null;
};

export type TradeOutcome = "win" | "loss" | "breakeven";

export type ExitKind = "takeProfit" | "stopLoss";

/** A completed buy→sell (or sell→buy) cycle with realised profit. */
export type RoundTrip = {
  smartTradeId: number;
  botId: number | null;
  symbol: string;
  /** `Trade` for grid/simple bots, `DCA` for DCA bots. */
  tradeType: string;
  /** "Buy" for a long cycle, "Sell" for a short one. */
  direction: string;
  exitKind: ExitKind;

  quantity: number;
  entryPrice: number;
  exitPrice: number;
  costBasis: number;
  proceeds: number;

  /** Number of fills that made up the entry (>1 for DCA safety orders / ladders). */
  entryFillCount: number;
  exitFillCount: number;
  /** False when the exit only partially closed the entry quantity. */
  fullyClosed: boolean;

  grossPnl: number;
  fees: number;
  netPnl: number;
  pnlPercent: number;

  /** Epoch ms. */
  entryAt: number;
  exitAt: number;
  holdMs: number;

  outcome: TradeOutcome;
};

/** A position whose entry filled but which has not been closed. */
export type OpenPosition = {
  smartTradeId: number;
  botId: number | null;
  symbol: string;
  direction: string;
  quantity: number;
  entryPrice: number;
  costBasis: number;
  entryAt: number;
  ageMs: number;

  /** Live mark price, null when no ticker is available. */
  markPrice: number | null;
  marketValue: number | null;
  floatingPnl: number | null;
  floatingPnlPercent: number | null;

  /** Price of the live exit order, when there is one. */
  targetPrice: number | null;
  /** Profit if the exit order fills at its limit price. */
  potentialPnl: number | null;
  /** Percent the mark price must move to reach the target. */
  distanceToTargetPercent: number | null;

  /** "live" = exit order resting on the exchange, "abandoned" = exit cancelled/revoked, "missing" = no exit order at all. */
  exitState: "live" | "abandoned" | "missing";
  exitStatus: string | null;
  underwater: boolean;
};

/** An entry order that is resting but has not filled — no capital committed yet. */
export type PendingEntry = {
  smartTradeId: number;
  botId: number | null;
  symbol: string;
  side: string;
  price: number | null;
  quantity: number;
  status: string;
  createdAt: number;
  ageMs: number;
  /** Percent the mark price must move for this order to fill. */
  distanceToFillPercent: number | null;
};

export const EPSILON = 1e-9;

export const ENTRY_ENTITY_TYPES = ["EntryOrder", "SafetyOrder"] as const;
export const EXIT_ENTITY_TYPES = ["TakeProfitOrder", "StopLossOrder"] as const;

/** Order statuses that mean the order is resting on the exchange and can still fill. */
export const LIVE_ORDER_STATUSES = ["Idle", "Placed"] as const;
/** Order statuses that mean the order will never fill. */
export const DEAD_ORDER_STATUSES = ["Canceled", "Revoked", "Deleted"] as const;
