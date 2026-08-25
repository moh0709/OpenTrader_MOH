/**
 * Server-side limits on what the AI may do, and what it may spend doing it.
 *
 * The dashboard already enforces an autopilot budget — twenty actions, thirty
 * minutes, disarm on the first failure — but all of that lives in a browser tab,
 * which makes it a courtesy rather than a control. A stuck loop, a reloaded
 * page that re-arms, or anyone willing to call the endpoint directly is bounded
 * only by the generic 30-per-minute control limiter, which for actions that
 * place real orders is not a bound anybody would choose deliberately.
 *
 * So the same rules are enforced again here, where they cannot be edited by the
 * thing they govern. The browser keeps its copy because it makes the UI
 * responsive and honest; this one is what actually stops it.
 *
 * Three separate things live here because they fail in three different ways:
 *
 *   AutonomyGuard   how much the AI may do unattended, per rolling window
 *   AiBudget        how many tokens it may spend, per day
 *   the kill switch whether it may act at all
 */

/** Default ceiling on unattended actions, matching the dashboard's own. */
export const DEFAULT_AUTONOMY_LIMIT = 20;

/** Default window the ceiling applies over. */
export const DEFAULT_AUTONOMY_WINDOW_MS = 30 * 60 * 1000;

/** Default daily token allowance. Zero means "no ceiling". */
export const DEFAULT_DAILY_TOKEN_BUDGET = 0;

export type GuardDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * How many unattended actions the AI has taken lately, and whether it may take
 * another.
 *
 * A rolling window rather than a counter that resets: a fixed window lets twenty
 * actions land at 11:59 and twenty more at 12:01, which is forty actions in two
 * minutes under a limit that reads as twenty per half hour.
 */
export class AutonomyGuard {
  private taken: number[] = [];

  constructor(
    private limit: number = DEFAULT_AUTONOMY_LIMIT,
    private windowMs: number = DEFAULT_AUTONOMY_WINDOW_MS,
    private now: () => number = Date.now,
  ) {}

  private prune(at: number) {
    const cutoff = at - this.windowMs;
    this.taken = this.taken.filter((stamp) => stamp > cutoff);
  }

  /** Would one more unattended action be allowed right now? Does not record it. */
  check(): GuardDecision {
    const at = this.now();
    this.prune(at);

    if (this.taken.length < this.limit) return { allowed: true };

    const oldest = this.taken[0];
    const freesInMs = Math.max(0, oldest + this.windowMs - at);
    const minutes = Math.ceil(freesInMs / 60_000);

    return {
      allowed: false,
      reason: `The AI has taken its ${this.limit} unattended actions for this period. It can act again in about ${minutes} minute${minutes === 1 ? "" : "s"}, or you can approve actions yourself in the meantime.`,
    };
  }

  /** Record one unattended action. Call only after it actually succeeded. */
  record() {
    const at = this.now();
    this.prune(at);
    this.taken.push(at);
  }

  /** How many remain in the current window. */
  remaining(): number {
    this.prune(this.now());

    return Math.max(0, this.limit - this.taken.length);
  }

  /** Clear the history. Used when an operator re-enables the AI deliberately. */
  reset() {
    this.taken = [];
  }
}

/**
 * A day's token allowance.
 *
 * The chat sends a fleet snapshot and up to twelve turns of history on every
 * message and asks for a long answer, so an unattended loop is a billing
 * incident before it is anything else. The day rolls at UTC midnight, which is
 * arbitrary but predictable — the alternative, a rolling 24 hours, makes "how
 * much have I spent today" unanswerable.
 */
export class AiBudget {
  private day = "";
  private used = 0;

  constructor(
    private limit: number = DEFAULT_DAILY_TOKEN_BUDGET,
    private now: () => number = Date.now,
  ) {}

  private roll() {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
  }

  check(): GuardDecision {
    if (this.limit <= 0) return { allowed: true };
    this.roll();

    if (this.used < this.limit) return { allowed: true };

    return {
      allowed: false,
      reason: `The AI has used its token budget for today (${this.used.toLocaleString()} of ${this.limit.toLocaleString()}). It resets at midnight UTC, or raise AI_DAILY_TOKEN_BUDGET.`,
    };
  }

  /** Add what a call actually cost. Unknown usage counts as zero, not as free. */
  record(tokens: number) {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.roll();
    this.used += tokens;
  }

  spent(): { day: string; used: number; limit: number } {
    this.roll();

    return { day: this.day, used: this.used, limit: this.limit };
  }
}

/**
 * One-time tokens proving a control call came from the AI execute route.
 *
 * The journal records whether an action was taken unattended, and that flag used
 * to be an `x-ai-autonomous` header — which any caller could set on a direct
 * request, mislabelling their own action as the AI's or the AI's as their own.
 * It granted no permission, but an audit trail that can be forged is not an
 * audit trail.
 *
 * A nonce cannot be guessed and cannot be replayed: it is registered
 * immediately before the internal call and consumed by the first handler that
 * presents it. Anything arriving without one is, by construction, not from here.
 */
export class AutonomyNonces {
  private live = new Map<string, number>();

  constructor(
    private ttlMs = 30_000,
    private now: () => number = Date.now,
  ) {}

  /** Mint a nonce for one internal call. */
  issue(value: string): string {
    this.sweep();
    this.live.set(value, this.now() + this.ttlMs);

    return value;
  }

  /** True exactly once per issued nonce. */
  consume(value: string | undefined): boolean {
    if (!value) return false;
    this.sweep();

    const expires = this.live.get(value);
    if (expires === undefined) return false;

    this.live.delete(value);

    return expires > this.now();
  }

  /** Drop anything that expired, so a crashed request cannot leak an entry. */
  private sweep() {
    const at = this.now();
    for (const [value, expires] of this.live) if (expires <= at) this.live.delete(value);
  }
}

/**
 * Whether the AI may act at all.
 *
 * Deliberately not the existing `freeze` switch. That one disables every agent
 * control path, including the buttons the operator uses to clean up after the
 * AI — so the one moment you most want to stop the AI is the moment freezing it
 * takes your own tools away too. This stops the AI and leaves you yours.
 */
export class AiKillSwitch {
  private stopped: boolean;
  private reason: string | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.stopped = env.AI_DISABLED === "1";
    if (this.stopped) this.reason = "AI_DISABLED=1 is set on the server";
  }

  stop(reason: string | null = null) {
    this.stopped = true;
    this.reason = reason;
  }

  start() {
    this.stopped = false;
    this.reason = null;
  }

  isStopped() {
    return this.stopped;
  }

  check(): GuardDecision {
    if (!this.stopped) return { allowed: true };

    return { allowed: false, reason: this.reason ?? "The AI is switched off. Turn it back on from the dashboard." };
  }
}

const num = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/** Everything above, wired from the environment, as one object. */
export function createAiGuards(env: NodeJS.ProcessEnv = process.env) {
  return {
    autonomy: new AutonomyGuard(
      num(env.AI_AUTONOMOUS_MAX_ACTIONS, DEFAULT_AUTONOMY_LIMIT),
      num(env.AI_AUTONOMOUS_WINDOW_MS, DEFAULT_AUTONOMY_WINDOW_MS),
    ),
    budget: new AiBudget(num(env.AI_DAILY_TOKEN_BUDGET, DEFAULT_DAILY_TOKEN_BUDGET)),
    nonces: new AutonomyNonces(),
    killSwitch: new AiKillSwitch(env),
  };
}

export type AiGuards = ReturnType<typeof createAiGuards>;
