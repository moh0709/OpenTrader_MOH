import { type CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";

import { trpc, appRouter, agentAccess, type Context } from "@opentrader/trpc";

const ctx = {
  user: {
    id: 1,
    email: "onboarding@opentrader.pro",
    displayName: "OpenTrader",
    role: "Admin" as const,
  },
};

/**
 * created for each request
 *
 * Auth is delegated to `agentAccess.authenticate`, which is the same hardened
 * check the REST dashboard uses: constant-time comparison, and it refuses
 * outright when no admin password is configured.
 *
 * It previously read `password === process.env.ADMIN_PASSWORD` directly, which
 * was an open door in one specific and very bad case: with `ADMIN_PASSWORD`
 * unset, `process.env.ADMIN_PASSWORD` is `undefined`, and a request that simply
 * omits the Authorization header gives `req.headers.authorization` as
 * `undefined` too — so `undefined === undefined` is **true** and every caller
 * was authenticated as Admin. That granted the full tRPC surface, including
 * `smartTrade.closeAll`, to anyone who could reach the port. Comparing against
 * the environment directly also leaked the password one character at a time.
 *
 * The lesson is the general one: never compare a caller-supplied credential to
 * a possibly-absent one with `===`, because "no credential" and "no password
 * configured" are both `undefined` and compare equal.
 */
export const createContext = ({ req }: CreateFastifyContextOptions): Context => {
  const actor = agentAccess.authenticate(
    {
      authorization: req.headers.authorization,
      agentToken: req.headers["x-agent-token"] as string | undefined,
    },
    process.env.ADMIN_PASSWORD,
  );

  // Agent tokens are deliberately read-only here and never gain Admin on the
  // tRPC surface: that surface has no per-endpoint scope, so a `read` token
  // must not be admitted at all rather than admitted everywhere.
  if (actor?.kind === "admin") return ctx;

  return {
    user: null,
  };
};

const createCaller = trpc.createCallerFactory(appRouter);
export const tServer = createCaller(ctx); // @deprecated
