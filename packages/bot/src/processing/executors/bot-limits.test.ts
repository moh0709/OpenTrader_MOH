import { describe, expect, it } from "vitest";
import {
  NO_LIMITS,
  allowsEntry,
  clearRefusal,
  committedCapital,
  exitPriceForMinProfit,
  orderNotional,
  projectedProfit,
  shouldLogRefusal,
  toBotLimits,
  toLimit,
  withBotEntryLock,
} from "./bot-limits.js";

const order = (entityType: string, status: string, price: number | null, quantity: number, filledPrice: number | null = null) => ({
  entityType,
  status,
  price,
  filledPrice,
  quantity,
});

describe("toLimit", () => {
  it("treats a positive number as a limit", () => {
    expect(toLimit(500)).toBe(500);
  });

  it("treats zero, negatives and absent values as no limit", () => {
    // The UI writes 0 to clear a limit, so it must not mean "allow nothing".
    expect(toLimit(0)).toBeNull();
    expect(toLimit(-1)).toBeNull();
    expect(toLimit(null)).toBeNull();
    expect(toLimit(undefined)).toBeNull();
    expect(toLimit(Number.NaN)).toBeNull();
  });

  it("reads both columns off a bot row", () => {
    expect(toBotLimits({ maxCapital: 500, minProfit: 0.25 })).toEqual({ maxCapital: 500, minProfit: 0.25 });
    expect(toBotLimits(null)).toEqual(NO_LIMITS);
  });
});

describe("committedCapital", () => {
  it("counts a held position at what it cost", () => {
    const trades = [{ orders: [order("EntryOrder", "Filled", 100, 2, 99), order("TakeProfitOrder", "Placed", 110, 2)] }];

    expect(committedCapital(trades)).toBeCloseTo(198, 10); // filled price wins over the limit price
  });

  it("counts a resting entry order, because it is about to become a position", () => {
    const trades = [{ orders: [order("EntryOrder", "Placed", 100, 2), order("TakeProfitOrder", "Idle", 110, 2)] }];

    expect(committedCapital(trades)).toBeCloseTo(200, 10);
  });

  it("releases capital once the cycle closed", () => {
    const trades = [{ orders: [order("EntryOrder", "Filled", 100, 2, 100), order("TakeProfitOrder", "Filled", 110, 2, 110)] }];

    expect(committedCapital(trades)).toBe(0);
  });

  it("ignores cancelled entries, which will never cost anything", () => {
    const trades = [{ orders: [order("EntryOrder", "Canceled", 100, 2), order("TakeProfitOrder", "Revoked", 110, 2)] }];

    expect(committedCapital(trades)).toBe(0);
  });

  it("adds up safety orders on a DCA position", () => {
    const trades = [
      {
        orders: [
          order("EntryOrder", "Filled", 100, 1, 100),
          order("SafetyOrder", "Filled", 60, 3, 60),
          order("SafetyOrder", "Placed", 40, 5),
          order("TakeProfitOrder", "Placed", 90, 4),
        ],
      },
    ];

    expect(committedCapital(trades)).toBeCloseTo(100 + 180 + 200, 10);
  });

  it("sums across every trade of the bot", () => {
    const trades = [
      { orders: [order("EntryOrder", "Placed", 100, 1)] },
      { orders: [order("EntryOrder", "Placed", 200, 1)] },
    ];

    expect(committedCapital(trades)).toBeCloseTo(300, 10);
  });

  it("is zero for a bot that has done nothing", () => {
    expect(committedCapital([])).toBe(0);
  });
});

