import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEAD_LIMITS,
  isEntry,
  isExit,
  minTicketQuote,
  netProfitPercent,
  planPosition,
  type HeadLimits,
  type HeadPortfolio,
  type OpenPosition,
} from "./head.js";
import type { Candle, CouncilVerdict, MarketSnapshot } from "./types.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function candles(count = 40, price = 100): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 1,
    timestamp: NOW - (count - i) * 60_000,
  }));
}

function snapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return { symbol: "BTC/USDT", price: 100, candles: candles(), ...overrides };
}

function verdict(overrides: Partial<CouncilVerdict> = {}): CouncilVerdict {
  return {
    signal: "buy",
    confidence: 0.8,
    opinions: [],
    rationale: "buy by weighted vote",
    vetoed: false,
    ...overrides,
  };
}

function portfolio(overrides: Partial<HeadPortfolio> = {}): HeadPortfolio {
  return {
    openExposureQuote: 0,
    openPositions: 0,
    realizedPnlToday: 0,
    openedNotionalToday: 0,
    consecutiveLosses: 0,
    lastActionAt: null,
    ...overrides,
  };
}

function position(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    smartTradeId: 42,
    symbol: "BTC/USDT",
    quantity: 1,
    entryPrice: 100,
    entryFeeQuote: 0.2,
    openedAt: NOW - 2 * HOUR,
    peakPrice: 100,
    takeProfitPrice: null,
    exitRequestedAt: null,
    exitRequestedAction: null,
    ...overrides,
  };
}

/** Zero fees, so a test about a rule is not also a test about arithmetic. */
const FREE: HeadLimits = { ...DEFAULT_HEAD_LIMITS, roundTripFeeBps: 0 };

/**
 * A cap with room above the minimum ticket.
 *
 * At the shipped cap of 100 the `minNetProfitQuote` floor works out to exactly
 * 100 as well, so conviction has nowhere to scale and every trade is the cap.
 * That is correct and deliberate, and it is covered on its own below — but it
 * makes the cap a bad fixture for testing the sizing rules, because every
 * answer is 100 whatever the question was.
 */
const ROOMY: HeadLimits = { ...FREE, maxPositionQuote: 250 };

