import { describe, expect, it } from "vitest";
import { preflightWarnings } from "./preflight.js";

const ids = (warnings: { id: string }[]) => warnings.map((w) => w.id);

const check = (over: Partial<Parameters<typeof preflightWarnings>[0]> = {}) =>
  preflightWarnings({
    env: { ADMIN_PASSWORD: "a-long-enough-secret" },
    host: "localhost",
    statFile: () => null,
    ...over,
  });

describe("preflightWarnings", () => {
  it("says nothing about a sound configuration", () => {
    expect(check()).toEqual([]);
  });

  it("catches a missing password", () => {
    expect(ids(check({ env: {} }))).toContain("password.missing");
    expect(ids(check({ env: { ADMIN_PASSWORD: "   " } }))).toContain("password.missing");
  });

  it("catches the passwords this repository ships in its own docs", () => {
    // docker-compose.yml and the README both use "opentrader".
    for (const password of ["opentrader", "OpenTrader", "password", "admin", "changeme"]) {
      expect(ids(check({ env: { ADMIN_PASSWORD: password } }))).toContain("password.default");
    }
  });

  it("catches a short password without calling it a default", () => {
    const warnings = ids(check({ env: { ADMIN_PASSWORD: "hunter2" } }));

    expect(warnings).toContain("password.short");
    expect(warnings).not.toContain("password.default");
  });

  it("reports one password problem, not three", () => {
    // A missing password is not also a short password. Stacking them would bury
    // the one thing to fix under restatements of it.
    expect(ids(check({ env: {} })).filter((id) => id.startsWith("password."))).toHaveLength(1);
  });

  it("warns when bound anywhere reachable from off the machine", () => {
    for (const host of ["0.0.0.0", "::", ""]) {
      expect(ids(check({ host }))).toContain("network.public");
    }
  });

  it("stays quiet when bound to the loopback", () => {
    for (const host of ["localhost", "127.0.0.1"]) {
      expect(ids(check({ host }))).not.toContain("network.public");
    }
  });

  it("warns about a database other users on the host can read", () => {
    // It holds exchange API keys and the AI provider key in plain text.
    const warnings = ids(
      check({ databasePath: "/app/data/dev.db", statFile: () => ({ mode: 0o100644 }) }),
    );

    expect(warnings).toContain("database.permissions");
  });

  it("accepts a database only its owner can read", () => {
    expect(
      ids(check({ databasePath: "/app/data/dev.db", statFile: () => ({ mode: 0o100600 }) })),
    ).not.toContain("database.permissions");
  });

  it("says nothing about a database file it cannot stat", () => {
    expect(ids(check({ databasePath: "/nope.db", statFile: () => null }))).not.toContain("database.permissions");
  });

  it("reports every independent problem at once", () => {
    const warnings = ids(
      check({
        env: { ADMIN_PASSWORD: "opentrader" },
        host: "0.0.0.0",
        databasePath: "/app/data/dev.db",
        statFile: () => ({ mode: 0o100666 }),
      }),
    );

    expect(warnings).toEqual(["password.default", "network.public", "database.permissions"]);
  });
});
