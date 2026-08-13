import { describe, expect, it } from "vitest";
import { AgentAccess, RateLimiter, parseAgentTokens, safeEqual } from "./agent-access.js";

const ADMIN = "test-admin-password";

const env = (overrides: Record<string, string> = {}) =>
  ({ DASHBOARD_AGENT_TOKENS: "research:tok_read:read,trader:tok_ctl:control", ...overrides }) as NodeJS.ProcessEnv;

describe("parseAgentTokens", () => {
  it("reads name, token and scope triples", () => {
    expect(parseAgentTokens("research:tok_a:read,trader:tok_b:control")).toEqual([
      { name: "research", token: "tok_a", scope: "read" },
      { name: "trader", token: "tok_b", scope: "control" },
    ]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseAgentTokens(" research : tok_a : read ")).toHaveLength(1);
  });

  it("drops malformed entries instead of throwing", () => {
    // A typo in an environment variable must not stop the daemon booting.
    expect(parseAgentTokens("bad,also:bad,name:token:wrongscope,ok:tok:read")).toEqual([
      { name: "ok", token: "tok", scope: "read" },
    ]);
  });

  it("returns nothing when unset", () => {
    expect(parseAgentTokens(undefined)).toEqual([]);
    expect(parseAgentTokens("")).toEqual([]);
  });
});

describe("safeEqual", () => {
  it("matches identical strings and rejects everything else", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("AgentAccess.authenticate", () => {
  it("recognises the admin password and grants it control", () => {
    const actor = new AgentAccess(env()).authenticate({ authorization: ADMIN }, ADMIN);

    expect(actor).toEqual({ kind: "admin", name: "admin", scope: "control" });
  });

  it("recognises an agent token and keeps it to its scope", () => {
    const access = new AgentAccess(env());

    expect(access.authenticate({ agentToken: "tok_read" }, ADMIN)).toEqual({ kind: "agent", name: "research", scope: "read" });
    expect(access.authenticate({ agentToken: "tok_ctl" }, ADMIN)).toEqual({ kind: "agent", name: "trader", scope: "control" });
  });

  it("also accepts an agent token in the Authorization header", () => {
    expect(new AgentAccess(env()).authenticate({ authorization: "tok_ctl" }, ADMIN)?.name).toBe("trader");
  });

  it("rejects an unknown token", () => {
    expect(new AgentAccess(env()).authenticate({ agentToken: "nope" }, ADMIN)).toBeNull();
  });

  it("rejects a request with no credentials", () => {
    expect(new AgentAccess(env()).authenticate({}, ADMIN)).toBeNull();
  });

  it("does not treat an empty admin password as a wildcard", () => {
    // If ADMIN_PASSWORD were unset, an empty header must not authenticate.
    expect(new AgentAccess(env()).authenticate({ authorization: "" }, undefined)).toBeNull();
  });
});

describe("AgentAccess.canControl", () => {
  it("allows a control token", () => {
    const access = new AgentAccess(env());
    const actor = access.authenticate({ agentToken: "tok_ctl" }, ADMIN)!;

    expect(access.canControl(actor).allowed).toBe(true);
  });

  it("refuses a read-only token", () => {
    const access = new AgentAccess(env());
    const actor = access.authenticate({ agentToken: "tok_read" }, ADMIN)!;
    const result = access.canControl(actor);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Token is read-only");
  });

  it("refuses everyone while frozen, including the admin", () => {
    const access = new AgentAccess(env());
    access.setFrozen(true);

    expect(access.canControl({ kind: "admin", name: "admin", scope: "control" }).allowed).toBe(false);
  });

  it("starts frozen when the environment disables control", () => {
    const access = new AgentAccess(env({ DASHBOARD_AGENT_CONTROL: "off" }));

    expect(access.isFrozen()).toBe(true);
  });
});

describe("AgentAccess audit trail", () => {
  it("records what happened, newest first", () => {
    const access = new AgentAccess(env());

    access.record({ actor: "trader", actorKind: "agent", action: "bot.stop", target: { botId: 5 }, outcome: "allowed", detail: null }, 1_000);
    access.record({ actor: "research", actorKind: "agent", action: "bot.start", target: { botId: 8 }, outcome: "denied", detail: "Token is read-only" }, 2_000);

    const actions = access.actions();

    expect(actions[0]!.action).toBe("bot.start");
    expect(actions[0]!.outcome).toBe("denied");
    expect(actions[1]!.action).toBe("bot.stop");
  });

  it("returns only actions after a cursor", () => {
    const access = new AgentAccess(env());
    access.record({ actor: "a", actorKind: "agent", action: "x", target: {}, outcome: "allowed", detail: null }, 1_000);
    access.record({ actor: "a", actorKind: "agent", action: "y", target: {}, outcome: "allowed", detail: null }, 3_000);

    expect(access.actions(2_000)).toHaveLength(1);
  });

  it("caps the log so it cannot grow without bound", () => {
    const access = new AgentAccess(env());
    for (let i = 0; i < 500; i += 1) {
      access.record({ actor: "a", actorKind: "agent", action: "x", target: {}, outcome: "allowed", detail: null }, i + 1);
    }

    expect(access.actions().length).toBeLessThanOrEqual(200);
  });

  it("never exposes token values", () => {
    expect(new AgentAccess(env()).describeTokens()).toEqual([
      { name: "research", scope: "read" },
      { name: "trader", scope: "control" },
    ]);
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit then refuses", () => {
    let now = 0;
    const limiter = new RateLimiter(3, 60_000, () => now);

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("reports how long to wait", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 60_000, () => now);

    limiter.check("a");
    now = 20_000;

    expect(limiter.check("a").retryAfterMs).toBe(40_000);
  });

  it("opens a fresh window once the old one expires", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 60_000, () => now);

    limiter.check("a");
    now = 60_001;

    expect(limiter.check("a").allowed).toBe(true);
  });

  it("keeps callers independent, so one agent cannot exhaust another quota", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 60_000, () => now);

    limiter.check("a");

    expect(limiter.check("b").allowed).toBe(true);
  });
});
