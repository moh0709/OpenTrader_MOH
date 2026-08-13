/**
 * Registry for trade operations that must execute inside the trading daemon.
 *
 * `@opentrader/bot` already imports `appRouter` from this package in order to
 * serve it, so this package cannot import `@opentrader/bot` back without
 * creating a cycle. Instead the contract is declared here and the daemon
 * registers its implementation on startup — dependency inversion across the
 * existing edge rather than a new one in the opposite direction.
 */

export type CloseMode = "market" | "limit";

export type CloseOutcome = "closed" | "canceled_unfilled" | "already_closed";

export type CloseTradeResult = {
  smartTradeId: number;
  botId: number | null;
  symbol: string;
  outcome: CloseOutcome;
  filled: boolean;
  exitQuantity?: number;
  exitPrice?: number | null;
  message: string;
};

export type TradeOps = {
  closeSmartTrade: (id: number, mode?: CloseMode) => Promise<CloseTradeResult>;
  closeBotTrades: (botId: number, mode?: CloseMode) => Promise<CloseTradeResult[]>;
  closeAllTrades: (mode?: CloseMode) => Promise<CloseTradeResult[]>;
};

let registered: TradeOps | null = null;

/** Called by the daemon during startup. */
export function registerTradeOps(ops: TradeOps): void {
  registered = ops;
}

export function getTradeOps(): TradeOps {
  if (!registered) {
    // Reaching this means the API is up but the trading daemon never started,
    // so there is nothing that could safely place an exit order.
    throw new Error(
      "Trade operations are unavailable: the trading daemon has not registered them. Is the daemon running?",
    );
  }

  return registered;
}

/** Test seam. */
export function resetTradeOps(): void {
  registered = null;
}
