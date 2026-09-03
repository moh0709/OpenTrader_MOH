import type { CouncilVerdict, MarketSnapshot } from "./types.js";

/**
 * The trading head's position planner.
 *
 * The risk governor in `governor.ts` answers one question — may this vote
 * become an order, and how big? That is the right question for a strategy that
 * only ever buys or sells on a candle close. It is not enough for something
 * running a book.
 *
 * A trader holding a position has a different job from a trader looking for
 * one. They are managing an exit: taking profit when it is there, cutting when
 * the reason for the trade stopped being true, trailing a winner rather than
 * giving it all back, and knowing that most minutes are not the minute to do
 * anything at all. This module is that job, written as a pure function so every
 * rule can be swept in tests rather than discovered in production.
 *
 * Three invariants hold for every input, and the tests prove them:
 *
 *   1. **Exits are considered before entries.** Whatever the council says about
 *      a new idea, a position already on the book is examined first.
 *   2. **The plan can only reduce risk relative to the limits.** No confidence,
 *      no evidence and no model output can size above the caps, spend past the
 *      daily budget, or open while a loss limit is tripped.
 *   3. **Every refusal states its reason**, so a quiet day is auditable rather
 *      than merely quiet.
 */

/** What the head decided to do about one symbol this pass. */
export type HeadAction =
  /** Do nothing. Most passes end here, and that is correct. */
  | "hold"
  /** Open a new position. */
  | "open"
  /** Add to a position already on. Requires `allowPyramiding`. */
  | "add"
  /** Close a winner at its profit target. */
  | "take_profit"
  /** Close a winner that has given back too much of its peak. */
  | "trail_exit"
  /** Close a loser at its stop. */
  | "stop_out"
  /** Close because the reason for the trade stopped being true. */
  | "close"
  /** Close because a portfolio-level loss limit tripped. */
  | "flatten";

/** Actions that place an exit order against a position we hold. */
export const EXIT_ACTIONS: readonly HeadAction[] = ["take_profit", "trail_exit", "stop_out", "close", "flatten"];

/** Actions that increase exposure. */
export const ENTRY_ACTIONS: readonly HeadAction[] = ["open", "add"];

export function isExit(action: HeadAction): boolean {
  return EXIT_ACTIONS.includes(action);
}

export function isEntry(action: HeadAction): boolean {
  return ENTRY_ACTIONS.includes(action);
}

/**
 * A position as the head sees it.
 *
 * `peakPrice` is reconstructed from the candle highs since entry rather than
 * remembered between passes. That is deliberate: a high-water mark held in
 * memory is wrong after every restart, and one held in a table is one more
 * thing to keep consistent with the exchange. The candles already know.
 */
export type OpenPosition = {
  smartTradeId: number;
  symbol: string;
  /** Base quantity held. */
  quantity: number;
  /** Average fill price of the entry. */
  entryPrice: number;
  /** Entry fee actually charged, in quote currency. */
  entryFeeQuote: number;
  openedAt: number;
  /** Highest price seen since entry. Falls back to the entry when unknown. */
  peakPrice: number;
  /** Price of the resting take profit, when one is working. */
  takeProfitPrice: number | null;
  /**
   * When the head last asked for this position to be closed, and how.
   *
   * The loop re-decides every minute, but an exit takes longer than that to
   * fill. Without this the head would look at a position it had already told
   * the exchange to sell, conclude it was still holding a loser, and ask again
   * — cancelling its own working exit and replacing it, once a minute, for as
   * long as the fill took. Null means no exit has been asked for.
   */
  exitRequestedAt: number | null;
  exitRequestedAction: HeadAction | null;
};

/**
 * The operator's limits. Hard numbers, enforced here, unreachable by any agent.
 */