describe("allowsEntry", () => {
  const limits = { maxCapital: 500, minProfit: null };

  it("allows an entry that fits", () => {
    expect(allowsEntry(limits, 300, 100).allowed).toBe(true);
  });

  it("allows an entry that lands exactly on the cap", () => {
    expect(allowsEntry(limits, 400, 100).allowed).toBe(true);
  });

  it("blocks the entry that would cross it", () => {
    const decision = allowsEntry(limits, 450, 100);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("550.00");
    expect(decision.reason).toContain("500.00");
  });

  it("allows everything when no cap is set", () => {
    expect(allowsEntry(NO_LIMITS, 1_000_000, 999_999).allowed).toBe(true);
  });

  it("lets a market order through, since it has no price to measure", () => {
    // Blocking on a number we do not have would silently stall the strategy.
    expect(allowsEntry(limits, 499, orderNotional({ price: null, quantity: 5 })).allowed).toBe(true);
  });

  it("serializes concurrent work for one bot", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = withBotEntryLock(99, async () => {
      events.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first-end");
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const second = withBotEntryLock(99, async () => {
      events.push("second");
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });
});

describe("exitPriceForMinProfit", () => {
  const limits = { maxCapital: null, minProfit: 1 };

  it("leaves an exit alone when it already earns enough", () => {
    // Entry 100 x 2, exit 110 -> 20 profit, well past the 1 floor.
    expect(exitPriceForMinProfit(limits, 100, 2, 110)).toBe(110);
  });

  it("lifts an exit that would earn too little", () => {
    // Entry 100 x 2, exit 100.1 -> 0.20 profit. Needs 100.5 to make 1.
    expect(exitPriceForMinProfit(limits, 100, 2, 100.1)).toBeCloseTo(100.5, 10);
  });

  it("earns exactly the floor after lifting", () => {
    const lifted = exitPriceForMinProfit(limits, 100, 2, 100.1);

    expect(projectedProfit(100, 2, lifted)).toBeCloseTo(1, 10);
  });

  it("scales with quantity: a bigger position needs less price movement", () => {
    const small = exitPriceForMinProfit(limits, 100, 1, 100);
    const large = exitPriceForMinProfit(limits, 100, 10, 100);

    expect(small).toBeCloseTo(101, 10);
    expect(large).toBeCloseTo(100.1, 10);
  });

  it("does nothing when no floor is set", () => {
    expect(exitPriceForMinProfit(NO_LIMITS, 100, 2, 100.01)).toBe(100.01);
  });

  it("leaves the price alone rather than dividing by zero", () => {
    expect(exitPriceForMinProfit(limits, 100, 0, 105)).toBe(105);
    expect(exitPriceForMinProfit(limits, 0, 2, 105)).toBe(105);
  });

  it("never lowers an exit", () => {
    // A generous target must survive the floor untouched.
    expect(exitPriceForMinProfit(limits, 100, 2, 500)).toBe(500);
  });
});

describe("the grid scenario these limits exist for", () => {
  it("stops a wide grid committing more than the cap", () => {
    const limits = { maxCapital: 500, minProfit: null };
    const placed: number[] = [];
    const trades: Array<{ orders: ReturnType<typeof order>[] }> = [];

    // Ten levels of 100 each: only five should ever be placed.
    for (let i = 0; i < 10; i += 1) {
      const notional = 100;
      if (!allowsEntry(limits, committedCapital(trades), notional).allowed) continue;

      placed.push(notional);
      trades.push({ orders: [order("EntryOrder", "Placed", 100, 1)] });
    }

    expect(placed).toHaveLength(5);
    expect(committedCapital(trades)).toBeCloseTo(500, 10);
  });

  it("turns a sub-cent grid close into a real one", () => {
    // 0.012 BTC with 20 of grid spacing earns 0.24 - below a 1.00 floor.
    const limits = { maxCapital: null, minProfit: 1 };
    const lifted = exitPriceForMinProfit(limits, 65_000, 0.012, 65_020);

    expect(projectedProfit(65_000, 0.012, 65_020)).toBeCloseTo(0.24, 10);
    expect(projectedProfit(65_000, 0.012, lifted)).toBeCloseTo(1, 10);
    expect(lifted).toBeGreaterThan(65_020);
  });
});

describe("committedCapital with an order excluded", () => {
  // The regression this exists for: by the time the cap is checked, the entry
  // being decided on has already been written to the database as Idle. Counting
  // it as committed and then adding its notional again refused every order worth
  // more than half the cap, which on a live fleet looked like a bot that had
  // simply stopped trading.
  const entry = (id: number, price: number, quantity: number) => ({
    id,
    entityType: "EntryOrder",
    status: "Idle",
    price,
    filledPrice: null,
    quantity,
  });

  it("leaves out the order being decided on", () => {
    const trades = [{ orders: [entry(1, 1000, 1)] }];

    expect(committedCapital(trades)).toBe(1000);
    expect(committedCapital(trades, 1)).toBe(0);
  });

  it("still counts every other resting entry", () => {
    const trades = [{ orders: [entry(1, 1000, 1)] }, { orders: [entry(2, 250, 2)] }];

    expect(committedCapital(trades, 1)).toBe(500);
  });

  it("admits an order that exactly fills the cap", () => {
    const limits = { maxCapital: 1000, minProfit: null };
    const trades = [{ orders: [entry(1, 1000, 1)] }];

    // Double counting made this 2000 against a 1000 cap, and refused it.
    expect(allowsEntry(limits, committedCapital(trades, 1), 1000).allowed).toBe(true);
  });

  it("ignores an id that is not there", () => {
    const trades = [{ orders: [entry(1, 1000, 1)] }];

    expect(committedCapital(trades, 999)).toBe(1000);
  });
});

describe("refusal logging", () => {
  // Once a cap engages, a grid refuses the same level on every tick. Left alone
  // that wrote 16,866 identical lines in two minutes across five bots, which
  // buries everything else and stops being information after the first one.
  const BOT = 4242;

  it("reports a refusal the first time and then stays quiet", () => {
    clearRefusal(BOT);

    expect(shouldLogRefusal(BOT, "capital limit reached: 2013 > 1000")).toBe(true);
    expect(shouldLogRefusal(BOT, "capital limit reached: 2013 > 1000")).toBe(false);
    expect(shouldLogRefusal(BOT, "capital limit reached: 2013 > 1000")).toBe(false);
  });

  it("speaks up again when the numbers change", () => {
    clearRefusal(BOT);
    shouldLogRefusal(BOT, "capital limit reached: 2013 > 1000");

    expect(shouldLogRefusal(BOT, "capital limit reached: 3020 > 1000")).toBe(true);
  });

  it("keeps bots separate", () => {
    clearRefusal(BOT);
    clearRefusal(BOT + 1);
    shouldLogRefusal(BOT, "same reason");

    expect(shouldLogRefusal(BOT + 1, "same reason")).toBe(true);
  });

  it("reports the next refusal after an order goes through", () => {
    clearRefusal(BOT);
    shouldLogRefusal(BOT, "capital limit reached: 2013 > 1000");

    // What the executor does once it places: the run of refusals has ended, so
    // the next one is news again.
    clearRefusal(BOT);

    expect(shouldLogRefusal(BOT, "capital limit reached: 2013 > 1000")).toBe(true);
  });
});
