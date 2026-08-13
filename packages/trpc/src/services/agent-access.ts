/**
 * Access control and audit trail for the machine-facing dashboard API.
 *
 * The dashboard UI authenticates with the admin password, which is fine for a
 * person at a browser but wrong for an automated agent: it is the key to
 * everything, and it cannot be revoked without locking yourself out. So agents
 * get their own tokens, each with an explicit scope, configured out of band:
 *
 *   DASHBOARD_AGENT_TOKENS="research:tok_abc:read,trader:tok_def:control"
 *
 * A `read` token can only read. Only a `control` token can act on a bot, and
 * even then control can be frozen at runtime without a restart. Every attempt,
 * allowed or refused, is recorded so there is always an answer to "what did the
 * agent just do".
 */
export type AgentScope = "read" | "control";

export type AgentToken = {
  name: string;
  token: string;
  scope: AgentScope;
};

export type Actor = {
  kind: "admin" | "agent";
  name: string;
  scope: AgentScope;
};

export type AgentActionRecord = {
  at: number;
  actor: string;
  actorKind: Actor["kind"];
  action: string;
  target: Record<string, unknown>;
  outcome: "allowed" | "denied" | "failed";
  detail: string | null;
};

/**
 * Parse the token configuration.
 *
 * Malformed entries are dropped rather than throwing: a typo in an environment
 * variable must not stop the trading daemon from booting.
 */
export function parseAgentTokens(raw: string | undefined): AgentToken[] {
  if (!raw) return [];

  const tokens: AgentToken[] = [];

  for (const entry of raw.split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length !== 3) continue;

    const [name, token, scope] = parts.map((part) => part.trim());
    if (!name || !token) continue;
    if (scope !== "read" && scope !== "control") continue;

    tokens.push({ name, token, scope });
  }

  return tokens;
}

/** Constant-time comparison, so a token cannot be guessed a character at a time. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);

  return mismatch === 0;
}

export type RateLimitResult = { allowed: boolean; retryAfterMs: number };

/** Fixed-window rate limiter, keyed per caller. */
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  check(key: string): RateLimitResult {
    const now = this.now();
    const window = this.windows.get(key);

    if (!window || now >= window.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });

      return { allowed: true, retryAfterMs: 0 };
    }

    if (window.count >= this.limit) return { allowed: false, retryAfterMs: window.resetAt - now };

    window.count += 1;

    return { allowed: true, retryAfterMs: 0 };
  }
}

const ACTION_LOG_LIMIT = 200;

export class AgentAccess {
  private tokens: AgentToken[];
  private actionLog: AgentActionRecord[] = [];
  private frozen: boolean;
  readonly readLimiter: RateLimiter;
  readonly controlLimiter: RateLimiter;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    now: () => number = Date.now,
  ) {
    this.tokens = parseAgentTokens(env.DASHBOARD_AGENT_TOKENS);
    // Control is opt-out by environment as well as by runtime switch, so it can
    // be disabled on a host where no agent should ever act.
    this.frozen = env.DASHBOARD_AGENT_CONTROL === "off";
    this.readLimiter = new RateLimiter(600, 60_000, now);
    this.controlLimiter = new RateLimiter(30, 60_000, now);
  }

  /** Identify a caller from its headers, or null when it presents nothing valid. */
  authenticate(headers: { authorization?: string; agentToken?: string }, adminPassword: string | undefined): Actor | null {
    if (adminPassword && headers.authorization && safeEqual(headers.authorization, adminPassword)) {
      return { kind: "admin", name: "admin", scope: "control" };
    }

    const presented = headers.agentToken ?? headers.authorization;
    if (!presented) return null;

    for (const token of this.tokens) {
      if (safeEqual(presented, token.token)) return { kind: "agent", name: token.name, scope: token.scope };
    }

    return null;
  }

  canControl(actor: Actor): { allowed: boolean; reason: string | null } {
    if (this.frozen) return { allowed: false, reason: "Agent control is frozen" };
    if (actor.scope !== "control") return { allowed: false, reason: "Token is read-only" };

    return { allowed: true, reason: null };
  }

  isFrozen() {
    return this.frozen;
  }

  setFrozen(frozen: boolean) {
    this.frozen = frozen;
  }

  /** Names and scopes only - never the token values themselves. */
  describeTokens() {
    return this.tokens.map(({ name, scope }) => ({ name, scope }));
  }

  record(entry: Omit<AgentActionRecord, "at">, at: number = Date.now()) {
    this.actionLog.push({ ...entry, at });
    if (this.actionLog.length > ACTION_LOG_LIMIT) this.actionLog.shift();
  }

  /** Recorded actions, newest first, optionally only those after a cursor. */
  actions(since = 0): AgentActionRecord[] {
    return this.actionLog.filter((entry) => entry.at > since).sort((a, b) => b.at - a.at);
  }
}

const globalForAgentAccess = globalThis as unknown as { agentAccess?: AgentAccess };

export const agentAccess = globalForAgentAccess.agentAccess ?? new AgentAccess();

if (process.env.NODE_ENV !== "production") globalForAgentAccess.agentAccess = agentAccess;
