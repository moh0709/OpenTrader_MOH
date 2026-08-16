/**
 * Types for the regime layer — the bridge between a daily research council and
 * bots that tick every minute.
 *
 * The council (TradingAgents) answers one question per symbol per run: which way
 * is this market leaning, and how sure are we? That answer cannot be a trade
 * signal — a run takes minutes and costs real money, while a grid bot re-decides
 * every 60 seconds. What it *can* be is a **regime**: a standing view that
 * modulates how much capital the bots underneath it are allowed to commit.
 *
 * A grid bot is already a complete entry/exit machine. The thing it cannot do
 * for itself is notice that the regime turned against it and stop buying into a
 * downtrend. That is the whole job of this layer.
 */

/**
 * The council's directional view.
 *
 * Deliberately coarse. A daily research process cannot justify finer gradation
 * than this, and pretending otherwise would invite the governor to act on
 * precision that was never there.
 */
export type Stance = "strong_buy" | "buy" | "hold" | "sell" | "strong_sell";

export const STANCES: readonly Stance[] = ["strong_buy", "buy", "hold", "sell", "strong_sell"];

/** One research run's conclusion about one symbol. */
export type Conviction = {
  /** Exchange symbol as the bots know it, e.g. "BTC/USDT". */
  symbol: string;
  stance: Stance;
  /** 0..1. Scales how *deeply* the governor reduces, never whether it may raise. */
  confidence: number;
  /** Epoch ms of the run that produced this. Used for the staleness guard. */
  asOf: number;
  /** One-paragraph human summary, shown on the dashboard. */
  summary: string;
  /** Model that produced the final call, recorded so a degraded run is visible. */
  model?: string;
  /** Spend for the run, surfaced in the research log. */
  costUsd?: number;
};

/**
 * Per-bot operator settings.
 *
 * `baselineMaxCapital` is the operator's intent and the governor's ceiling. It
 * is held here rather than read back from `Bot.maxCapital` because the governor
 * *writes* that column — reading its own output as the baseline would let a
 * reduction compound on every poll until the bot was throttled to nothing.
 */
export type RegimePolicy = {
  botId: number;
  /**
   * The cap the operator chose. Null means the bot is not under management:
   * with no ceiling there is nothing to reduce from, and inventing one would be
   * the governor adding a restriction the operator never asked for.
   */
  baselineMaxCapital: number | null;
  baselineMinProfit: number | null;
  /** Off means every decision resolves to baseline. The instant-revert switch. */
  armed: boolean;
  /** Deepest reduction allowed, as a fraction of baseline. 0..1. */
  floorFactor: number;
  /** A conviction older than this reverts to baseline. */
  maxAgeMs: number;
};

/**
 * The floor, in quote currency, for any cap the governor writes.
 *
 * This exists because of a genuine footgun in `bot-limits.ts`: `toLimit()`
 * treats zero and negatives as *"not set"*, which means **no cap at all**. The
 * intuitive way to say "stop trading" — writing zero — would therefore remove
 * the limit entirely and let the bot commit its whole balance.
 *
 * A small positive number says it correctly instead: `allowsEntry` compares
 * `committed + notional` against the cap, and any real order exceeds 1 unit of
 * quote currency, so every new entry is refused while open positions keep their
 * exits and close normally.
 */
export const REGIME_FLOOR_QUOTE = 1;

/** Convictions older than this are ignored. Just over a day, so one missed run is tolerated. */
export const DEFAULT_MAX_AGE_MS = 26 * 60 * 60 * 1000;

export const DEFAULT_FLOOR_FACTOR = 0.1;

/**
 * How far each stance is willing to pull capital back, at full confidence.
 *
 * Everything bullish and neutral is 1.0. That is not an oversight — this layer
 * is not allowed to express optimism, because expressing optimism means raising
 * a limit, and raising a limit is the one thing it must never do. A bullish
 * council simply declines to interfere.
 */
export const STANCE_FACTOR: Record<Stance, number> = {
  strong_buy: 1,
  buy: 1,
  hold: 1,
  sell: 0.5,
  strong_sell: DEFAULT_FLOOR_FACTOR,
};

/** What the governor decided for one bot, and why. */
export type RegimeDecision = {
  botId: number;
  /** The value to write to `Bot.maxCapital`. Null means leave uncapped. */
  maxCapital: number | null;
  /** The multiple of baseline actually applied, 0..1. */
  factor: number;
  /** True when this is below baseline — i.e. the governor is actively throttling. */
  reduced: boolean;
  /** Every reason, so a decision can be audited without re-running it. */
  notes: string[];
};

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export const DEFAULT_POLICY: Omit<RegimePolicy, "botId" | "baselineMaxCapital" | "baselineMinProfit"> = {
  armed: true,
  floorFactor: DEFAULT_FLOOR_FACTOR,
  maxAgeMs: DEFAULT_MAX_AGE_MS,
};
