import { describe, expect, it } from "vitest";
import { AiBudget, AiKillSwitch, AutonomyGuard, AutonomyNonces, createAiGuards } from "./ai-guard.js";

/** A clock the test moves by hand, so nothing here waits on real time. */
function clock(start = 1_700_000_000_000) {
  let at = start;

  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("AutonomyGuard", () => {
  it("allows actions up to the limit and then refuses", () => {
    const guard = new AutonomyGuard(3, 60_000, clock().now);

    for (let i = 0; i < 3; i += 1) {
      expect(guard.check().allowed).toBe(true);
      guard.record();
    }

    const blocked = guard.check();
    expect(blocked.allowed).toBe(false);
    expect(blocked.allowed === false && blocked.reason).toContain("3 unattended actions");
  });

  it("rolls the window rather than resetting it on a boundary", () => {
    // A fixed window would let 3 land at 11:59 and 3 more at 12:01 — six actions
    // in two minutes under a limit that reads as three per minute.
    const time = clock();
    const guard = new AutonomyGuard(3, 60_000, time.now);

    for (let i = 0; i < 3; i += 1) guard.record();
    expect(guard.check().allowed).toBe(false);

    // Half the window on: the earliest action is still inside it.
    time.advance(30_000);
    expect(guard.check().allowed).toBe(false);

    // Past the window: the earliest has aged out and one slot is free.
    time.advance(31_000);
    expect(guard.check().allowed).toBe(true);
    expect(guard.remaining()).toBe(3);
  });

  it("frees exactly one slot as each action ages out", () => {
    const time = clock();
    const guard = new AutonomyGuard(3, 60_000, time.now);

    guard.record();
    time.advance(20_000);
    guard.record();
    guard.record();
    expect(guard.remaining()).toBe(0);

    // Only the first has aged out.
    time.advance(41_000);
    expect(guard.remaining()).toBe(1);
  });

  it("says roughly how long until it can act again", () => {
    const time = clock();
    const guard = new AutonomyGuard(1, 10 * 60_000, time.now);

    guard.record();
    time.advance(60_000);

    const blocked = guard.check();
    expect(blocked.allowed === false && blocked.reason).toContain("9 minutes");
  });

  it("does not count a check as an action", () => {
    const guard = new AutonomyGuard(2, 60_000, clock().now);

    guard.check();
    guard.check();
    guard.check();

    expect(guard.remaining()).toBe(2);
  });

  it("clears on reset", () => {
    const guard = new AutonomyGuard(1, 60_000, clock().now);

    guard.record();
    expect(guard.check().allowed).toBe(false);

    guard.reset();
    expect(guard.check().allowed).toBe(true);
  });
});

describe("AiBudget", () => {
  it("is unlimited when the limit is zero, which is the default", () => {
    const budget = new AiBudget(0, clock().now);

    budget.record(10_000_000);
    expect(budget.check().allowed).toBe(true);
  });

  it("refuses once the day's allowance is spent", () => {
    const budget = new AiBudget(1000, clock().now);

    budget.record(600);
    expect(budget.check().allowed).toBe(true);

    budget.record(500);
    const blocked = budget.check();
    expect(blocked.allowed).toBe(false);
    expect(blocked.allowed === false && blocked.reason).toContain("midnight UTC");
  });

  it("rolls at UTC midnight", () => {
    // 1700000000000 is 2023-11-14T22:13:20Z — under two hours from the roll.
    const time = clock();
    const budget = new AiBudget(1000, time.now);

    budget.record(1000);
    expect(budget.check().allowed).toBe(false);

    time.advance(2 * 60 * 60 * 1000);
    expect(budget.check().allowed).toBe(true);
    expect(budget.spent().used).toBe(0);
  });

  it("treats unknown usage as zero rather than as free", () => {
    const budget = new AiBudget(100, clock().now);

    budget.record(NaN);
    budget.record(-5);
    budget.record(undefined as unknown as number);

    expect(budget.spent().used).toBe(0);
  });

  it("reports what it has spent and against what", () => {
    const budget = new AiBudget(500, clock().now);

    budget.record(120);
    expect(budget.spent()).toEqual({ day: "2023-11-14", used: 120, limit: 500 });
  });
});

describe("AutonomyNonces", () => {
  it("accepts a nonce exactly once", () => {
    const nonces = new AutonomyNonces(30_000, clock().now);

    nonces.issue("abc");
    expect(nonces.consume("abc")).toBe(true);
    // Replaying it must fail, or one internal call could label many actions.
    expect(nonces.consume("abc")).toBe(false);
  });

  it("rejects anything it never issued", () => {
    const nonces = new AutonomyNonces(30_000, clock().now);

    // This is the whole point: a caller cannot forge the unattended flag.
    expect(nonces.consume("guessed")).toBe(false);
    expect(nonces.consume(undefined)).toBe(false);
    expect(nonces.consume("")).toBe(false);
  });

  it("expires a nonce whose request never arrived", () => {
    const time = clock();
    const nonces = new AutonomyNonces(30_000, time.now);

    nonces.issue("stale");
    time.advance(31_000);

    expect(nonces.consume("stale")).toBe(false);
  });

  it("keeps separate nonces separate", () => {
    const nonces = new AutonomyNonces(30_000, clock().now);

    nonces.issue("one");
    nonces.issue("two");

    expect(nonces.consume("two")).toBe(true);
    expect(nonces.consume("one")).toBe(true);
  });
});

describe("AiKillSwitch", () => {
  it("starts running unless the environment says otherwise", () => {
    expect(new AiKillSwitch({}).isStopped()).toBe(false);
    expect(new AiKillSwitch({ AI_DISABLED: "1" }).isStopped()).toBe(true);
  });

  it("stops and starts, carrying a reason when given one", () => {
    const sw = new AiKillSwitch({});

    sw.stop("it kept trying to stop the wrong bot");
    const stopped = sw.check();
    expect(stopped.allowed).toBe(false);
    expect(stopped.allowed === false && stopped.reason).toContain("wrong bot");

    sw.start();
    expect(sw.check().allowed).toBe(true);
  });

  it("explains itself even when stopped without a reason", () => {
    const sw = new AiKillSwitch({});
    sw.stop();

    const stopped = sw.check();
    expect(stopped.allowed === false && stopped.reason).toContain("switched off");
  });
});

describe("createAiGuards", () => {
  it("uses the documented defaults on a bare environment", () => {
    const guards = createAiGuards({});

    expect(guards.autonomy.remaining()).toBe(20);
    expect(guards.budget.spent().limit).toBe(0);
    expect(guards.killSwitch.isStopped()).toBe(false);
  });

  it("reads the environment overrides", () => {
    const guards = createAiGuards({
      AI_AUTONOMOUS_MAX_ACTIONS: "5",
      AI_DAILY_TOKEN_BUDGET: "250000",
      AI_DISABLED: "1",
    });

    expect(guards.autonomy.remaining()).toBe(5);
    expect(guards.budget.spent().limit).toBe(250_000);
    expect(guards.killSwitch.isStopped()).toBe(true);
  });

  it("ignores a nonsense override rather than dropping the limit to zero", () => {
    // A typo in an env var must not silently mean "unlimited actions".
    expect(createAiGuards({ AI_AUTONOMOUS_MAX_ACTIONS: "twenty" }).autonomy.remaining()).toBe(20);
    expect(createAiGuards({ AI_AUTONOMOUS_MAX_ACTIONS: "-3" }).autonomy.remaining()).toBe(20);
  });
});
