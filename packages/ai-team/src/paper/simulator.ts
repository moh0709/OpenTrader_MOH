import { applyRiskGovernor } from "../governor.js";
import { convene, type CouncilOptions } from "../council.js";
import type { AgentOpinion, Candle, MarketSnapshot, PortfolioState, RiskLimits, Signal, TradeDecision } from "../types.js";

export type PaperFill = {
  timestamp: number;
  side: Signal;
  price: number;
  quantity: number;
  notional: number;
  feeQuote: number;
  /** Realised PnL booked by this fill; only sells realise. */
  realizedPnl: number;
};

export type PaperAccount = {
  cashQuote: number;
  positionBase: number;
  /** Volume-weighted average entry price of the open position. */
  avgEntry: number;
  realizedPnl: number;
  consecutiveLosses: number;
  fills: PaperFill[];
};

export type PaperConfig = {
  startingCashQuote: number;
  /** Taker fee charged on both sides, in basis points. */
  feeBps: number;
  /** Adverse price movement applied to every fill, in basis points. */
  slippageBps: number;
};

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  startingCashQuote: 1000,
  feeBps: 10,
  slippageBps: 5,
};

export function createAccount(config: PaperConfig): PaperAccount {
  return {
    cashQuote: config.startingCashQuote,
    positionBase: 0,
    avgEntry: 0,
    realizedPnl: 0,
    consecutiveLosses: 0,
    fills: [],
  };
}

/**
 * Apply a decision to the paper account.
 *
 * Fills are charged both a fee and adverse slippage, so a strategy that only
 * wins by a basis point or two shows up here as a loser — which is the point.
 * Returns the fill, or null when the order could not be afforded or there was
 * nothing to sell.
 */
export function executeFill(
  account: PaperAccount,
  config: PaperConfig,
  side: Signal,
  sizeQuote: number,
  marketPrice: number,
  timestamp: number,
): PaperFill | null {
  if (side === "hold" || sizeQuote <= 0 || marketPrice <= 0) return null;

  const slip = config.slippageBps / 10_000;
  // Slippage always works against us: buys fill higher, sells fill lower.
  const price = side === "buy" ? marketPrice * (1 + slip) : marketPrice * (1 - slip);

  if (side === "buy") {
    const affordable = Math.min(sizeQuote, account.cashQuote);
    const quantity = affordable / (price * (1 + config.feeBps / 10_000));
    if (quantity <= 0) return null;

    const notional = quantity * price;
    const feeQuote = notional * (config.feeBps / 10_000);
    if (notional + feeQuote > account.cashQuote + 1e-9) return null;

    // Weighted average entry across the combined position.
    const newPosition = account.positionBase + quantity;
    account.avgEntry = newPosition > 0 ? (account.avgEntry * account.positionBase + price * quantity) / newPosition : 0;
    account.positionBase = newPosition;
    account.cashQuote -= notional + feeQuote;

    const fill: PaperFill = { timestamp, side, price, quantity, notional, feeQuote, realizedPnl: 0 };
    account.fills.push(fill);
    return fill;
  }

  // Sell — long-only, so we can never sell more than we hold.
  const quantity = Math.min(sizeQuote / price, account.positionBase);
  if (quantity <= 1e-12) return null;

  const notional = quantity * price;
  const feeQuote = notional * (config.feeBps / 10_000);
  const realizedPnl = (price - account.avgEntry) * quantity - feeQuote;

  account.positionBase -= quantity;
  account.cashQuote += notional - feeQuote;
  account.realizedPnl += realizedPnl;
  if (account.positionBase <= 1e-12) account.avgEntry = 0;

  account.consecutiveLosses = realizedPnl < 0 ? account.consecutiveLosses + 1 : 0;

  const fill: PaperFill = { timestamp, side, price, quantity, notional, feeQuote, realizedPnl };
  account.fills.push(fill);
  return fill;
}

export function equity(account: PaperAccount, marketPrice: number): number {
  return account.cashQuote + account.positionBase * marketPrice;
}

export type ReplayStep = {
  index: number;
  timestamp: number;
  price: number;
  decision: TradeDecision;
  fill: PaperFill | null;
  equity: number;
};

export type ReplayResult = {
  steps: ReplayStep[];
  account: PaperAccount;
  startingEquity: number;
  finalEquity: number;
  returnPct: number;
  /** Buy-and-hold over the same window, for comparison. */
  buyHoldReturnPct: number;
  trades: number;
  wins: number;
  losses: number;
  decisionsConsidered: number;
  tradesRejectedByRisk: number;
};

export type ReplayOptions = {
  limits: RiskLimits;
  paper?: PaperConfig;
  council?: CouncilOptions;
  /** Candles required before the council is allowed to vote. */
  warmup?: number;
  /** Per-step arbitrage evaluation, when a live scan is being replayed. */
  arbForStep?: (index: number) => MarketSnapshot["arb"];
  onStep?: (step: ReplayStep) => void;
};

/**
 * Replay a candle series through the full decision pipeline.
 *
 * At step i the council sees only candles[0..i] — no look-ahead — so the result
 * is what the system would have produced live on this data.
 */
export async function replay(symbol: string, candles: Candle[], options: ReplayOptions): Promise<ReplayResult> {
  const paperConfig = options.paper ?? DEFAULT_PAPER_CONFIG;
  const warmup = options.warmup ?? 35;
  const account = createAccount(paperConfig);

  const steps: ReplayStep[] = [];
  let decisionsConsidered = 0;
  let tradesRejectedByRisk = 0;

  for (let i = warmup; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const price = window[window.length - 1].close;
    const timestamp = window[window.length - 1].timestamp;

    const snapshot: MarketSnapshot = {
      symbol,
      price,
      candles: window,
      arb: options.arbForStep?.(i) ?? null,
    };

    const portfolio: PortfolioState = {
      openExposureQuote: account.positionBase * price,
      realizedPnlToday: account.realizedPnl,
      consecutiveLosses: account.consecutiveLosses,
      equityQuote: equity(account, price),
    };

    const verdict = await convene(snapshot, options.limits, portfolio, options.council ?? {});
    const decision = applyRiskGovernor(verdict, options.limits, portfolio);

    decisionsConsidered++;
    if (!decision.approved && verdict.signal !== "hold") tradesRejectedByRisk++;

    const fill = decision.approved ? executeFill(account, paperConfig, decision.signal, decision.sizeQuote, price, timestamp) : null;

    const step: ReplayStep = { index: i, timestamp, price, decision, fill, equity: equity(account, price) };
    steps.push(step);
    options.onStep?.(step);
  }

  const firstPrice = candles[warmup]?.close ?? candles[0].close;
  const lastPrice = candles[candles.length - 1].close;
  const startingEquity = paperConfig.startingCashQuote;
  const finalEquity = equity(account, lastPrice);

  const sells = account.fills.filter((f) => f.side === "sell");

  return {
    steps,
    account,
    startingEquity,
    finalEquity,
    returnPct: ((finalEquity - startingEquity) / startingEquity) * 100,
    buyHoldReturnPct: ((lastPrice - firstPrice) / firstPrice) * 100,
    trades: account.fills.length,
    wins: sells.filter((f) => f.realizedPnl > 0).length,
    losses: sells.filter((f) => f.realizedPnl < 0).length,
    decisionsConsidered,
    tradesRejectedByRisk,
  };
}

/** A council stub for tests and dry runs — always returns the given opinion. */
export function fixedLlmAnalyst(opinion: AgentOpinion | null) {
  return async () => opinion;
}
