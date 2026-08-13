import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mutate, query, type ClientConfig } from "./client.js";

/**
 * MCP server exposing OpenTrader to an AI agent.
 *
 * Tool descriptions are written for the model, not for a human reader: they say
 * when to reach for a tool and — for the destructive ones — what it will do with
 * real money. An agent that misreads `close_all_deals` as "tidy up" is a very
 * expensive bug, so the wording is deliberately blunt.
 */

const modeSchema = z
  .enum(["market", "limit"])
  .optional()
  .describe(
    "How to exit. 'market' (default) sells immediately at the best available price — guaranteed exit, taker fee. " +
      "'limit' rests the order on the passive side of the book for a lower fee, but it may never fill. " +
      "Use 'market' whenever the intent is to be out of the position.",
  );

/** Render any tool result as pretty JSON text. */
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
  };
}

export function createServer(config: ClientConfig): McpServer {
  const server = new McpServer({ name: "opentrader", version: "1.0.0" });

  // ---------------------------------------------------------------- read-only

  server.registerTool(
    "list_bots",
    {
      title: "List trading bots",
      description:
        "List every trading bot with its id, name, strategy template, symbol, and whether it is currently running. " +
        "Start here when you need a bot id for any other tool.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return ok(await query(config, "bot.list"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_bot",
    {
      title: "Get one bot",
      description: "Full configuration and status for a single bot, including its strategy settings.",
      inputSchema: { botId: z.number().int().positive().describe("The bot's id, from list_bots") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ botId }) => {
      try {
        return ok(await query(config, "bot.getOne", botId));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_open_deals",
    {
      title: "List a bot's open deals",
      description:
        "List the open deals (smart trades) for one bot — the positions it currently has working on the exchange. " +
        "Each deal has a smartTradeId, which is what close_deal needs. Call this before closing anything so you " +
        "know exactly what exists.",
      inputSchema: { botId: z.number().int().positive().describe("The bot's id, from list_bots") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ botId }) => {
      try {
        return ok(await query(config, "bot.openSmartTrades", { botId }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_bot_logs",
    {
      title: "Get a bot's recent logs",
      description: "Recent log lines for one bot. Useful for explaining why a bot did or did not trade.",
      inputSchema: {
        botId: z.number().int().positive(),
        limit: z.number().int().min(1).max(100).optional().describe("How many lines, default 50"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ botId, limit }) => {
      try {
        return ok(await query(config, "bot.getBotLogs", { botId, limit: limit ?? 50, cursor: null }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // -------------------------------------------------------------- bot control

  server.registerTool(
    "start_bot",
    {
      title: "Start a bot",
      description: "Start a stopped bot so it begins evaluating its strategy and placing orders.",
      inputSchema: { botId: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ botId }) => {
      try {
        return ok(await mutate(config, "bot.start", { botId }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "stop_bot",
    {
      title: "Stop a bot",
      description:
        "Stop a running bot so it stops evaluating its strategy. " +
        "Important: stopping a bot does NOT close its open positions — they stay on the exchange. " +
        "To actually exit positions use close_bot_deals.",
      inputSchema: { botId: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ botId }) => {
      try {
        return ok(await mutate(config, "bot.stop", { botId }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------- closing real money

  server.registerTool(
    "close_deal",
    {
      title: "Force take profit on one deal",
      description:
        "Force-close a single deal (force take profit). Cancels the deal's resting take-profit order and exits the " +
        "position now, realising whatever profit or loss it currently has. " +
        "This places a REAL order on the exchange and cannot be undone. " +
        "Get the smartTradeId from list_open_deals first. " +
        "If the deal's entry never filled there is no position, and this safely just cancels the resting orders.",
      inputSchema: {
        smartTradeId: z.number().int().positive().describe("Deal id, from list_open_deals"),
        mode: modeSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ smartTradeId, mode }) => {
      try {
        return ok(await mutate(config, "smartTrade.close", { smartTradeId, mode: mode ?? "market" }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "close_bot_deals",
    {
      title: "Force close every deal for one bot",
      description:
        "Force-close every open deal belonging to one bot, realising profit or loss on all of them. " +
        "This places REAL orders on the exchange and cannot be undone. " +
        "Returns a per-deal result so you can see exactly which positions closed and which did not. " +
        "Use this to exit a whole strategy; it does not stop the bot, so call stop_bot too if the bot " +
        "should not immediately open new positions.",
      inputSchema: {
        botId: z.number().int().positive().describe("The bot's id, from list_bots"),
        mode: modeSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ botId, mode }) => {
      try {
        return ok(await mutate(config, "smartTrade.closeBotTrades", { botId, mode: mode ?? "market" }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "close_all_deals",
    {
      title: "Panic close every deal on every bot",
      description:
        "Force-close EVERY open deal across EVERY bot and exchange account. This is the panic button. " +
        "It places REAL orders and cannot be undone. " +
        "Only use this when the user has clearly asked to exit everything — never as cleanup, never to fix a " +
        "problem with a single bot, and never on your own initiative. To close one bot use close_bot_deals. " +
        "You must pass confirm: true, which you should only do after the user has explicitly agreed.",
      inputSchema: {
        confirm: z.literal(true).describe("Must be true. Only set this after the user explicitly asked to close everything."),
        mode: modeSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ confirm, mode }) => {
      try {
        return ok(await mutate(config, "smartTrade.closeAll", { confirm, mode: mode ?? "market" }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
