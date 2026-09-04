import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEAD_LIMITS,
  isEntry,
  isExit,
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

describe("planPosition — opening", () => {
  it("opens on a confident buy and sizes below the cap", () => {
    const plan = planPosition(snapshot(), verdict({ confidence: 0.8 }), null, FREE, portfolio(), NOW);

    expect(plan.action).toBe("open");
    expect(plan.sizeQuote).toBeCloseTo(80, 5);
    expect(plan.quantity).toBeCloseTo(0.8, 5);
    expect(isEntry(plan.action)).toBe(true);
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
    const plan = planPosition(snapshot(), verdict(), position(), limits, portfolio({ openPositions: 1, openExposureQuote: 100 }), NOW);

    expect(plan.action).toBe("add");
  });
});

describe("planPosition — budgets can only reduce", () => {
  it("clamps to the remaining exposure headroom", () => {
    const tight = portfolio({ openExposureQuote: DEFAULT_HEAD_LIMITS.maxTotalExposureQuote - 30 });
    const plan = planPosition(snapshot(), verdict({ confidence: 1 }), null, FREE, tight, NOW);

    expect(plan.action).toBe("open");
    expect(plan.sizeQuote).toBeCloseTo(30, 5);
    expect(plan.notes.join(" ")).toMatch(/remaining exposure headroom/);
  });

  it("clamps to what is left of the day's opening budget", () => {
    const spent = portfolio({ openedNotionalToday: DEFAULT_HEAD_LIMITS.maxDailyOpenNotionalQuote - 25 });
    const plan = planPosition(snapshot(), verdict({ confidence: 1 }), null, FREE, spent, NOW);

    expect(plan.sizeQuote).toBeCloseTo(25, 5);
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
    const ran = position({ peakPrice: 102 });
    // 1.2% off a 102 peak, still net positive at 100.8.
    const plan = planPosition(snapshot({ price: 100.8 }), verdict(), ran, FREE, portfolio({ openPositions: 1 }), NOW);

    expect(plan.action).toBe("trail_exit");
    expect(plan.netPnlQuote).toBeGreaterThan(0);
  });

  it("does not trail a position back through break-even", () => {
    const ran = position({ peakPrice: 102 });
    const plan = planPosition(snapshot({ price: 99.5 }), verdict({ signal: "hold" }), ran, FREE, portfolio({ openPositions: 1 }), NOW);

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
    const plan = planPosition(snapshot({ price: 99.9 }), verdict({ signal: "hold" }), stale, FREE, portfolio({ openPositions: 1 }), NOW);

    expect(plan.action).toBe("close");
    expect(plan.reason).toMatch(/without working/);
  });

  it("leaves a long-held winner alone rather than closing it on age", () => {
    const stale = position({ openedAt: NOW - DEFAULT_HEAD_LIMITS.maxHoldMs - HOUR });
    // Up, but under the take-profit target, and not off a peak.
    const plan = planPosition(snapshot({ price: 101 }), verdict({ signal: "hold" }), stale, FREE, portfolio({ openPositions: 1 }), NOW);

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
    const plan = planPosition(snapshot({ price: 97 }), verdict(), position(), paused, portfolio({ openPositions: 1 }), NOW);

    // A pause on new ideas is not a pause on the stop. An unmanaged position is
    // the one state this desk must never be in.
    expect(plan.action).toBe("stop_out");
    expect(isExit(plan.action)).toBe(true);
  });

  it("still takes a profit that is there", () => {
    const plan = planPosition(snapshot({ price: 104 }), verdict(), position(), paused, portfolio({ openPositions: 1 }), NOW);

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
    const plan = planPosition(snapshot({ price: 97 }), verdict(), working("stop_out", 1), FREE, portfolio({ openPositions: 1 }), NOW);

    expect(plan.action).toBe("hold");
  });

  it("escalates a resting take profit to a stop when the market collapses", () => {
    // A patient limit exit at a profit target may never fill. Waiting out the
    // window while the position runs through its stop is the one case where
    // asking again is right.
    const plan = planPosition(snapshot({ price: 97 }), verdict(), working("take_profit", 1), FREE, portfolio({ openPositions: 1 }), NOW);

    expect(plan.action).toBe("stop_out");
  });

  it("escalates only once — a stop already asked for is never re-sent", () => {
    const escalated = planPosition(snapshot({ price: 95 }), verdict(), working("stop_out", 2), FREE, portfolio({ openPositions: 1 }), NOW);

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
    const fees: HeadLimits = { ...DEFAULT_HEAD_LIMITS, roundTripFeeBps: 55, trailStartPercent: 1, trailGivebackPercent: 0.5 };
    // Ran to 101.2, now 100.6: the trail has triggered, but net profit after
    // fees is a rounding error. This is the "banked 0.008" trade.
    const ran = position({ peakPrice: 101.2, entryFeeQuote: 0.2 });
    const plan = planPosition(snapshot({ price: 100.6 }), verdict({ signal: "hold" }), ran, fees, portfolio({ openPositions: 1 }), NOW);

    expect(plan.action).toBe("hold");
    expect(plan.notes.join(" ")).toMatch(/under the .* floor; letting it run/);
  });

  it("still trails once the move has cleared its costs", () => {
    const fees: HeadLimits = { ...DEFAULT_HEAD_LIMITS, roundTripFeeBps: 55, trailStartPercent: 1, trailGivebackPercent: 0.5 };
    const ran = position({ peakPrice: 103, entryFeeQuote: 0.2 });
    const plan = planPosition(snapshot({ price: 102 }), verdict({ signal: "hold" }), ran, fees, portfolio({ openPositions: 1 }), NOW);

    expect(plan.action).toBe("trail_exit");
    expect(plan.netPnlQuote!).toBeGreaterThan(0.5);
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
