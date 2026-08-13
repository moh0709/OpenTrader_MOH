import { describe, expect, it } from "vitest";
import {
  PRESENCE_WINDOW_MS,
  decideAccess,
  deriveToken,
  identityOf,
  isWatching,
  shareUrl,
  statusOf,
  toViewer,
  validateShareInput,
  watchersOf,
} from "./share-links.js";

const NOW = 1_786_400_000_000;
const HOUR = 3_600_000;
const SECRET = "server-secret";

const link = (overrides: Partial<Parameters<typeof toViewer>[0]> = {}) => ({
  id: 1,
  token: "tok",
  name: "Alice",
  email: "alice@example.com",
  expiresAt: new Date(NOW + 24 * HOUR),
  revokedAt: null,
  deviceId: null,
  claimedAt: null,
  lastSeenAt: null,
  ...overrides,
});

describe("deriveToken", () => {
  it("is stable for the same person and nonce", () => {
    expect(deriveToken("a@b.com", "Alice", SECRET, "n1")).toBe(deriveToken("a@b.com", "Alice", SECRET, "n1"));
  });

  it("ignores case and surrounding whitespace, so one person gets one identity", () => {
    expect(deriveToken(" A@B.com ", " Alice ", SECRET, "n1")).toBe(deriveToken("a@b.com", "Alice", SECRET, "n1"));
  });

  it("differs for a different person", () => {
    expect(deriveToken("a@b.com", "Alice", SECRET, "n1")).not.toBe(deriveToken("a@b.com", "Bob", SECRET, "n1"));
    expect(deriveToken("a@b.com", "Alice", SECRET, "n1")).not.toBe(deriveToken("c@d.com", "Alice", SECRET, "n1"));
  });

  it("cannot be reproduced without the server secret", () => {
    expect(deriveToken("a@b.com", "Alice", SECRET, "n1")).not.toBe(deriveToken("a@b.com", "Alice", "other", "n1"));
  });

  it("is long enough not to be guessed", () => {
    expect(deriveToken("a@b.com", "Alice", SECRET).length).toBe(43);
  });

  it("is url safe", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(deriveToken(`u${i}@b.com`, "Alice", SECRET)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe("decideAccess", () => {
  it("lets the first device claim the link", () => {
    const decision = decideAccess(link(), "device-a", NOW);

    expect(decision).toEqual({ allowed: true, claims: true });
  });

  it("lets the claiming device come back", () => {
    const decision = decideAccess(link({ deviceId: "device-a", claimedAt: new Date(NOW - HOUR) }), "device-a", NOW);

    expect(decision).toEqual({ allowed: true, claims: false });
  });

  it("turns away a second device with the message the spec asks for", () => {
    const decision = decideAccess(link({ deviceId: "device-a" }), "device-b", NOW);

    expect(decision).toEqual({ allowed: false, code: "in_use", message: "This link is already in use." });
  });

  it("still refuses a second device while the first is idle", () => {
    // Freeing the link when a tab closes would make it first-come-first-served,
    // not single-device. Releasing it is the owner's decision.
    const idle = link({ deviceId: "device-a", lastSeenAt: new Date(NOW - 10 * HOUR) });

    expect(decideAccess(idle, "device-b", NOW).allowed).toBe(false);
  });

  it("lets a new device in once the owner cleared the binding", () => {
    expect(decideAccess(link({ deviceId: null }), "device-b", NOW)).toEqual({ allowed: true, claims: true });
  });

  it("refuses an expired link even to the device that claimed it", () => {
    const expired = link({ deviceId: "device-a", expiresAt: new Date(NOW - 1) });
    const decision = decideAccess(expired, "device-a", NOW);

    expect(decision).toEqual({ allowed: false, code: "expired", message: "This link has expired." });
  });

  it("refuses a revoked link", () => {
    const revoked = link({ deviceId: "device-a", revokedAt: new Date(NOW - HOUR) });

    expect(decideAccess(revoked, "device-a", NOW).allowed).toBe(false);
  });

  it("reports revoked ahead of expired when both apply", () => {
    const both = link({ revokedAt: new Date(NOW - HOUR), expiresAt: new Date(NOW - 1) });
    const decision = decideAccess(both, "d", NOW);

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe("revoked");
  });
});

describe("presence", () => {
  it("counts a viewer that just checked in", () => {
    expect(isWatching(link({ lastSeenAt: new Date(NOW - 5_000) }), NOW)).toBe(true);
  });

  it("drops a viewer that went quiet", () => {
    expect(isWatching(link({ lastSeenAt: new Date(NOW - PRESENCE_WINDOW_MS - 1) }), NOW)).toBe(false);
  });

  it("does not count someone who never arrived", () => {
    expect(isWatching(link({ lastSeenAt: null }), NOW)).toBe(false);
  });

  it("lists only the people actually watching, by name", () => {
    const links = [
      link({ id: 1, name: "Zoe", deviceId: "d1", lastSeenAt: new Date(NOW - 1_000) }),
      link({ id: 2, name: "Adam", deviceId: "d2", lastSeenAt: new Date(NOW - 2_000) }),
      link({ id: 3, name: "Idle", deviceId: "d3", lastSeenAt: new Date(NOW - HOUR) }),
      link({ id: 4, name: "Never", deviceId: null, lastSeenAt: null }),
    ];

    expect(watchersOf(links, NOW).map((v) => v.name)).toEqual(["Adam", "Zoe"]);
  });

  it("does not count a watcher whose link expired mid-session", () => {
    const expired = link({ deviceId: "d", lastSeenAt: new Date(NOW - 1_000), expiresAt: new Date(NOW - 1) });

    expect(watchersOf([expired], NOW)).toHaveLength(0);
  });

  it("never exposes the token to the owner view", () => {
    expect(Object.keys(toViewer(link({ deviceId: "d" }), NOW))).not.toContain("token");
  });
});

describe("statusOf", () => {
  it("reports the lifecycle", () => {
    expect(statusOf(link(), NOW)).toBe("unclaimed");
    expect(statusOf(link({ deviceId: "d" }), NOW)).toBe("active");
    expect(statusOf(link({ deviceId: "d", expiresAt: new Date(NOW - 1) }), NOW)).toBe("expired");
    expect(statusOf(link({ deviceId: "d", revokedAt: new Date(NOW) }), NOW)).toBe("revoked");
  });
});

describe("validateShareInput", () => {
  const future = new Date(NOW + 24 * HOUR).toISOString();

  it("accepts a complete form and normalises the identity", () => {
    const result = validateShareInput({ email: " Alice@Example.COM ", name: " Alice ", expiresAt: future }, NOW);

    expect(result).toMatchObject({ ok: true, email: "alice@example.com", name: "Alice" });
  });

  it("rejects a missing name", () => {
    expect(validateShareInput({ email: "a@b.com", name: "", expiresAt: future }, NOW)).toMatchObject({ ok: false });
  });

  it("rejects an address that is obviously not one", () => {
    for (const email of ["nope", "a@b", "a b@c.com", ""]) {
      expect(validateShareInput({ email, name: "Alice", expiresAt: future }, NOW).ok).toBe(false);
    }
  });

  it("rejects an expiry in the past", () => {
    const result = validateShareInput({ email: "a@b.com", name: "Alice", expiresAt: new Date(NOW - 1).toISOString() }, NOW);

    expect(result).toMatchObject({ ok: false, error: "The expiry date must be in the future." });
  });

  it("rejects an unparseable expiry", () => {
    expect(validateShareInput({ email: "a@b.com", name: "Alice", expiresAt: "whenever" }, NOW).ok).toBe(false);
  });
});

describe("identityOf and shareUrl", () => {
  it("normalises an identity", () => {
    expect(identityOf(" A@B.COM ", "  Bob  ")).toEqual({ email: "a@b.com", name: "Bob" });
  });

  it("builds a link without doubling the slash", () => {
    expect(shareUrl("https://example.com/", "tok")).toBe("https://example.com/analytics/?share=tok");
    expect(shareUrl("https://example.com", "tok")).toBe("https://example.com/analytics/?share=tok");
  });
});