export type HeadLimits = {
  /** Account equity in quote currency — the ceiling on everything. */
  equityQuote: number;
  /** Largest notional the head may put into one position. */
  maxPositionQuote: number;
  /** Largest total notional it may have open across all symbols. */
  maxTotalExposureQuote: number;
  /** Most positions it may hold at once. */
  maxOpenPositions: number;
  /** Most it may open in a day, summed across entries. Bounds a bad day. */
  maxDailyOpenNotionalQuote: number;
  /** Realised loss for the day that halts and flattens the book. */
  maxDailyLossQuote: number;
  /** Losing trades in a row that halt and flatten the book. */
  maxConsecutiveLosses: number;

  /**
   * Council confidence required to open.
   *
   * Worth knowing what this number means before changing it, because the
   * council's confidence is not a probability and does not use the whole range.
   * `tallyVotes` multiplies how aligned the voting agents are by the square root
   * of how much of the council voted at all, so a verdict is discounted twice:
   * once for disagreement, once for silence.
   *
   * In practice that puts a well-corroborated entry — the trend agent, the
   * outside technical read and the research council all leaning the same way,
   * with the oscillator neutral — at roughly 0.5 to 0.6. Two of the three agree
   * and the third is quiet: roughly 0.3. A default of 0.6 sounds prudent and is
   * in fact a head that never trades, which is not prudence, it is a different
   * kind of failure.
   */
  minConfidence: number;
  /** Council confidence required to close on a change of view alone. */
  minExitConfidence: number;

  /** Net profit, as a percentage of entry notional, that takes profit. */
  takeProfitPercent: number;
  /** Net loss, as a percentage of entry notional, that stops out. */
  stopLossPercent: number;
  /** Peak gain, in percent, after which the trail starts watching. */
  trailStartPercent: number;
  /** Giveback from the peak, in percent, that closes a trailing winner. */
  trailGivebackPercent: number;

  /** How long a position must be held before a change of view may close it. */
  minHoldMs: number;
  /** How long after acting on a symbol before the head may act on it again. */
  cooldownMs: number;
  /** A position older than this that is not in profit is closed as dead money. */
  maxHoldMs: number;

  /** Round-trip cost estimate in basis points, charged against every exit. */
  roundTripFeeBps: number;

  /** Add to a position already on. Off by default. */
  allowPyramiding: boolean;
  /**
   * Operator pause.
   *
   * Blocks new entries and leaves open positions under management. It is a
   * pause, not an abdication: a position whose stop has been switched off is
   * not paused, it is unmanaged, and that is the one state this desk must never
   * be in.
   */
  killSwitch: boolean;
};

export const DEFAULT_HEAD_LIMITS: HeadLimits = {
  equityQuote: 1000,
  maxPositionQuote: 100,
  maxTotalExposureQuote: 400,
  maxOpenPositions: 4,
  maxDailyOpenNotionalQuote: 600,
  maxDailyLossQuote: 50,
  maxConsecutiveLosses: 3,

  minConfidence: 0.45,
  minExitConfidence: 0.35,

  takeProfitPercent: 1.5,
  stopLossPercent: 2.5,
  trailStartPercent: 1.0,
  trailGivebackPercent: 0.5,

  minHoldMs: 15 * 60 * 1000,
  cooldownMs: 10 * 60 * 1000,
  maxHoldMs: 5 * 24 * 60 * 60 * 1000,

  roundTripFeeBps: 55,

  allowPyramiding: false,
  killSwitch: false,
};

/** The state of the book the head is trading. */
export type HeadPortfolio = {
  /** Notional currently at risk, in quote currency. */
  openExposureQuote: number;
  /** How many positions are open, across all symbols. */
  openPositions: number;
  /** Realised profit and loss since the start of the trading day. */
  realizedPnlToday: number;
  /** Notional opened today. Bounds the damage of a bad day of decisions. */
  openedNotionalToday: number;
  /** Losing trades closed in a row. */
  consecutiveLosses: number;
  /** Epoch ms the head last acted on this symbol, or null if never. */
  lastActionAt: number | null;
};

export type HeadPlan = {
  symbol: string;
  action: HeadAction;
  /** Notional to commit, for an entry. Zero for everything else. */
  sizeQuote: number;
  /** Base quantity to exit, for an exit. Zero for everything else. */
  quantity: number;
  /** The deal to act on, for an exit. */
  smartTradeId: number | null;
  /** Council confidence behind this, 0..1. */
  confidence: number;
  /** One sentence a human can read in the feed. */
  reason: string;
  /** Everything considered along the way, for the audit trail. */
  notes: string[];
  /**
   * How much the head wants this filled.
   *
   * `now` crosses the spread and pays the taker fee, and is what a stop or a
   * flatten needs — being out matters more than the price. `patient` rests on
   * the passive side for the maker fee, which is right for taking a profit that
   * is not running away.
   */
  urgency: "now" | "patient";
  /** Net profit on the position at the current price, when one is held. */
  netPnlQuote: number | null;
};

/** Net profit on a long position at `price`, after the entry fee and an estimated exit fee. */
export function netProfit(position: OpenPosition, price: number, roundTripFeeBps: number): number {
  const gross = (price - position.entryPrice) * position.quantity;
  // Half the round trip is assumed already paid at entry and charged as the
  // fee actually recorded; the other half is the exit still to come.
  const exitFee = price * position.quantity * (roundTripFeeBps / 2 / 10_000);

  return gross - position.entryFeeQuote - exitFee;
}

