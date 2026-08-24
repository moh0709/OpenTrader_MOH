export type TrailingState = {
  active: boolean;
  highestPrice: number;
  trailPrice?: number;
  activatedAt?: number;
};

export type TrailingConfig = {
  entryPrice: number;
  quantity: number;
  entryFee: number;
  minProfit: number;
  exitFeeRate: number;
  atrMultiplier: number;
  minTrailDistance: number;
  activationAtrMultiple: number;
};

export type TrailingMarket = {
  price: number;
  atr: number;
  timestamp?: number;
};

export type TrailingAction = "hold" | "activate" | "raise" | "exit";

export type TrailingDecision = {
  action: TrailingAction;
  state: TrailingState;
  exitPrice?: number;
};

/** Net P&L after entry and estimated exit fees for a long position. */
export function netProfitAt(price: number, config: TrailingConfig): number {
  const gross = (price - config.entryPrice) * config.quantity;
  const exitFee = price * config.quantity * config.exitFeeRate;
  return gross - config.entryFee - exitFee;
}

/**
 * Pure adaptive trailing policy. It never lowers an existing trail and never
 * requests an exit below the configured fee-aware profit floor.
 */
export function evaluateTrailing(
  previous: TrailingState,
  config: TrailingConfig,
  market: TrailingMarket,
): TrailingDecision {
  const price = market.price;
  const atr = Math.max(market.atr, 0);
  const state: TrailingState = {
    ...previous,
    highestPrice: Math.max(previous.highestPrice, price),
  };
  const distance = Math.max(atr * config.atrMultiplier, config.minTrailDistance);
  const candidateTrail = state.highestPrice - distance;
  const currentTrail = state.trailPrice;

  if (!state.active) {
    const movedEnough = price - config.entryPrice >= atr * config.activationAtrMultiple;
    const profitableEnough = netProfitAt(price, config) >= config.minProfit;

    if (!movedEnough || !profitableEnough) {
      return { action: "hold", state };
    }

    return {
      action: "activate",
      state: {
        ...state,
        active: true,
        trailPrice: candidateTrail,
        activatedAt: market.timestamp,
      },
    };
  }

  const raisedTrail = Math.max(currentTrail ?? Number.NEGATIVE_INFINITY, candidateTrail);
  const nextState = { ...state, trailPrice: raisedTrail };

  if (price <= raisedTrail && netProfitAt(price, config) >= config.minProfit) {
    return { action: "exit", state: nextState, exitPrice: price };
  }

  if (raisedTrail > (currentTrail ?? Number.NEGATIVE_INFINITY)) {
    return { action: "raise", state: nextState };
  }

  return { action: "hold", state: nextState };
}
