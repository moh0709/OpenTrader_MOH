import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { appRouter } from "@opentrader/trpc";
import { dashboardRestRoutes } from "./rest/dashboard-routes.js";
import { createContext } from "./trpc.js";

// Path to the current file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type CreateServerOptions = {
  frontendDistPath: string;
  /**
   * Static root for the analytics dashboard, served at `/analytics/`.
   *
   * Kept separate from `frontendDistPath` because the bundled frontend is
   * replaced wholesale by `pnpm ui:sync`, which removes the directory first.
   */
  dashboardUiPath?: string;
  port: number;
  host: string;
};

/**
 * Creates and configures a Fastify server instance with specified options.
 *
 * @param params - The options for creating the server.
 */
export const createServer = (params: CreateServerOptions) => {
  const fastify = Fastify({
    logger: false, // Set to true to enable logging
    maxParamLength: 1000,
  });
  const staticDir = path.join(__dirname, params.frontendDistPath);

  fastify.register(fastifyCors, {
    origin: true,
  });

  fastify.register(fastifyStatic, {
    root: staticDir,
    prefix: "/", // optional: default '/'
  });

  if (params.dashboardUiPath) {
    fastify.register(fastifyStatic, {
      root: path.join(__dirname, params.dashboardUiPath),
      prefix: "/analytics/",
      // Only the first registration may decorate the reply object.
      decorateReply: false,
    });
  }

  fastify.register(fastifyTRPCPlugin, {
    prefix: "/api/trpc",
    trpcOptions: {
      router: appRouter,
      createContext,
    },
  });

  // Plain JSON surface for automation, alongside the tRPC router the UI uses.
  fastify.register(dashboardRestRoutes, { prefix: "/api/dash" });

  return {
    app: fastify,
    server: fastify.server,
    listen: async () => {
      await fastify.listen({ port: params.port, host: params.host });
    },
    close: async () => {
      await fastify.close();
    },
  };
};