/** That profit as a percentage of what was staked. */
export function netProfitPercent(position: OpenPosition, price: number, roundTripFeeBps: number): number {
  const staked = position.entryPrice * position.quantity;
  if (staked <= 0) return 0;

  return (netProfit(position, price, roundTripFeeBps) / staked) * 100;
}

function plan(base: Partial<HeadPlan> & { symbol: string; action: HeadAction; reason: string; notes: string[] }): HeadPlan {
  return {
    sizeQuote: 0,
    quantity: 0,
    smartTradeId: null,
    confidence: 0,
    urgency: "now",
    netPnlQuote: null,
    ...base,
  };
}

/**
 * Decide what to do about one symbol.
 *
 * Ordering is the design. Portfolio-level halts come first because they are the
 * only rules that can override everything else; then the management of a
 * position already held; then, and only then, the question of a new one. A head
 * that looks for entries before checking its exits is a head that adds to a
 * losing book.
 */
export function planPosition(
  snapshot: MarketSnapshot,
  verdict: CouncilVerdict,
  position: OpenPosition | null,
  limits: HeadLimits,
  portfolio: HeadPortfolio,
  now = Date.now(),
): HeadPlan {
  const notes: string[] = [];
  const price = snapshot.price;
  const symbol = snapshot.symbol;

  const held = position && position.quantity > 0 ? position : null;
  const pnl = held ? netProfit(held, price, limits.roundTripFeeBps) : null;
  const pnlPercent = held ? netProfitPercent(held, price, limits.roundTripFeeBps) : null;

  const exit = (action: HeadAction, reason: string, urgency: HeadPlan["urgency"] = "now"): HeadPlan =>
    plan({
      symbol,
      action,
      reason,
      notes,
      quantity: held!.quantity,
      smartTradeId: held!.smartTradeId,
      confidence: verdict.confidence,
      urgency,
      netPnlQuote: pnl,
    });

  const stand = (reason: string): HeadPlan =>
    plan({ symbol, action: "hold", reason, notes, confidence: verdict.confidence, netPnlQuote: pnl });

  /*
   * Is an exit already working?
   *
   * `cooldownMs` doubles as the window here rather than earning its own knob:
   * it is already the operator's answer to "how long should the desk leave a
   * decision alone before revisiting it", and an exit is a decision.
   *
   * One escalation is allowed through. A patient limit exit resting at a profit
   * target may never fill, and if the market collapses through the stop while
   * it sits there, waiting out the window is exactly the wrong thing. So an
   * urgent exit may override a patient one — but never another urgent one,
   * which is what bounds this to a single retry rather than a loop.
   */
  const exitAge = held?.exitRequestedAt === null || held?.exitRequestedAt === undefined ? null : now - held.exitRequestedAt;
  const exitInFlight = exitAge !== null && exitAge >= 0 && exitAge < limits.cooldownMs;
  const lastExitWasUrgent = held?.exitRequestedAction === "stop_out" || held?.exitRequestedAction === "flatten";

  /** True when we may ask again despite an exit being in flight. */
  const mayEscalate = (): boolean => exitInFlight && !lastExitWasUrgent;

  const holdingForFill = (): HeadPlan =>
    stand(
      `An exit is already working on ${symbol} (asked ${((exitAge ?? 0) / 60_000).toFixed(0)} min ago); leaving it to fill.`,
    );

  // --- Portfolio halts ------------------------------------------------------
  //
  // A tripped loss limit does not merely stop new trades. Whatever is already
  // on is exactly the thing the limit existed to protect against, so the book
  // gets flat. A halt that leaves the losing position riding is not a halt.

  const dailyLossTripped = portfolio.realizedPnlToday <= -limits.maxDailyLossQuote;
  const lossStreakTripped = portfolio.consecutiveLosses >= limits.maxConsecutiveLosses;

  if (dailyLossTripped || lossStreakTripped) {
    const reason = dailyLossTripped
      ? `Daily loss limit reached (${portfolio.realizedPnlToday.toFixed(2)} against a ${limits.maxDailyLossQuote} budget)`
      : `${portfolio.consecutiveLosses} losing trades in a row reached the limit of ${limits.maxConsecutiveLosses}`;

    notes.push(reason);

    if (held) {
      // A flatten is urgent, so it may escalate a patient exit — but if the
      // last request was already urgent, asking again only churns orders.
      if (exitInFlight && lastExitWasUrgent) return holdingForFill();

      return exit("flatten", `${reason}. Closing ${symbol} and standing down for the day.`);
    }

    return stand(`${reason}. Not opening anything else today.`);
  }

  // --- Managing what we hold ------------------------------------------------

  if (held) {
    const ageMs = now - held.openedAt;
    const peak = Math.max(held.peakPrice, price, held.entryPrice);
    const peakGainPercent = ((peak - held.entryPrice) / held.entryPrice) * 100;
    const givebackPercent = ((peak - price) / peak) * 100;

    notes.push(
      `Holding ${held.quantity} since ${new Date(held.openedAt).toISOString()}; ` +
        `net ${pnl!.toFixed(2)} (${pnlPercent!.toFixed(2)}%), peak gain ${peakGainPercent.toFixed(2)}%`,
    );

    // A stop is checked before anything else, and is not subject to the minimum
    // hold time. A position that gaps through its stop in the first minute is
    // the one case where waiting costs the most.
    if (pnlPercent! <= -limits.stopLossPercent) {
      if (exitInFlight && !mayEscalate()) return holdingForFill();

      return exit(
        "stop_out",
        `Stopped out of ${symbol} at ${pnlPercent!.toFixed(2)}%, past the ${limits.stopLossPercent}% limit.`,
      );
    }

    // Everything below this line is a discretionary exit — a target reached, a
    // trail given back, a view changed. None of them is urgent enough to
    // replace an order that is already working.
    if (exitInFlight) return holdingForFill();

    // Take profit is unconditional on the council. The trade made what it was
    // asked to make; asking the committee whether to keep going is how a
    // winner becomes a loser.
    if (pnlPercent! >= limits.takeProfitPercent) {
      return exit(
        "take_profit",
        `Took ${pnl!.toFixed(2)} on ${symbol} at ${pnlPercent!.toFixed(2)}%, its target.`,
        // Patient only while the trend is still with us — a profit target hit
        // into a council that has turned should be taken now, not rested.
        verdict.signal === "sell" ? "now" : "patient",
      );
    }

    // Trailing. Only arms after a real gain, and only fires while the position
    // is still net positive: giving back to break-even is not a win to protect.
    if (peakGainPercent >= limits.trailStartPercent && givebackPercent >= limits.trailGivebackPercent && pnl! > 0) {
      return exit(
        "trail_exit",
        `${symbol} gave back ${givebackPercent.toFixed(2)}% from its peak; banked ${pnl!.toFixed(2)}.`,
      );
    }

    // Dead money. A position that has been open for days without reaching
    // either target is capital that could be working somewhere else.
    if (ageMs > limits.maxHoldMs && pnl! <= 0) {
      return exit(
        "close",
        `${symbol} has been open ${(ageMs / 86_400_000).toFixed(1)} days without working; releasing the capital.`,
      );
    }

    // The council changed its mind. This is the only exit that needs both
    // conviction and patience — a position closed on the first wobble never
    // gets the chance to be right.
    if (verdict.signal === "sell" && verdict.confidence >= limits.minExitConfidence) {
      if (ageMs < limits.minHoldMs) {
        notes.push(
          `Council turned bearish but the position is only ${(ageMs / 60_000).toFixed(0)} min old ` +
            `(minimum ${(limits.minHoldMs / 60_000).toFixed(0)} min)`,
        );
      } else {
        return exit(
          "close",
          `Council turned ${verdict.signal} on ${symbol} at ${Math.round(verdict.confidence * 100)}% confidence; stepping out.`,
        );
      }
    }

    if (!limits.allowPyramiding) {
      return stand(`Holding ${symbol} at ${pnlPercent!.toFixed(2)}%; nothing to do.`);
    }
  }

  // --- Looking for a new one ------------------------------------------------

  if (limits.killSwitch) return stand("Kill switch is on: managing what is open, opening nothing new.");

  if (verdict.vetoed) return stand(`Risk analyst vetoed: ${verdict.vetoReason}`);

  if (verdict.signal !== "buy") {
    return stand(held ? `Holding ${symbol}; the council is not asking for more.` : `No entry on ${symbol}: ${verdict.rationale}`);
  }

  if (verdict.confidence < limits.minConfidence) {
    return stand(
      `Council likes ${symbol} but only at ${Math.round(verdict.confidence * 100)}%, under the ${Math.round(limits.minConfidence * 100)}% bar.`,
    );
  }

  // Timing. The head re-decides every minute; without this it would act on the
  // same idea repeatedly while the evidence behind it has not moved at all.
  if (portfolio.lastActionAt !== null && now - portfolio.lastActionAt < limits.cooldownMs) {
    const waitMin = (limits.cooldownMs - (now - portfolio.lastActionAt)) / 60_000;

    return stand(`Acted on ${symbol} recently; waiting ${waitMin.toFixed(0)} more min before touching it again.`);
  }

  /*
   * The outside veto.
   *
   * The council already weighed the external technical read as one vote among
   * several, so a strong enough consensus can outvote it. This is the second
   * bite: an entry into a market that a broad, independent, multi-timeframe read
   * says is falling gets refused outright, however the vote went. Corroboration
   * is optional; contradiction is disqualifying.
   */
  const tv = snapshot.technical;
  if (tv && tv.rating <= -0.1 && tv.alignment >= 0.6 && tv.timeframes >= 3) {
    return stand(
      `Not buying ${symbol} into a ${tv.label.replace(/_/g, " ")} reading across ${tv.timeframes} timeframes.`,
    );
  }

  if (held && !limits.allowPyramiding) {
    return stand(`Already long ${symbol}; adding is switched off.`);
  }

  // --- Budgets. Every one of these can only make the size smaller. ----------

  if (!held && portfolio.openPositions >= limits.maxOpenPositions) {
    return stand(`Already holding ${portfolio.openPositions} positions, the most allowed.`);
  }

  const exposureHeadroom = limits.maxTotalExposureQuote - portfolio.openExposureQuote;
  if (exposureHeadroom <= 0) {
    return stand(
      `No exposure headroom: ${portfolio.openExposureQuote.toFixed(2)} of ${limits.maxTotalExposureQuote} already committed.`,
    );
  }

  const dailyHeadroom = limits.maxDailyOpenNotionalQuote - portfolio.openedNotionalToday;
  if (dailyHeadroom <= 0) {
    return stand(
      `Today's opening budget is spent (${portfolio.openedNotionalToday.toFixed(2)} of ${limits.maxDailyOpenNotionalQuote}).`,
    );
  }

  // Conviction scales size downward from the cap. Full confidence buys exactly
  // the maximum and never more.
  let sizeQuote = limits.maxPositionQuote * verdict.confidence;

  const clamp = (ceiling: number, label: string) => {
    if (sizeQuote > ceiling) {
      notes.push(`reduced from ${sizeQuote.toFixed(2)} to ${ceiling.toFixed(2)} (${label})`);
      sizeQuote = ceiling;
    }
  };

  clamp(limits.maxPositionQuote, "per-position cap");
  clamp(exposureHeadroom, "remaining exposure headroom");
  clamp(dailyHeadroom, "today's opening budget");
  clamp(limits.equityQuote, "available equity");

  if (sizeQuote <= 0) return stand("Position size resolved to zero once the limits were applied.");

  if (price <= 0) return stand("No usable price; refusing to size a trade against it.");

  const percent = Math.round(verdict.confidence * 100);
  const external = tv ? ` ${tv.source} rates it ${tv.label.replace(/_/g, " ")}.` : "";

  return plan({
    symbol,
    action: held ? "add" : "open",
    sizeQuote,
    quantity: sizeQuote / price,
    confidence: verdict.confidence,
    reason: `${held ? "Adding to" : "Opening"} ${symbol}: council is buy at ${percent}% confidence.${external}`,
    notes,
    // Entries are not urgent by nature, but a market order is the only one that
    // is certainly on before the reason to be on has passed.
    urgency: "now",
    netPnlQuote: pnl,
  });
}

/** One-line audit record for a plan, written whether or not it traded. */
export function describeHeadPlan(plan: HeadPlan): string {
  const head =
    plan.action === "hold"
      ? `HOLD ${plan.symbol}`
      : isEntry(plan.action)
        ? `${plan.action.toUpperCase()} ${plan.symbol} size=${plan.sizeQuote.toFixed(2)} conf=${plan.confidence.toFixed(2)}`
        : `${plan.action.toUpperCase()} ${plan.symbol} qty=${plan.quantity} deal=${plan.smartTradeId} net=${plan.netPnlQuote?.toFixed(2) ?? "n/a"}`;

  const notes = plan.notes.length > 0 ? ` | ${plan.notes.join("; ")}` : "";

  return `${head} — ${plan.reason}${notes}`;
}