describe("planPosition — opening", () => {
  it("opens on a confident buy and sizes below the cap", () => {
    const plan = planPosition(snapshot(), verdict({ confidence: 0.8 }), null, ROOMY, portfolio(), NOW);

    expect(plan.action).toBe("open");
    expect(plan.sizeQuote).toBeCloseTo(200, 5);
    expect(plan.quantity).toBeCloseTo(2, 5);
    expect(isEntry(plan.action)).toBe(true);
  });

  it("never sizes below the ticket that could earn the floor", () => {
    // 0.5 of a 250 cap is 125, comfortably over the 100 minimum.
    expect(planPosition(snapshot(), verdict({ confidence: 0.5 }), null, ROOMY, portfolio(), NOW).sizeQuote).toBeCloseTo(
      125,
      5,
    );

    // 0.46 of it is 115 — still over. Conviction scales inside the band.
    expect(
      planPosition(snapshot(), verdict({ confidence: 0.46 }), null, ROOMY, portfolio(), NOW).sizeQuote,
    ).toBeCloseTo(115, 5);

    // At the shipped cap the floor and the cap meet, so conviction cannot
    // scale at all and every trade is 100. Worth asserting rather than
    // discovering: it means the entry bar, not the ticket, is what an operator
    // on the defaults is actually tuning.
    const atCap = planPosition(snapshot(), verdict({ confidence: 0.5 }), null, FREE, portfolio(), NOW);
    expect(atCap.sizeQuote).toBeCloseTo(FREE.maxPositionQuote, 5);
  });

  it("refuses outright when the cap cannot fund the floor", () => {
    // A $3 floor at a 3% target needs $100. A $50 cap can never get there, and
    // the head says which of the two numbers to change rather than sizing to
    // something that cannot pay.
    const tooSmall: HeadLimits = { ...FREE, maxPositionQuote: 50 };
    const plan = planPosition(snapshot(), verdict({ confidence: 1 }), null, tooSmall, portfolio(), NOW);

    expect(plan.action).toBe("hold");
    expect(plan.reason).toMatch(/over the 50 per-position cap/);
    expect(plan.reason).toMatch(/Raise the cap or lower the floor/);
  });

  it("refuses a buy under the confidence floor, and says so", () => {
    const plan = planPosition(snapshot(), verdict({ confidence: 0.3 }), null, FREE, portfolio(), NOW);

    expect(plan.action).toBe("hold");
    expect(plan.reason).toMatch(/under the 45% bar/);
  });

  it("opens at a confidence a real council actually reaches", () => {
    // Three agents leaning one way with the rest quiet lands around here. A
    // floor above this is a head that deliberates forever and never trades.
    expect(planPosition(snapshot(), verdict({ confidence: 0.5 }), null, FREE, portfolio(), NOW).action).toBe("open");
  });

  it("does not open on a sell or a hold", () => {
    for (const signal of ["sell", "hold"] as const) {
      expect(planPosition(snapshot(), verdict({ signal }), null, FREE, portfolio(), NOW).action).toBe("hold");
    }
  });

  it("respects the cooldown after acting on the same symbol", () => {
    const recent = portfolio({ lastActionAt: NOW - 60_000 });
    const plan = planPosition(snapshot(), verdict(), null, FREE, recent, NOW);

    expect(plan.action).toBe("hold");
    expect(plan.reason).toMatch(/waiting \d+ more min/);
  });

  it("acts again once the cooldown has passed", () => {
    const cooled = portfolio({ lastActionAt: NOW - FREE.cooldownMs - 1 });

    expect(planPosition(snapshot(), verdict(), null, FREE, cooled, NOW).action).toBe("open");
  });

  it("refuses to buy into a broad external downgrade whatever the vote said", () => {
    const bearish = snapshot({
      technical: {
        source: "tradingview",
        symbol: "BTC/USDT",
        ticker: "BINANCE:BTCUSDT",
        rating: -0.6,
        label: "strong_sell",
        byTimeframe: { "60": -0.6, "240": -0.5, "1D": -0.7 },
        alignment: 1,
        timeframes: 3,
        rsi: 30,
        adx: 30,
        close: 100,
        changePercent: -3,
        asOf: NOW,
      },
    });

    const plan = planPosition(bearish, verdict({ confidence: 0.95 }), null, FREE, portfolio(), NOW);

    expect(plan.action).toBe("hold");
    expect(plan.reason).toMatch(/strong sell reading across 3 timeframes/);
  });

  it("is not blocked by a narrow or mildly negative external read", () => {
    const mild = snapshot({
      technical: {
        source: "tradingview",
        symbol: "BTC/USDT",
        ticker: "BINANCE:BTCUSDT",
        rating: -0.2,
        label: "sell",
        byTimeframe: { "60": -0.2, "240": 0.1 },
        alignment: 0.5,
        timeframes: 2,
        rsi: 45,
        adx: 15,
        close: 100,
        changePercent: -0.2,
        asOf: NOW,
      },
    });

    expect(planPosition(mild, verdict(), null, FREE, portfolio(), NOW).action).toBe("open");
  });

  it("will not add to an open position while pyramiding is off", () => {
    const plan = planPosition(snapshot(), verdict(), position(), FREE, portfolio({ openPositions: 1 }), NOW);

    expect(plan.action).toBe("hold");
  });

  it("adds when pyramiding is explicitly allowed", () => {
    const limits = { ...FREE, allowPyramiding: true };
    const plan = planPosition(
      snapshot(),
      verdict(),
      position(),
      limits,
      portfolio({ openPositions: 1, openExposureQuote: 100 }),
      NOW,
    );

    expect(plan.action).toBe("add");
  });
});

