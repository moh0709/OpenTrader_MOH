import superjson from "superjson";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { appRouter } from "@opentrader/trpc";

import { getSettings } from "./utils/settings.js";

export const createDaemonRpcClient = () => {
  const { host, port } = getSettings();

  const DAEMON_URL = `http://${host}:${port}/api/trpc`;

  /*
   * The suppression is on the router constraint and nothing else.
   *
   * Under `moduleResolution: NodeNext`, `@trpc/server` resolves to two
   * declaration files from one installed copy — one under
   * `resolution-mode: "import"`, one without — and the `AnyRouter` in each is a
   * distinct nominal type. `appRouter` is typed through one of them and
   * `createTRPCProxyClient`'s `Router<any, any>` constraint is expressed in the
   * other, so the check can never pass however the type is written.
   *
   * Widening the parameter instead (to `AnyRouter`, or an intersection) throws
   * away the per-procedure types and every call below stops being checked. This
   * keeps them: only the constraint is skipped.
   */
  // @ts-expect-error -- see above: two nominal AnyRouters from one @trpc/server.
  return createTRPCProxyClient<typeof appRouter>({
    links: [
      httpBatchLink({
        url: DAEMON_URL,
        // tRPC v11 moved the transformer from the client root onto the link.
        // It was still being passed at the root, where v11 ignores it — so the
        // CLI was talking superjson to a superjson daemon without encoding.
        transformer: superjson,
        headers: () => ({
          Authorization: process.env.ADMIN_PASSWORD,
        }),
      }),
    ],
  });
};
