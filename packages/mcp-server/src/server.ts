import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mutate, query, rest, type ClientConfig } from "./client.js";

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

  server.registerTool(
    "scan_arbitrage",
    {
      title: "Scan cross-venue arbitrage",
      description:
        "Compare live order books across exchanges for one symbol and report whether any route is actually " +
        "profitable. Read-only — it places no orders. " +
        "Each route reports two numbers: the top-of-book spread, and the spread that survives walking real " +
        "order-book depth to the requested size and paying taker fees on both legs. Quote the second one. " +
        "The first is almost always flattering and is how naive scanners report opportunities that lose money. " +
        "On liquid pairs the honest answer is usually that no edge exists; say so plainly rather than " +
        "presenting the top-of-book number as an opportunity.",
      inputSchema: {
        symbol: z.string().optional().describe("Market to scan, default BTC/USDT"),
        tradeQty: z.number().positive().optional().describe("Base size to price the spread at, default 0.01"),
        venues: z.array(z.string()).optional().describe("Exchange codes to compare; defaults to all supported"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, tradeQty, venues }) => {
      try {
        return ok(
          await query(config, "arbitrage.scan", {
            symbol: symbol ?? "BTC/USDT",
            tradeQty: tradeQty ?? 0.01,
            ...(venues ? { venues } : {}),
          }),
        );
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
    "open_deal",
    {
      title: "Force-open a new deal",
      description:
        "Open a new position immediately, bypassing the bot's strategy. This places a REAL order on the " +
        "exchange and cannot be undone. " +
        "Use it only when the user has asked for a specific position — never to 'replace' a deal you just " +
        "closed, never to average down, and never on your own reading of the market. The bots have their own " +
        "entry rules; this tool exists to override them deliberately, not to second-guess them. " +
        "Size with quoteAmount (spend N of the quote currency) or quantity (N of the base currency). " +
        "The server enforces hard limits on order size, open position count, daily total and permitted symbols; " +
        "if a request exceeds them it is REFUSED outright rather than shrunk, and the reasons are returned — " +
        "do not retry a refused request with a smaller size unless the user asks you to.",
      inputSchema: {
        botId: z.number().int().positive().describe("Bot supplying the exchange account and default symbol"),
        symbol: z.string().optional().describe("Defaults to the bot's own symbol"),
        side: z.enum(["buy", "sell"]),
        quantity: z.number().positive().optional().describe("Size in base currency, e.g. 0.01 BTC"),
        quoteAmount: z.number().positive().optional().describe("Size in quote currency, e.g. 50 USDT"),
        orderType: z.enum(["market", "limit"]).optional().describe("Defaults to market"),
        price: z.number().positive().optional().describe("Required for a limit entry"),
        takeProfitPrice: z.number().positive().optional().describe("Optional resting exit once the entry fills"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return ok(await mutate(config, "smartTrade.open", { ...args, orderType: args.orderType ?? "market" }));
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
        confirm: z
          .literal(true)
          .describe("Must be true. Only set this after the user explicitly asked to close everything."),
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

  // ------------------------------------------------- the desk's own reasoning

  server.registerTool(
    "get_trading_head",
    {
      title: "Read the autonomous trading head",
      description:
        "Everything about the autonomous trading head in one read: whether it is armed, whether it is in observe or " +
        "live mode, its watchlist and limits, the positions it currently holds, and its recent decisions with the " +
        "reason each one gave. This is the tool for 'what is the AI doing and why'. " +
        "Deliberately one call rather than four — reading the policy from one call and the positions from another " +
        "invites reporting a decision next to a position it has already closed. " +
        "Note that most minutes end in 'hold', so an empty decision list usually means the head is not running: " +
        "check the `head` block and health_report before concluding the market is quiet.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Recent decisions to return, default 25"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }) => {
      try {
        return ok(await rest(config, "/autopilot", { params: { limit: limit ?? 25 } }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_council_conclusion",
    {
      title: "Read the research council's conclusion",
      description:
        "The research council's standing conclusion per symbol: the bull and bear cases, the conviction it " +
        "assigned, and the capital cap the governor holds each bot at as a result. " +
        "Use get_council_transcript for the actual analyst reports and the debate behind the number. " +
        "This is the deep twice-daily research run, which is a different thing from the per-minute trading head: it " +
        "is context, not an instruction, and it can be days old. The governor using it is reduce-only by " +
        "construction — it can throttle a bot's capital and can never raise it.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return ok(await rest(config, "/regime"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_council_transcript",
    {
      title: "Read the council's full analyst debate",
      description:
        "The full analyst reports and bull/bear debate behind one symbol's latest conviction. " +
        "This is the reasoning, not the verdict — reach for it when you need to know *why* the council concluded " +
        "what it did, or when asked to explain a capital-cap change. " +
        "It is a long document by nature; do not fetch it speculatively for every symbol.",
      inputSchema: {
        symbol: z.string().describe("The market to read, e.g. BTC/USDT"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol }) => {
      try {
        return ok(await rest(config, "/regime/transcript", { params: { symbol } }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_ai_activity",
    {
      title: "Read what the AI has been doing",
      description:
        "The AI action feed: every council call, order, risk block, capital-cap change and settings change the " +
        "system made, newest last. This is the causal record — it answers 'the desk stood still, what did it " +
        "think?', where get_trading_head answers only what it last decided. " +
        "The cursor is a SEQUENCE NUMBER, not a timestamp: pass since: 0 on the first call to get a cursor, then " +
        "pass that cursor back. Passing a timestamp silently returns nothing, and passing 0 every time replays the " +
        "whole buffer. The buffer is in-memory and does not survive a daemon restart — the response reports " +
        "`restarted: true` when your session is stale, so you can tell 'nothing happened' from 'the record was " +
        "lost'.",
      inputSchema: {
        since: z.number().int().min(0).optional().describe("Sequence cursor; 0 on the first call"),
        session: z.string().optional().describe("Session id from a previous response"),
        limit: z.number().int().min(1).max(500).optional().describe("Max entries, default 200"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ since, session, limit }) => {
      try {
        return ok(
          await rest(config, "/ai/actions", {
            params: { since: since ?? 0, ...(session ? { session } : {}), limit: limit ?? 200 },
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_health_report",
    {
      title: "Read platform health",
      description:
        "The platform health checks with an ok/warn/crit rollup: daemon, API, market-data freshness, exchange " +
        "connectivity, bots, orders, database, and the AI's own journal and budget. " +
        "Check this whenever the desk is not behaving as expected — the most expensive failure modes (stale market " +
        "data, a refused entry, a capital cap, an unreadable journal) all look exactly like 'the market is quiet' " +
        "from the outside, and this is what distinguishes them. " +
        "Crit entries name the specific error; report it rather than retrying and hoping. " +
        "Two to expect routinely: a restart disables every bot (the system's own orphan-cleanup, not a fault), and " +
        "an unreadable journal restricts the head to exits only.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return ok(await rest(config, "/health"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_performance",
    {
      title: "Read realised performance",
      description:
        "Realised performance: closed round trips with net profit after fees, win rate, average P&L and P&L per " +
        "hour, plus the per-bot leaderboard. This is the tool for 'is this actually performing'. " +
        "Figures are net of fees — the entry fee actually charged plus the estimated exit fee — so a strategy that " +
        "only clears its costs by a basis point does not look like one that comfortably clears them. " +
        "Two honest caveats. Realised P&L is not the whole picture: open positions carry unrealised P&L excluded " +
        "here, so read get_trading_head or list_open_deals before calling a book 'flat' or 'winning'. And a small " +
        "sample proves nothing — a handful of round trips is not an edge, and neither is a good week.",
      inputSchema: {
        botId: z.number().int().positive().optional().describe("Restrict to one bot"),
        metric: z
          .enum(["netPnl", "pnlPercent", "trades", "winRate", "averagePnl", "pnlPerHour"])
          .optional()
          .describe("Leaderboard ranking metric, default netPnl"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ botId, metric }) => {
      try {
        return ok(
          await rest(config, "/snapshot", { params: { ...(botId ? { botId } : {}), ...(metric ? { metric } : {}) } }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // -------------------------------------------------------- head arm / disarm

  server.registerTool(
    "set_head_mode",
    {
      title: "Arm or disarm the trading head",
      description:
        "Switch the autonomous trading head on or off, or move it between observe and live. " +
        "'observe' plans and journals every decision without placing anything — it is how you find out what the " +
        "head would have done before it does it, and it is the default. Only 'live' places real orders. " +
        "CRITICAL: disarming does NOT close open positions. It stops the head deciding; everything it already " +
        "holds stays on the exchange with nothing managing it. To actually exit, use close_bot_deals. " +
        "Moving a running head to live starts it trading real money, so only do it when the user has asked for " +
        "that specifically.",
      inputSchema: {
        armed: z.boolean().describe("true to switch the head on, false to switch it off"),
        mode: z
          .enum(["observe", "live"])
          .optional()
          .describe("Defaults to observe — arming and going live are separate decisions"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ armed, mode }) => {
      try {
        const path = armed ? "/actions/autopilot.arm" : "/actions/autopilot.disarm";
        const body = armed ? { mode: mode ?? "observe" } : {};

        return ok(await rest(config, path, { method: "POST", body }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "run_head_pass",
    {
      title: "Run one trading head pass now",
      description:
        "Run a single trading head pass immediately instead of waiting for its interval, and return what it decided " +
        "for every symbol. It does exactly what the next scheduled pass would have done and no more — but if the " +
        "head is live, that pass places real orders, so this is NOT a dry run. A head in observe mode is the honest " +
        "way to preview what it would do. " +
        "Cooldown and minimum-hold rules still apply, so this will often correctly report that the head may not act " +
        "yet. That is an answer, not a failure — report it rather than retrying to force a trade.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async () => {
      try {
        return ok(await rest(config, "/actions/autopilot.runNow", { method: "POST", body: {} }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
