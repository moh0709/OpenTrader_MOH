import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContext } from "./trpc.js";

/**
 * The tRPC context decides whether a caller may close real positions.
 *
 * `smartTrade.closeAll` sits behind it, so "who is allowed in" is not a detail
 * here — it is the whole security boundary of the surface the MCP server drives.
 *
 * These tests exist because the check once read
 * `req.headers.authorization === process.env.ADMIN_PASSWORD` directly. With
 * `ADMIN_PASSWORD` unset that compared `undefined === undefined`, which is true,
 * so an unauthenticated request was authenticated as Admin on a daemon that was
 * trading real money. The `undefined` case is tested first, deliberately, because
 * it is the one that reads like a paradox and is therefore the one a future
 * refactor is most likely to reintroduce.
 */

type Ctx = ReturnType<typeof createContext>;

const context = (headers: Record<string, string | undefined> = {}): Ctx =>
  createContext({
    req: { headers } as unknown as Parameters<typeof createContext>[0]["req"],
    res: {} as never,
    info: {} as never,
  } as Parameters<typeof createContext>[0]);

const original = process.env.ADMIN_PASSWORD;

beforeEach(() => {
  process.env.ADMIN_PASSWORD = "a-long-enough-secret";
});

afterEach(() => {
  if (original === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = original;
});

describe("tRPC auth", () => {
  it("refuses a caller who presents no credentials at all", () => {
    delete process.env.ADMIN_PASSWORD;

    // The regression: this used to authenticate, because a missing header and a
    // missing configured password are both `undefined` and `undefined === undefined`.
    expect(context({}).user).toBeNull();
    expect(context({ authorization: undefined }).user).toBeNull();
  });

  it("refuses a wrong password, including one that merely resembles it", () => {
    expect(context({ authorization: "wrong" }).user).toBeNull();
    expect(context({ authorization: "a-long-enough-secre" }).user).toBeNull();
    expect(context({ authorization: "a-long-enough-secrets" }).user).toBeNull();
    expect(context({ authorization: "a-long-enough-secret " }).user).toBeNull();
  });

  it("refuses an empty password rather than matching an empty config", () => {
    process.env.ADMIN_PASSWORD = "";

    expect(context({ authorization: "" }).user).toBeNull();
  });

  it("admits the admin password", () => {
    expect(context({ authorization: "a-long-enough-secret" }).user).not.toBeNull();
  });

  it("does not admit a read-only agent token to the unscoped tRPC surface", () => {
    // tRPC has no per-endpoint scope, so admitting a `read` token at all would
    // hand it every mutation. It is refused here and reads via REST instead.
    expect(context({ authorization: "tok_abc", "x-agent-token": "tok_abc" }).user).toBeNull();
  });
});