describe("planPosition — budgets can only reduce", () => {
  it("clamps to the remaining exposure headroom", () => {
    const tight = portfolio({ openExposureQuote: ROOMY.maxTotalExposureQuote - 150 });
    const plan = planPosition(snapshot(), verdict({ confidence: 1 }), null, ROOMY, tight, NOW);

    expect(plan.action).toBe("open");
    expect(plan.sizeQuote).toBeCloseTo(150, 5);
    expect(plan.notes.join(" ")).toMatch(/remaining exposure headroom/);
  });

  it("clamps to what is left of the day's opening budget", () => {
    const spent = portfolio({ openedNotionalToday: ROOMY.maxDailyOpenNotionalQuote - 120 });
    const plan = planPosition(snapshot(), verdict({ confidence: 1 }), null, ROOMY, spent, NOW);

    expect(plan.sizeQuote).toBeCloseTo(120, 5);
  });

  it("refuses when the headroom left is too thin to be worth trading", () => {
    // 30 of room is room for a trade, but not for one that can earn 3 at a 3%
    // target. Taking it would be spending the day's budget on a position that
    // cannot pay for itself.
    const tight = portfolio({ openExposureQuote: ROOMY.maxTotalExposureQuote - 30 });
    const plan = planPosition(snapshot(), verdict({ confidence: 1 }), null, ROOMY, tight, NOW);

    expect(plan.action).toBe("hold");
    expect(plan.reason).toMatch(/under the 100.00 needed/);
    expect(plan.reason).toMatch(/cannot pay/);
  });

  it("refuses once there is no headroom at all", () => {
    const full = portfolio({ openExposureQuote: DEFAULT_HEAD_LIMITS.maxTotalExposureQuote });

    expect(planPosition(snapshot(), verdict(), null, FREE, full, NOW).action).toBe("hold");
  });

  it("refuses past the position count limit", () => {
    const many = portfolio({ openPositions: DEFAULT_HEAD_LIMITS.maxOpenPositions });

    expect(planPosition(snapshot(), verdict(), null, FREE, many, NOW).reason).toMatch(/the most allowed/);
  });

  it("never sizes above any limit, across the whole confidence range", () => {
    for (let confidence = 0; confidence <= 1.0001; confidence += 0.05) {
      for (const exposure of [0, 100, 250, 399]) {
        for (const spentToday of [0, 200, 599]) {
          const plan = planPosition(
            snapshot(),
            verdict({ confidence }),
            null,
            FREE,
            portfolio({ openExposureQuote: exposure, openedNotionalToday: spentToday }),
            NOW,
          );

          expect(plan.sizeQuote).toBeLessThanOrEqual(FREE.maxPositionQuote + 1e-9);
          expect(plan.sizeQuote).toBeLessThanOrEqual(FREE.maxTotalExposureQuote - exposure + 1e-9);
          expect(plan.sizeQuote).toBeLessThanOrEqual(FREE.maxDailyOpenNotionalQuote - spentToday + 1e-9);
          expect(plan.sizeQuote).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe("planPosition — managing a position", () => {
  it("takes profit at the target without asking the council", () => {
    const plan = planPosition(
      snapshot({ price: 104 }),
      verdict({ signal: "buy", confidence: 0.9 }),
      position(),
      FREE,
      portfolio({ openPositions: 1, openExposureQuote: 100 }),
      NOW,
    );

    expect(plan.action).toBe("take_profit");
    expect(plan.smartTradeId).toBe(42);
    expect(plan.quantity).toBe(1);
    expect(plan.netPnlQuote).toBeCloseTo(3.8, 5);
    // A winner that is still trending can afford to rest on the passive side.
    expect(plan.urgency).toBe("patient");
  });

  it("takes that profit urgently when the council has turned", () => {
    const plan = planPosition(
      snapshot({ price: 104 }),
      verdict({ signal: "sell", confidence: 0.9 }),
      position(),
      FREE,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("take_profit");
    expect(plan.urgency).toBe("now");
  });

  it("stops out past the loss limit, even inside the minimum hold", () => {
    const fresh = position({ openedAt: NOW - 60_000 });
    const plan = planPosition(snapshot({ price: 97 }), verdict(), fresh, FREE, portfolio({ openPositions: 1 }), NOW);

    expect(plan.action).toBe("stop_out");
    expect(plan.urgency).toBe("now");
  });

  it("trails a winner that gives back too much of its peak", () => {
    // Ten units rather than one, so the 0.8% left on the table is 8 quote
    // units and clears the floor. On a single unit the same move is 80 cents,
    // which is the trade the floor exists to refuse — covered below.
    const ran = position({ quantity: 10, peakPrice: 102 });
    // 1.2% off a 102 peak, still net positive at 100.8.
    const plan = planPosition(snapshot({ price: 100.8 }), verdict(), ran, FREE, portfolio({ openPositions: 1 }), NOW);

    expect(plan.action).toBe("trail_exit");
    expect(plan.netPnlQuote).toBeGreaterThan(FREE.minNetProfitQuote);
  });

  it("does not trail a position back through break-even", () => {
    const ran = position({ peakPrice: 102 });
    const plan = planPosition(
      snapshot({ price: 99.5 }),
      verdict({ signal: "hold" }),
      ran,
      FREE,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("hold");
  });

  it("closes on a confident change of view once the minimum hold has passed", () => {
    const plan = planPosition(
      snapshot({ price: 100.5 }),
      verdict({ signal: "sell", confidence: 0.7 }),
      position(),
      FREE,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("close");
  });

  it("holds through a change of view while the position is still new", () => {
    const fresh = position({ openedAt: NOW - 60_000 });
    const plan = planPosition(
      snapshot({ price: 100.5 }),
      verdict({ signal: "sell", confidence: 0.7 }),
      fresh,
      FREE,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("hold");
    expect(plan.notes.join(" ")).toMatch(/minimum 15 min/);
  });

  it("releases capital from a position that has gone nowhere for too long", () => {
    const stale = position({ openedAt: NOW - DEFAULT_HEAD_LIMITS.maxHoldMs - HOUR });
    const plan = planPosition(
      snapshot({ price: 99.9 }),
      verdict({ signal: "hold" }),
      stale,
      FREE,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("close");
    expect(plan.reason).toMatch(/without working/);
  });

  it("leaves a long-held winner alone rather than closing it on age", () => {
    const stale = position({ openedAt: NOW - DEFAULT_HEAD_LIMITS.maxHoldMs - HOUR });
    // Up, but under the take-profit target, and not off a peak.
    const plan = planPosition(
      snapshot({ price: 101 }),
      verdict({ signal: "hold" }),
      stale,
      FREE,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("hold");
  });
});

describe("planPosition — portfolio halts", () => {
  it("flattens an open position when the daily loss limit trips", () => {
    const broke = portfolio({ realizedPnlToday: -DEFAULT_HEAD_LIMITS.maxDailyLossQuote, openPositions: 1 });
    const plan = planPosition(snapshot(), verdict(), position(), FREE, broke, NOW);

    expect(plan.action).toBe("flatten");
    expect(plan.quantity).toBe(1);
    expect(plan.smartTradeId).toBe(42);
  });

  it("flattens on a losing streak too", () => {
    const streak = portfolio({ consecutiveLosses: DEFAULT_HEAD_LIMITS.maxConsecutiveLosses, openPositions: 1 });

    expect(planPosition(snapshot(), verdict(), position(), FREE, streak, NOW).action).toBe("flatten");
  });

  it("opens nothing while a limit is tripped, even flat", () => {
    const broke = portfolio({ realizedPnlToday: -100 });
    const plan = planPosition(snapshot(), verdict({ confidence: 1 }), null, FREE, broke, NOW);

    expect(plan.action).toBe("hold");
    expect(plan.reason).toMatch(/Not opening anything else today/);
  });

  it("halts before it looks at anything else, however good the trade looks", () => {
    const broke = portfolio({ realizedPnlToday: -100, lastActionAt: null });
    const plan = planPosition(snapshot({ price: 200 }), verdict({ confidence: 1 }), null, FREE, broke, NOW);

    expect(plan.action).toBe("hold");
  });
});

describe("planPosition — the kill switch", () => {
  const paused: HeadLimits = { ...FREE, killSwitch: true };

  it("opens nothing", () => {
    const plan = planPosition(snapshot(), verdict({ confidence: 1 }), null, paused, portfolio(), NOW);

    expect(plan.action).toBe("hold");
    expect(plan.reason).toMatch(/Kill switch/);
  });

  it("keeps protecting a position that is already on", () => {
    const plan = planPosition(
      snapshot({ price: 97 }),
      verdict(),
      position(),
      paused,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    // A pause on new ideas is not a pause on the stop. An unmanaged position is
    // the one state this desk must never be in.
    expect(plan.action).toBe("stop_out");
    expect(isExit(plan.action)).toBe(true);
  });

  it("still takes a profit that is there", () => {
    const plan = planPosition(
      snapshot({ price: 104 }),
      verdict(),
      position(),
      paused,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("take_profit");
  });
});

describe("netProfitPercent", () => {
  it("charges the exit fee that has not been paid yet", () => {
    const held = position({ entryFeeQuote: 0.2 });
    // 100 -> 101 is 1.00 gross, less 0.20 entry fee and 0.2775 estimated exit fee.
    const percent = netProfitPercent(held, 101, 55);

    expect(percent).toBeLessThan(1);
    expect(percent).toBeCloseTo(0.52, 2);
  });

  it("reports zero rather than dividing by nothing on an empty position", () => {
    expect(netProfitPercent(position({ quantity: 0, entryPrice: 0 }), 100, 55)).toBe(0);
  });
});

/**
 * The head re-decides every minute; an exit takes longer than that to fill.
 *
 * Without this guard it would look at a position it had already told the
 * exchange to sell, conclude it was still holding a loser, and ask again —
 * cancelling its own working exit and replacing it, once a minute, for as long
 * as the fill took.
 */
describe("planPosition — an exit already working", () => {
  const working = (action: OpenPosition["exitRequestedAction"], minutesAgo: number) =>
    position({ exitRequestedAt: NOW - minutesAgo * 60_000, exitRequestedAction: action });

  it("does not re-ask for a take profit it already requested", () => {
    const plan = planPosition(
      snapshot({ price: 102 }),
      verdict(),
      working("take_profit", 1),
      FREE,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("hold");
    expect(plan.reason).toMatch(/already working/);
  });

  it("does not re-ask for a stop it already requested", () => {
    const plan = planPosition(
      snapshot({ price: 97 }),
      verdict(),
      working("stop_out", 1),
      FREE,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("hold");
  });

  it("escalates a resting take profit to a stop when the market collapses", () => {
    // A patient limit exit at a profit target may never fill. Waiting out the
    // window while the position runs through its stop is the one case where
    // asking again is right.
    const plan = planPosition(
      snapshot({ price: 97 }),
      verdict(),
      working("take_profit", 1),
      FREE,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("stop_out");
  });

  it("escalates only once — a stop already asked for is never re-sent", () => {
    const escalated = planPosition(
      snapshot({ price: 95 }),
      verdict(),
      working("stop_out", 2),
      FREE,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(escalated.action).toBe("hold");
  });

  it("does not re-flatten a book it is already flattening", () => {
    const broke = portfolio({ realizedPnlToday: -100, openPositions: 1 });
    const plan = planPosition(snapshot(), verdict(), working("flatten", 1), FREE, broke, NOW);

    expect(plan.action).toBe("hold");
  });

  it("flattens over a patient exit, because a halt is urgent", () => {
    const broke = portfolio({ realizedPnlToday: -100, openPositions: 1 });
    const plan = planPosition(snapshot(), verdict(), working("take_profit", 1), FREE, broke, NOW);

    expect(plan.action).toBe("flatten");
  });

  it("tries again once the window has passed and the exit clearly did not fill", () => {
    const stale = working("stop_out", FREE.cooldownMs / 60_000 + 1);
    const plan = planPosition(snapshot({ price: 97 }), verdict(), stale, FREE, portfolio({ openPositions: 1 }), NOW);

    expect(plan.action).toBe("stop_out");
  });
});

/**
 * The first live day lost money in a way no sample size fixes.
 *
 * A 1.5% target against a 2.5% stop is 0.6:1, which needs a 63% win rate just
 * to break even — and the trail then closed the single winner for +0.008 after
 * fees. Losers ran to the stop, winners were cut at zero.
 */
describe("planPosition — the trail must be worth taking", () => {
  it("does not close a winner for less than the round trip costs", () => {
    const fees: HeadLimits = {
      ...DEFAULT_HEAD_LIMITS,
      roundTripFeeBps: 55,
      trailStartPercent: 1,
      trailGivebackPercent: 0.5,
    };
    // Ran to 101.2, now 100.6: the trail has triggered, but net profit after
    // fees is a rounding error. This is the "banked 0.008" trade.
    const ran = position({ peakPrice: 101.2, entryFeeQuote: 0.2 });
    const plan = planPosition(
      snapshot({ price: 100.6 }),
      verdict({ signal: "hold" }),
      ran,
      fees,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("hold");
    expect(plan.notes.join(" ")).toMatch(/under the .* floor; letting it run/);
  });

  it("still trails once the move has cleared its costs and the floor", () => {
    const fees: HeadLimits = {
      ...DEFAULT_HEAD_LIMITS,
      roundTripFeeBps: 55,
      trailStartPercent: 1,
      trailGivebackPercent: 0.5,
    };
    const ran = position({ quantity: 10, peakPrice: 103, entryFeeQuote: 2 });
    const plan = planPosition(
      snapshot({ price: 102 }),
      verdict({ signal: "hold" }),
      ran,
      fees,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("trail_exit");
    expect(plan.netPnlQuote!).toBeGreaterThan(fees.minNetProfitQuote);
  });

  it("lets a small winner keep running rather than bank under the floor", () => {
    // The same shape as the trade above, one tenth the size: the trail has
    // triggered and the position is 1.25 up, which used to be a "win". The
    // stop is still underneath it, so running it costs nothing that was not
    // already at risk.
    const fees: HeadLimits = {
      ...DEFAULT_HEAD_LIMITS,
      roundTripFeeBps: 55,
      trailStartPercent: 1,
      trailGivebackPercent: 0.5,
    };
    const ran = position({ quantity: 1, peakPrice: 103, entryFeeQuote: 0.2 });
    const plan = planPosition(
      snapshot({ price: 102 }),
      verdict({ signal: "hold" }),
      ran,
      fees,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("hold");
    expect(plan.netPnlQuote!).toBeGreaterThan(0);
    expect(plan.netPnlQuote!).toBeLessThan(fees.minNetProfitQuote);
    expect(plan.notes.join(" ")).toMatch(/under the 3.00 floor; letting it run/);
  });

  it("ships defaults where reward is larger than risk", () => {
    // Below 1:1 the desk needs to be right more often than it is wrong just to
    // stand still, which is not a bet worth making with a stop this wide.
    expect(DEFAULT_HEAD_LIMITS.takeProfitPercent).toBeGreaterThan(DEFAULT_HEAD_LIMITS.stopLossPercent);
  });

  it("arms the trail late enough that the fee floor is reachable", () => {
    const floor = DEFAULT_HEAD_LIMITS.roundTripFeeBps / 100;
    const lockedIn = DEFAULT_HEAD_LIMITS.trailStartPercent - DEFAULT_HEAD_LIMITS.trailGivebackPercent;

    expect(lockedIn).toBeGreaterThan(floor);
  });
});

/**
 * The profit floor.
 *
 * Every threshold on this desk was a percentage of a ticket that conviction had
 * already shrunk. Measured over a year of hourly candles on BTC, ETH and PAXG,
 * that produced 248 winning trades of which 211 banked under three quote units
 * — against stops costing one to two each. These are the rules that stop a
 * "win" being worth less than the loss it is paired against.
 */
describe("planPosition — the profit floor", () => {
  const floored: HeadLimits = { ...DEFAULT_HEAD_LIMITS, roundTripFeeBps: 0, maxPositionQuote: 250 };

  it("derives the minimum ticket from the floor and the target", () => {
    // 3 quote units at a 3% target needs 100 staked. The arithmetic is the
    // whole rule, so it is asserted directly rather than inferred from a plan.
    expect(minTicketQuote({ minNetProfitQuote: 3, takeProfitPercent: 3 })).toBeCloseTo(100, 9);
    expect(minTicketQuote({ minNetProfitQuote: 3, takeProfitPercent: 1.5 })).toBeCloseTo(200, 9);
    expect(minTicketQuote({ minNetProfitQuote: 5, takeProfitPercent: 2 })).toBeCloseTo(250, 9);
  });

  it("asks for nothing when no floor is set", () => {
    expect(minTicketQuote({ minNetProfitQuote: 0, takeProfitPercent: 3 })).toBe(0);
  });

  it("treats a zero target as unreachable rather than dividing by it", () => {
    expect(minTicketQuote({ minNetProfitQuote: 3, takeProfitPercent: 0 })).toBe(Number.POSITIVE_INFINITY);
  });

  it("takes profit when the target is worth the floor", () => {
    // 250 staked at a 3% target banks 7.50 — over the floor, so the target is
    // taken exactly as it always was.
    const held = position({ quantity: 2.5, entryPrice: 100, entryFeeQuote: 0 });
    const plan = planPosition(
      snapshot({ price: 103.1 }),
      verdict(),
      held,
      floored,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("take_profit");
    expect(plan.netPnlQuote!).toBeGreaterThanOrEqual(floored.minNetProfitQuote);
  });

  it("holds a position that reached its percentage target but not the floor", () => {
    // 50 staked hits "3%" at 1.50. The percentage says take it; the money says
    // it is half a stop. A limit lowered under a position already open is how
    // this reaches the exit rules at all, so it is checked here and not only
    // at entry.
    const small = position({ quantity: 0.5, entryPrice: 100, entryFeeQuote: 0 });
    const plan = planPosition(
      snapshot({ price: 104 }),
      verdict({ signal: "hold" }),
      small,
      floored,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("hold");
    expect(plan.netPnlQuote!).toBeGreaterThan(0);
    expect(plan.netPnlQuote!).toBeLessThan(floored.minNetProfitQuote);
  });

  it("never lets the floor block a stop out", () => {
    // The one thing a profit floor must not do is make a loser harder to
    // leave. A stop is a risk exit and answers to nothing here.
    const small = position({ quantity: 0.5, entryPrice: 100, entryFeeQuote: 0 });
    const plan = planPosition(snapshot({ price: 97 }), verdict(), small, floored, portfolio({ openPositions: 1 }), NOW);

    expect(plan.action).toBe("stop_out");
  });

  it("never lets the floor block a flatten", () => {
    const small = position({ quantity: 0.5, entryPrice: 100, entryFeeQuote: 0 });
    const halted = portfolio({ openPositions: 1, realizedPnlToday: -floored.maxDailyLossQuote });
    const plan = planPosition(snapshot({ price: 100 }), verdict(), small, floored, halted, NOW);

    expect(plan.action).toBe("flatten");
  });

  it("ships a floor the default cap can actually fund", () => {
    // A floor the cap cannot reach is a head that refuses every trade and
    // blames the operator. The two defaults have to be consistent with each
    // other, and this is the assertion that keeps them that way.
    expect(minTicketQuote(DEFAULT_HEAD_LIMITS)).toBeLessThanOrEqual(DEFAULT_HEAD_LIMITS.maxPositionQuote);
  });
});

/**
 * The regime filter.
 *
 * Long-only trend rules are whipsawed by downtrends rather than merely idle in
 * them; on daily candles from 2018 the losing years were 2018, 2021 and 2022,
 * the last at a profit factor of 0.27. This gives the head a way to decline.
 *
 * It ships disabled. A pre-registered test on that history required the filter
 * to cut the worst year to better than -20, keep both walk-forward halves
 * positive, not reduce per-trade expectancy, and stay at or above the 95th
 * percentile against coin-flip entries. It passed three and missed the first at
 * -20.x, so the default stays off and the operator turns it on deliberately.
 */
describe("planPosition — the regime filter", () => {
  /** Closes that walk from `from` to `to` so the average sits where we want it. */
  const ramp = (from: number, to: number, count = 240): Candle[] =>
    Array.from({ length: count }, (_, i) => {
      const price = from + ((to - from) * i) / (count - 1);
      return { open: price, high: price, low: price, close: price, volume: 1, timestamp: NOW - (count - i) * 60_000 };
    });

  const gated: HeadLimits = { ...DEFAULT_HEAD_LIMITS, roundTripFeeBps: 0, maxPositionQuote: 250, regimeFilterPeriod: 200 };

  it("refuses an entry below the average, and names both numbers", () => {
    // Falling from 200 to 100: the last price is far under the 200-bar mean.
    const falling = ramp(200, 100);
    const plan = planPosition(
      { symbol: "BTC/USDT", price: falling[falling.length - 1].close, candles: falling },
      verdict({ confidence: 0.9 }),
      null,
      gated,
      portfolio(),
      NOW,
    );

    expect(plan.action).toBe("hold");
    expect(plan.reason).toMatch(/below its 200-period average/);
    expect(plan.reason).toMatch(/standing aside/);
  });

  it("allows an entry above the average", () => {
    const rising = ramp(100, 200);
    const plan = planPosition(
      { symbol: "BTC/USDT", price: rising[rising.length - 1].close, candles: rising },
      verdict({ confidence: 0.9 }),
      null,
      gated,
      portfolio(),
      NOW,
    );

    expect(plan.action).toBe("open");
  });

  it("has no opinion when the history is shorter than the period", () => {
    // A cold start must not read as a bear market. 40 candles, 200-bar filter.
    const plan = planPosition(snapshot(), verdict({ confidence: 0.9 }), null, gated, portfolio(), NOW);

    expect(plan.action).toBe("open");
  });

  it("is off unless the operator turns it on", () => {
    expect(DEFAULT_HEAD_LIMITS.regimeFilterPeriod).toBe(0);

    const falling = ramp(200, 100);
    const plan = planPosition(
      { symbol: "BTC/USDT", price: falling[falling.length - 1].close, candles: falling },
      verdict({ confidence: 0.9 }),
      null,
      { ...DEFAULT_HEAD_LIMITS, roundTripFeeBps: 0, maxPositionQuote: 250 },
      portfolio(),
      NOW,
    );

    expect(plan.action).toBe("open");
  });

  it("never blocks an exit on a position already held", () => {
    // The filter gates entries only. A stop below the average must still fire,
    // or the filter becomes a second stop with none of the first one's promises.
    const falling = ramp(200, 100);
    const held = position({ quantity: 2.5, entryPrice: 200, entryFeeQuote: 0 });
    const plan = planPosition(
      { symbol: "BTC/USDT", price: falling[falling.length - 1].close, candles: falling },
      verdict(),
      held,
      gated,
      portfolio({ openPositions: 1 }),
      NOW,
    );

    expect(plan.action).toBe("stop_out");
  });
});
