/**
 * Plain REST surface for the dashboard, aimed at automation.
 *
 * The dashboard UI itself could use the tRPC router, but a tRPC URL carries a
 * superjson envelope and a JSON-encoded query string, which is awkward for an
 * external agent, a shell script or a workflow tool. These routes expose the
 * same data as ordinary JSON so that driving OpenTrader from outside is a plain
 * HTTP call.
 *
 * Both surfaces call the same builders in `services/dashboard-views`, so the
 * numbers an agent reads are by construction the numbers on screen.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eventBus } from "@opentrader/event-bus";
import { xprisma } from "@opentrader/db";
import { findStrandedPositions, recoverPositions } from "../processing/executors/recover-position.js";
import { previewPurge, purgeBotTrades, setBotLimits } from "../processing/executors/purge-bot.js";
import { clearUnbackedPositions, findUnbackedPositions } from "../processing/executors/unbacked-position.js";
import {
  blockedSince,
  createShare,
  currentWatchers,
  deleteShare,
  listShares,
  publicBaseUrl,
  releaseDevice,
  revokeShare,
} from "../processing/share/share.service.js";
import { applyRegimeGovernor, requestResearchRun } from "@opentrader/regime";
import {
  aiActivity,
  chatCompletionDetailed,
  listModelCatalog,
  migrateProviderChoice,
  probeProvider,
  recordAiAction,
  resolveProvider,
  setRuntimeProvider,
  type AiActionRecord,
  type ModelInfo,
  type ProviderId,
} from "@opentrader/ai-team";
import {
  ALLOWED_ACTIONS,
  SYSTEM_PROMPT,
  buildUserTurn,
  extractProposals,
  validateProposal,
  type ChatContext,
  type ChatMessage,
  type Proposal,
} from "./ai-chat.js";
import { createAiGuards } from "./ai-guard.js";
import { applyLearning, dismissLearning, evaluateLearning, revertLearning } from "../learning/learning.service.js";
import { disarmRegime, syncRegime } from "../regime/regime.service.js";
import { logger } from "@opentrader/logger";
import type {
  Actor,
  AgentActionRecord,
  BotLogRow,
  BucketSize,
  DashboardEvent,
  HealthCheck,
  HealthStatus,
  LeaderboardMetric,
} from "@opentrader/trpc";
import {
  BotService,
  RateLimiter,
  agentAccess,
  rollUp,
  buildEventsView,
  buildGridView,
  buildHealthView,
  buildHistoryView,
  buildPositionsView,
  buildSnapshot,
  buildTradesView,
  dashboardService,
  derive,
} from "@opentrader/trpc";

/** The dashboard runs as the single local user, matching the tRPC context. */
const OWNER_ID = 1;

const num = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
};

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * Control actions in the words the AI action feed shows.
 *
 * The title says what happened; the consequence says what it means. Stopping a
 * bot in particular is not a neutral act — OpenTrader cancels the resting exit,
 * which is how a fleet ends up holding stock with nothing to sell it — and the
 * feed is the place an operator is most likely to notice.
 */
const CONTROL_PHRASE: Record<string, string> = {
  "bot.start": "Bot started",
  "bot.stop": "Bot stopped",
  "bot.restart": "Bot restarted",
  "bot.purgeTrades": "Trades purged",
  "bot.setLimits": "Limits changed",
  "position.recoverStranded": "Exits replaced",
};

const CONTROL_CONSEQUENCE: Record<string, string> = {
  "bot.start": "It is trading again",
  "bot.stop": "Its resting exit orders were cancelled, so any open position now has no sell order",
  "bot.restart": "It was stopped and started again",
  "bot.purgeTrades": "Every trade of this bot was deleted, and that cannot be undone",
  "bot.setLimits": "Its capital cap or minimum profit changed",
  "position.recoverStranded": "Replacement exit orders were placed at their original targets",
};

type RegimePolicyRow = {
  botId: number;
  baselineMaxCapital: number | null;
  baselineMinProfit: number | null;
  armed: boolean;
  floorFactor: number;
  maxAgeMs: number;
};

type RegimeConvictionRow = {
  symbol: string;
  stance: string;
  confidence: number;
  asOf: bigint;
  summary: string;
  model: string | null;
  costUsd: number | null;
};

type LearningRow = {
  id: number;
  botId: number;
  botName: string;
  symbol: string;
  trigger: string;
  lossStreak: number;
  stats: string;
  analysis: string;
  proposal: string;
  status: string;
  model: string | null;
  createdAt: Date;
};

/** JSON.parse that yields {} instead of throwing on a malformed stored blob. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

type AuthedRequest = FastifyRequest & { actor?: Actor };

/**
 * What the AI may do unattended, spend, and whether it may act at all.
 *
 * Module scope rather than per-registration, so the limits survive anything
 * that re-registers the plugin and cannot be reset by asking again.
 */
const aiGuards = createAiGuards();

/**
 * The last time we actually asked the provider something, and what happened.
 *
 * The health check used to report a configured provider as `ok` without ever
 * contacting it, so a provider that had never once answered showed green. The
 * fix is not to probe on every health poll — that would bill the operator for
 * looking at a dashboard — but to report what the real calls already know.
 * Anything that genuinely talks to the provider records the result here.
 */
let lastProviderOutcome: { at: number; ok: boolean; reason: string } | null = null;

function recordProviderOutcome(outcome: { ok: boolean; reason?: string }) {
  lastProviderOutcome = { at: Date.now(), ok: outcome.ok, reason: outcome.reason ?? "" };
}

/**
 * The AI's own health, as ordinary health checks.
 *
 * Three separate questions, because an operator needs to tell them apart: is a
 * provider configured at all, has the AI been switched off, and is it about to
 * run out of budget. "The AI is quiet" has very different causes and none of
 * them were visible on the health page before.
 *
 * A provider that is simply not configured is `ok`, not a warning — running
 * deterministic-only is a supported way to run, not a fault. A provider that is
 * configured but has never answered is `unknown` until something asks it, and
 * `crit` once something has and it refused: configured is not the same as
 * working, and the page should not claim otherwise.
 */
/**
 * Positions the exchange never actually filled.
 *
 * An entry is only real if an exchange gave it an order id. A row that reads
 * `Filled` with no id was written by something that decided a position exists
 * without buying it, and every number derived from it - cost basis, floating
 * P&L, the exposure a risk watchdog reads, the committed capital a cap is
 * compared against - is wrong by that amount.
 *
 * `entry-integrity.ts` stops new ones being created. This is the smoke alarm:
 * if the count is ever non-zero again, some path found its way around the rule,
 * and no exposure figure on this fleet can be trusted until it is found.
 */
async function phantomPositionCheck(): Promise<HealthCheck> {
  const orders = await xprisma.order.findMany({
    where: {
      entityType: { in: ["EntryOrder", "SafetyOrder"] },
      status: "Filled",
      exchangeOrderId: null,
      // Only positions still open. A closed one is a scar in the history rather
      // than a live risk, and counting those would leave the alarm permanently
      // red with nothing left to act on.
      smartTrade: {
        orders: { none: { entityType: { in: ["TakeProfitOrder", "StopLossOrder"] }, status: "Filled" } },
      },
    },
    select: { quantity: true, price: true, filledPrice: true },
  });

  const capital = orders.reduce((total, order) => total + (order.filledPrice ?? order.price ?? 0) * order.quantity, 0);
  const plural = orders.length === 1 ? "entry is" : "entries are";

  return {
    id: "positions.phantom",
    group: "Orders",
    label: "Unbacked positions",
    status: orders.length === 0 ? "ok" : "crit",
    value: orders.length === 0 ? "none" : `${orders.length}`,
    detail:
      orders.length === 0
        ? "Every open position was filled by the exchange and can be sold back to it."
        : `${orders.length} ${plural} marked filled with no exchange order behind them, carrying ` +
          `${capital.toFixed(2)} of cost basis that was never spent. Exposure, P&L and capital caps are ` +
          `all wrong by that amount until these are cleared.`,
    metric: orders.length,
  };
}

function aiHealthChecks(): HealthCheck[] {
  const provider = resolveProvider();
  const budget = aiGuards.budget.spent();
  const stopped = aiGuards.killSwitch.isStopped();

  const checks: HealthCheck[] = [
    {
      id: "ai.provider",
      group: "AI",
      label: "AI provider",
      status: !provider?.model ? "ok" : !lastProviderOutcome ? "unknown" : lastProviderOutcome.ok ? "ok" : "crit",
      value: provider?.model ? `${provider.id} · ${provider.model}` : "not configured",
      detail: !provider?.model
        ? "No provider is set, so the council runs deterministic-only. That is a supported configuration, not a fault."
        : !lastProviderOutcome
          ? "Configured, but nothing has asked it anything yet, so whether it answers is unverified. Use Test in AI settings to find out. Trading never blocks on it either way."
          : lastProviderOutcome.ok
            ? `Answered at ${new Date(lastProviderOutcome.at).toISOString()}. Trading never blocks on it: every failure path falls back to the deterministic agents.`
            : `Refused at ${new Date(lastProviderOutcome.at).toISOString()}: ${lastProviderOutcome.reason} — the chat cannot answer until this is fixed. Trading is unaffected; the council falls back to its deterministic agents.`,
      metric: null,
    },
    {
      id: "ai.switch",
      group: "AI",
      label: "AI enabled",
      status: stopped ? "warn" : "ok",
      value: stopped ? "switched off" : "on",
      detail: stopped
        ? "Someone stopped the AI, or AI_DISABLED=1 is set. It will not answer or act until it is switched back on."
        : "The AI may answer and, when you approve or arm it, act.",
      metric: null,
    },
  ];

  // Only worth a row when there is a ceiling to be near.
  if (budget.limit > 0) {
    const used = Math.round((budget.used / budget.limit) * 100);

    checks.push({
      id: "ai.budget",
      group: "AI",
      label: "AI token budget",
      status: used >= 100 ? "crit" : used >= 80 ? "warn" : "ok",
      value: `${used}% of ${budget.limit.toLocaleString()}`,
      detail: `${budget.used.toLocaleString()} tokens used on ${budget.day}. At 100% the chat stops answering until midnight UTC; raise AI_DAILY_TOKEN_BUDGET to change the ceiling.`,
      metric: used,
    });
  }

  return checks;
}

export async function dashboardRestRoutes(fastify: FastifyInstance) {
  /** Authenticate every route in this plugin and apply the read rate limit. */
  fastify.addHook("preHandler", async (request: AuthedRequest, reply: FastifyReply) => {
    const actor = agentAccess.authenticate(
      {
        authorization: request.headers.authorization,
        agentToken: request.headers["x-agent-token"] as string | undefined,
      },
      process.env.ADMIN_PASSWORD,
    );

    if (!actor) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Provide the admin password in the Authorization header, or an agent token in X-Agent-Token.",
      });
    }

    const limit = agentAccess.readLimiter.check(actor.name);
    if (!limit.allowed) {
      return reply
        .code(429)
        .header("retry-after", Math.ceil(limit.retryAfterMs / 1000))
        .send({ error: "rate_limited", retryAfterMs: limit.retryAfterMs });
    }

    request.actor = actor;
  });

  const derived = () => dashboardService.getContext(OWNER_ID).then(derive);

  /**
   * Self-describing catalogue.
   *
   * An agent can read this to discover what it may call and with which
   * arguments, rather than having the contract hard-coded against it.
   */
  fastify.get("/manifest", async (request: AuthedRequest) => ({
    name: "opentrader-dashboard",
    version: 1,
    description: "Read trading analytics and control bots on this OpenTrader instance.",
    authentication: {
      header: "X-Agent-Token",
      fallback: "Authorization (admin password)",
      yourScope: request.actor?.scope ?? null,
      yourName: request.actor?.name ?? null,
    },
    controlEnabled: !agentAccess.isFrozen(),
    queries: [
      { path: "GET /api/dash/snapshot", params: { metric: "netPnl|pnlPercent|trades|winRate|averagePnl|pnlPerHour", recentTradeLimit: "number" }, description: "Fleet overview, per-bot stats and leaderboard." },
      { path: "GET /api/dash/health", params: {}, description: "Health checks with an ok/warn/crit rollup." },
      { path: "GET /api/dash/trades", params: { botId: "number", symbol: "string", outcome: "win|loss|breakeven", from: "epoch ms", to: "epoch ms", sort: "exitAt|netPnl|pnlPercent|holdMs", direction: "asc|desc", limit: "1-500", offset: "number" }, description: "Closed round trips with realised profit." },
      { path: "GET /api/dash/positions", params: { botId: "number", state: "live|abandoned|missing", includePending: "boolean" }, description: "Open positions, abandoned positions and resting entry orders." },
      { path: "GET /api/dash/grid", params: { botId: "number" }, description: "Grid ladder state per level." },
      { path: "GET /api/dash/history", params: { botId: "number", bucket: "5m|15m|1h|4h|1d", from: "epoch ms", to: "epoch ms" }, description: "Equity curve and distributions." },
      { path: "GET /api/dash/events", params: { since: "epoch ms cursor, 0 to initialise", limit: "1-200" }, description: "Events since a cursor. Pass 0 first to get a cursor without replaying history." },
      { path: "GET /api/dash/logs", params: { botId: "number", limit: "1-200" }, description: "Recent bot log entries." },
      { path: "GET /api/dash/actions/log", params: { since: "epoch ms" }, description: "Audit trail of control actions." },
      { path: "GET /api/dash/ai/actions", params: { since: "sequence cursor, 0 to initialise", session: "session id from a previous response", limit: "1-500" }, description: "What the AI has done, newest last: council calls, orders, risk blocks, cap changes and settings changes. In-memory since the daemon started; the cursor is a sequence number, not a timestamp." },
      { path: "GET /api/dash/ai/status", params: {}, description: "Whether the AI is configured, switched on, how many unattended actions it has left, and today's token spend against its budget." },
      { path: "GET /api/dash/positions/stranded", params: { botId: "number" }, description: "Positions holding stock with no exit order, and what recovery would place for each. Read-only dry run." },
      { path: "GET /api/dash/bots/:botId/purge-preview", params: {}, description: "What purging a bot would delete, and whether it is currently allowed. Read-only." },
      { path: "GET /api/dash/bots/:botId/limits", params: {}, description: "A bot's capital cap and minimum profit." },
      { path: "GET /api/dash/regime", params: {}, description: "Research convictions per symbol and the capital cap the governor holds each bot at." },
      { path: "GET /api/dash/regime/history", params: { limit: "1-200" }, description: "Conviction history per symbol, oldest first, for drawing how the council changed its mind." },
      { path: "GET /api/dash/regime/transcript", params: { symbol: "string" }, description: "The full analyst reports and bull/bear debate behind a symbol's latest conviction." },
      { path: "GET /api/dash/regime/runs", params: { limit: "1-200" }, description: "Recent research runs with cost and duration." },
      { path: "GET /api/dash/shares", params: {}, description: "Share links, their status and who is watching." },
      { path: "GET /api/dash/shares/watchers", params: {}, description: "Recipients watching a shared feed right now." },
    ],
    actions: [
      { path: "POST /api/dash/actions/bot.start", body: { botId: "number" }, scope: "control", description: "Start a bot." },
      { path: "POST /api/dash/actions/bot.stop", body: { botId: "number" }, scope: "control", description: "Stop a bot. Resting exit orders are cancelled, which strands any open position." },
      { path: "POST /api/dash/actions/bot.restart", body: { botId: "number" }, scope: "control", description: "Stop then start a bot." },
      { path: "POST /api/dash/actions/position.recoverStranded", body: { botId: "number, optional", limit: "1-200, default 25" }, scope: "control", description: "Place replacement exit orders for stranded positions at their original target prices. Check GET /positions/stranded first." },
      { path: "POST /api/dash/actions/bot.purgeTrades", body: { botId: "number" }, scope: "control", description: "Delete every trade of a bot, open and closed. Destructive and irreversible. Cancels live orders first and refuses while the bot is running. Check the purge-preview first." },
      { path: "POST /api/dash/actions/bot.setLimits", body: { botId: "number", maxCapital: "number, 0 clears", minProfit: "number, 0 clears" }, scope: "control", description: "Cap the capital a bot may commit at once, and the minimum profit a cycle must make before its exit is allowed to close." },
      { path: "POST /api/dash/shares", body: { name: "string", email: "string", expiresAt: "ISO date" }, scope: "control", description: "Issue a read-only live-feed link for one person, on one device, until the expiry. Emails it and returns the URL." },
      { path: "POST /api/dash/shares/:id/revoke | /release", body: {}, scope: "control", description: "Revoke a link, or free it from the device holding it." },
      { path: "DELETE /api/dash/shares/:id", body: {}, scope: "control", description: "Delete a share link." },
      { path: "POST /api/dash/actions/regime.setPolicy", body: { botId: "number", baselineMaxCapital: "number, defaults to the bot's current cap", armed: "boolean", floorFactor: "0-1", maxAgeMs: "number" }, scope: "control", description: "Put a bot under regime management. The baseline is the governor's ceiling: it may reduce below it and can never exceed it." },
      { path: "POST /api/dash/actions/regime.unmanage", body: { botId: "number" }, scope: "control", description: "Remove a bot from regime management and restore its baseline cap." },
      { path: "POST /api/dash/actions/regime.disarm", body: {}, scope: "control", description: "Disarm the governor and restore every managed bot to its baseline cap immediately." },
      { path: "POST /api/dash/actions/regime.sync", body: {}, scope: "control", description: "Reconcile caps against the latest convictions now, without waiting for the poll." },
      { path: "POST /api/dash/actions/regime.runNow", body: { symbols: "string[], optional" }, scope: "control", description: "Ask the research council to run now, out of schedule." },
      { path: "GET /api/dash/learning", params: { limit: "1-100", status: "proposed|applied|reverted|dismissed" }, description: "The learning journal: loss-streak post-mortems and their adjustment proposals." },
      { path: "POST /api/dash/actions/learning.evaluate", body: {}, scope: "control", description: "Run the loss-streak sweep now instead of waiting for the timer." },
      { path: "POST /api/dash/actions/learning.apply", body: { id: "number" }, scope: "control", description: "Apply a journal proposal to the bot's settings. Values are clamped into guardrails; the previous settings are snapshotted for revert." },
      { path: "POST /api/dash/actions/learning.revert", body: { id: "number" }, scope: "control", description: "Restore the bot's settings to the snapshot taken when a proposal was applied." },
      { path: "POST /api/dash/actions/learning.dismiss", body: { id: "number" }, scope: "control", description: "Dismiss a proposal without applying it." },
      { path: "GET /api/dash/ai-settings", params: {}, description: "The saved LLM configuration (key masked) for the AI council." },
      { path: "POST /api/dash/actions/ai-settings.save", body: { provider: "string", model: "string", apiKey: "string, optional", baseUrl: "string, optional" }, scope: "control", description: "Save and instantly apply the AI council's provider/model. provider 'none' disables it." },
      { path: "POST /api/dash/actions/ai-models", body: { provider: "string", apiKey: "string, optional", baseUrl: "string, optional" }, scope: "control", description: "Fetch the models a provider offers, for the settings picker. Each is { id, name, description, free, contextLength }; `free` is true when the model says so or prices at zero." },
      { path: "POST /api/dash/actions/ai-settings.test", body: { provider: "string", model: "string", apiKey: "string, optional", baseUrl: "string, optional" }, scope: "control", description: "Verify a provider configuration by asking the model to answer. Returns { ok, model, message } where message is the provider's own reason when it refused. Deliberately a completion and not a model listing: some gateways serve /models unauthenticated, so a listing proves nothing about the key, the credit or the model id." },
      { path: "POST /api/dash/actions/ai-chat", body: { messages: "[{ role: user|assistant, content: string }]" }, scope: "control", description: "Ask the configured model about the fleet. Returns { reply, proposals, model }. Executes nothing — a proposal is carried out by a separate call to ai-execute." },
      { path: "POST /api/dash/actions/ai-execute", body: { proposal: "{ action, params, why }", autonomous: "boolean, optional" }, scope: "control", description: `Carry out one proposal from ai-chat. Allowed actions: ${Object.keys(ALLOWED_ACTIONS).join(", ")}. Dispatched through the same guarded route an operator would call, so scope, freeze, rate limit and audit all apply. With autonomous:true it also spends from the unattended-action budget, which is enforced here and not in the browser.` },
      { path: "POST /api/dash/actions/ai.disable", body: { reason: "string, optional" }, scope: "control", description: "Stop the AI acting or answering. Unlike /actions/freeze this leaves your own control endpoints working, so you can clean up after it." },
      { path: "POST /api/dash/actions/ai.enable", body: {}, scope: "control", description: "Let the AI act again, and start its unattended-action allowance over." },
      { path: "POST /api/dash/actions/freeze", body: { frozen: "boolean" }, scope: "admin", description: "Disable or re-enable all agent control." },
    ],
  }));

  fastify.get("/snapshot", async (request) => {
    const query = request.query as Record<string, unknown>;

    return buildSnapshot(await derived(), {
      metric: str(query.metric) as LeaderboardMetric | undefined,
      recentTradeLimit: num(query.recentTradeLimit),
    });
  });

  fastify.get("/trades", async (request) => {
    const query = request.query as Record<string, unknown>;

    return buildTradesView(await derived(), {
      botId: num(query.botId),
      symbol: str(query.symbol),
      outcome: str(query.outcome) as "win" | "loss" | "breakeven" | undefined,
      from: num(query.from),
      to: num(query.to),
      sort: str(query.sort) as "exitAt" | "netPnl" | "pnlPercent" | "holdMs" | undefined,
      direction: str(query.direction) as "asc" | "desc" | undefined,
      limit: num(query.limit),
      offset: num(query.offset),
    });
  });

  fastify.get("/positions", async (request) => {
    const query = request.query as Record<string, unknown>;

    return buildPositionsView(await derived(), {
      botId: num(query.botId),
      state: str(query.state) as "live" | "abandoned" | "missing" | undefined,
      includePending: query.includePending === undefined ? undefined : query.includePending !== "false",
    });
  });

  fastify.get("/grid", async (request) => buildGridView(await derived(), num((request.query as Record<string, unknown>).botId)));

  fastify.get("/history", async (request) => {
    const query = request.query as Record<string, unknown>;

    return buildHistoryView(await derived(), {
      botId: num(query.botId),
      bucket: str(query.bucket) as BucketSize | undefined,
      from: num(query.from),
      to: num(query.to),
    });
  });

  fastify.get("/events", async (request) => {
    const query = request.query as Record<string, unknown>;
    const since = num(query.since) ?? 0;

    const [context, logs] = await Promise.all([
      derived(),
      dashboardService.recentBotLogs(OWNER_ID, 100, since > 0 ? since : undefined),
    ]);

    const view = buildEventsView(context, logs, since, num(query.limit) ?? 50);

    // Control actions belong in the same feed, so an operator sees the agent act.
    const actions: DashboardEvent[] = agentAccess.actions(since).map((entry: AgentActionRecord) => ({
      id: `agent-${entry.at}-${entry.action}`,
      type: "agentAction" as const,
      at: entry.at,
      botId: typeof entry.target.botId === "number" ? entry.target.botId : null,
      botName: null,
      symbol: null,
      title: `Agent ${entry.outcome}: ${entry.action}`,
      message: `${entry.actor} - ${entry.action}${entry.detail ? ` - ${entry.detail}` : ""}`,
      severity: entry.outcome === "allowed" ? ("info" as const) : ("warning" as const),
      pnl: null,
      pnlPercent: null,
      smartTradeId: null,
    }));

    return {
      events: [...view.events, ...actions].sort((a, b) => a.at - b.at),
      cursor: Math.max(view.cursor, ...actions.map((event) => event.at), since),
    };
  });

  fastify.get("/logs", async (request) => {
    const query = request.query as Record<string, unknown>;
    const botId = num(query.botId);
    const context = await dashboardService.getContext(OWNER_ID);
    const logs = await dashboardService.recentBotLogs(OWNER_ID, num(query.limit) ?? 50);

    return {
      logs: logs
        .filter((log: BotLogRow) => botId === undefined || log.botId === botId)
        .map((log: BotLogRow) => ({
          id: log.id,
          botId: log.botId,
          botName: context.botNames.get(log.botId) ?? `Bot ${log.botId}`,
          action: log.action,
          triggerEventType: log.triggerEventType,
          error: log.error && log.error !== "undefined" && log.error !== "null" ? log.error : null,
          createdAt: log.createdAt.getTime(),
        })),
    };
  });

  fastify.get("/health", async () => {
    const startedAt = Date.now();
    const [context, lastBotActivity] = await Promise.all([derived(), dashboardService.lastBotActivity(OWNER_ID)]);

    const report = buildHealthView({
      derived: context,
      database: dashboardService.getDatabaseStats(),
      databasePath: dashboardService.databaseFile(),
      process: dashboardService.processStats(),
      host: dashboardService.hostStats(),
      lastBotActivity,
      paperFillPatchApplied: dashboardService.hasPaperFillFix(),
      apiLatencyMs: Date.now() - startedAt,
    });

    /*
     * The AI checks are appended here rather than built into `buildHealthView`.
     *
     * That builder lives in `@opentrader/trpc`, which does not depend on
     * `@opentrader/ai-team` and should not start to — the guards and the
     * provider are visible from this package, and the health report is a list
     * of checks with a worst-wins rollup, so adding to it is additive.
     */
    const checks = [...report.checks, ...aiHealthChecks(), await phantomPositionCheck()];
    const counts: Record<HealthStatus, number> = { ok: 0, warn: 0, crit: 0, unknown: 0 };
    for (const check of checks) counts[check.status] += 1;

    return { ...report, checks, counts, status: rollUp(checks) };
  });

  /**
   * Everything recovery would act on, and what it would place. Read-only, so it
   * needs no control scope: seeing the damage should never require permission to
   * change anything.
   */
  fastify.get("/positions/stranded", async (request) => {
    const botId = num((request.query as Record<string, unknown>).botId);
    const positions = await findStrandedPositions(OWNER_ID, botId);
    const recoverable = positions.filter((p) => p.blockedReason === null);

    return {
      total: positions.length,
      recoverable: recoverable.length,
      blocked: positions.length - recoverable.length,
      expectedPnl: recoverable.reduce((sum, p) => sum + (p.expectedPnl ?? 0), 0),
      capital: positions.reduce((sum, p) => sum + p.entryPrice * p.quantity, 0),
      positions,
    };
  });

  /** A bot's current limits, for the settings dialog to populate itself. */
  /**
   * Positions marked filled that no exchange ever filled.
   *
   * Read-only, and the counterpart to the `positions.phantom` health check: the
   * check says how bad it is, this says exactly which trades and what clearing
   * them would cancel.
   */
  fastify.get("/positions/unbacked", async (request) => {
    const botId = num((request.query as Record<string, unknown>).botId);
    const positions = await findUnbackedPositions(OWNER_ID, botId);
    const clearable = positions.filter((position) => position.blockedReason === null);

    return {
      total: positions.length,
      clearable: clearable.length,
      blocked: positions.length - clearable.length,
      claimedCapital: positions.reduce((total, position) => total + position.claimedCost, 0),
      liveExitOrders: positions.reduce((total, position) => total + position.liveExitOrders, 0),
      positions,
    };
  });

  fastify.get("/bots/:botId/limits", async (request, reply) => {
    const botId = num((request.params as Record<string, unknown>).botId);
    if (botId === undefined) return reply.code(400).send({ error: "bad_request", message: "botId is required" });

    const bot = (await xprisma.bot.findFirst({
      where: { id: botId, ownerId: OWNER_ID },
      select: { id: true, name: true, symbol: true, enabled: true, maxCapital: true, minProfit: true },
    })) as { id: number; name: string; symbol: string; enabled: boolean; maxCapital: number | null; minProfit: number | null } | null;

    if (!bot) return reply.code(404).send({ error: "not_found", message: "Bot not found" });

    return bot;
  });

  /** What a purge would remove, and whether it is currently allowed. Read-only. */
  fastify.get("/bots/:botId/purge-preview", async (request, reply) => {
    const botId = num((request.params as Record<string, unknown>).botId);
    if (botId === undefined) return reply.code(400).send({ error: "bad_request", message: "botId is required" });

    return previewPurge(botId, OWNER_ID);
  });

  /**
   * Who is watching, and who was turned away.
   *
   * Both ride the one poll the dashboard already makes, so telling the owner
   * about a refused attempt costs no extra request.
   */
  fastify.get("/shares/watchers", async (request) => {
    const since = num((request.query as Record<string, unknown>).since) ?? Date.now();

    return { watchers: await currentWatchers(), blocked: blockedSince(since), now: Date.now() };
  });

  fastify.get("/shares", async (request) => ({
    shares: await listShares(publicBaseUrl(request.headers.host, request.protocol)),
    /** Reported so the owner can see whether mail is even being attempted. */
    emailEnabled: process.env.SHARE_EMAIL !== "off",
  }));

  fastify.post("/shares", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;
    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    const result = await createShare(
      (request.body ?? {}) as Record<string, unknown>,
      publicBaseUrl(request.headers.host, request.protocol),
    );

    if (!result.ok) return reply.code(400).send({ error: "bad_request", message: result.error });

    agentAccess.record({
      actor: actor.name,
      actorKind: actor.kind,
      action: "share.create",
      target: { email: result.share.email },
      outcome: "allowed",
      detail: result.share.emailError ? `link created, email failed: ${result.share.emailError}` : "link created and emailed",
    });

    return result.share;
  });

  /** Revoke, delete, or free the link from the device holding it. */
  for (const [path, action, run] of [
    ["/shares/:id/revoke", "share.revoke", revokeShare],
    ["/shares/:id/release", "share.release", releaseDevice],
  ] as const) {
    fastify.post(path, async (request: AuthedRequest, reply) => {
      const actor = request.actor!;
      const permission = agentAccess.canControl(actor);
      if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

      const id = num((request.params as Record<string, unknown>).id);
      if (id === undefined) return reply.code(400).send({ error: "bad_request", message: "id is required" });
      if (!(await run(id))) return reply.code(404).send({ error: "not_found", message: "Share link not found" });

      agentAccess.record({ actor: actor.name, actorKind: actor.kind, action, target: { id }, outcome: "allowed", detail: null });

      return { ok: true };
    });
  }

  fastify.delete("/shares/:id", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;
    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    const id = num((request.params as Record<string, unknown>).id);
    if (id === undefined) return reply.code(400).send({ error: "bad_request", message: "id is required" });
    if (!(await deleteShare(id))) return reply.code(404).send({ error: "not_found", message: "Share link not found" });

    agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "share.delete", target: { id }, outcome: "allowed", detail: null });

    return { ok: true };
  });

  fastify.get("/actions/log", async (request) => ({
    frozen: agentAccess.isFrozen(),
    tokens: agentAccess.describeTokens(),
    actions: agentAccess.actions(num((request.query as Record<string, unknown>).since) ?? 0),
  }));

  /**
   * What the AI has done, oldest first so a client can append.
   *
   * The cursor is the journal's sequence number, not a timestamp: a council tick
   * records its verdict and the order it placed within the same millisecond, and
   * a timestamp cursor would silently drop the second one.
   *
   * `session` identifies the buffer. Sequence numbers restart at zero when the
   * daemon restarts, so a client holding a cursor from the previous run would
   * otherwise sit silent forever waiting for a number that will never come
   * again. Sending back a session that is not the current one replays from the
   * top instead.
   */
  fastify.get("/ai/actions", async (request) => {
    const query = request.query as Record<string, unknown>;
    const session = str(query.session);
    const stale = session !== undefined && session !== aiActivity.session;
    const since = stale ? 0 : (num(query.since) ?? 0);
    const limit = Math.min(Math.max(num(query.limit) ?? 200, 1), 500);

    const actions = aiActivity.since(since, limit);

    // The strategy knows a bot by id — it never loaded a name. Filling them in
    // here means every consumer gets a line it can show as it stands.
    const missing = actions.some((action: AiActionRecord) => action.botId !== null && !action.botName);
    const names = missing ? (await dashboardService.getContext(OWNER_ID)).botNames : null;

    return {
      session: aiActivity.session,
      cursor: aiActivity.cursor(),
      restarted: stale,
      actions: actions.map((action: AiActionRecord) =>
        action.botId !== null && !action.botName
          ? { ...action, botName: names?.get(action.botId) ?? `Bot ${action.botId}` }
          : action,
      ),
    };
  });

  // --- Control -------------------------------------------------------------

  /** Shared guard: scope, freeze switch, rate limit and audit for one action. */
  async function control(
    request: AuthedRequest,
    reply: FastifyReply,
    action: string,
    run: (botId: number) => Promise<void>,
  ) {
    const actor = request.actor!;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const botId = num(body.botId);

    const deny = (code: number, error: string, detail: string) => {
      agentAccess.record({ actor: actor.name, actorKind: actor.kind, action, target: { botId: botId ?? null }, outcome: "denied", detail });

      // A refusal is worth seeing on the board too. An agent quietly failing to
      // act looks identical to an agent choosing not to, and they are very
      // different problems.
      recordAiAction({
        chip: "denied",
        title: `${CONTROL_PHRASE[action] ?? action} refused`,
        detail: `${actor.name} was refused: ${detail}`,
        botId: botId ?? null,
      });

      return reply.code(code).send({ error, message: detail });
    };

    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) return deny(403, "forbidden", permission.reason!);
    if (botId === undefined) return deny(400, "bad_request", "botId is required");

    const limit = agentAccess.controlLimiter.check(actor.name);
    if (!limit.allowed) return deny(429, "rate_limited", `Control rate limit reached, retry in ${Math.ceil(limit.retryAfterMs / 1000)}s`);

    try {
      await run(botId);
      // The cached context predates this change, so the next read must re-query.
      dashboardService.invalidate();
      agentAccess.record({ actor: actor.name, actorKind: actor.kind, action, target: { botId }, outcome: "allowed", detail: null });
      logger.info(`[Dashboard] ${actor.kind} "${actor.name}" performed ${action} on bot ${botId}`);

      recordAiAction({
        chip: "adjust",
        severity: action === "bot.purgeTrades" ? "danger" : action === "bot.stop" ? "warning" : "info",
        title: CONTROL_PHRASE[action] ?? action,
        detail: `${CONTROL_CONSEQUENCE[action] ?? "Done"} — by ${actor.name}.`,
        botId,
        // Only the execute route can set this, and only once per nonce it
        // minted moments earlier. A caller cannot label their own action as the
        // AI's, or the AI's as their own, by setting a header.
        autonomous: aiGuards.nonces.consume(request.headers["x-ai-nonce"] as string | undefined),
      });

      return { ok: true, action, botId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      agentAccess.record({ actor: actor.name, actorKind: actor.kind, action, target: { botId }, outcome: "failed", detail: message });

      recordAiAction({
        chip: "denied",
        title: `${CONTROL_PHRASE[action] ?? action} failed`,
        detail: message,
        botId,
      });

      return reply.code(409).send({ error: "action_failed", message });
    }
  }

  fastify.post("/actions/bot.start", async (request: AuthedRequest, reply) =>
    control(request, reply, "bot.start", async (botId) => {
      const botService = await BotService.fromId(botId);
      botService.assertIsNotAlreadyRunning();
      botService.assertIsNotProcessing();
      await eventBus.emit("startBot", botService.bot);
    }),
  );

  fastify.post("/actions/bot.stop", async (request: AuthedRequest, reply) =>
    control(request, reply, "bot.stop", async (botId) => {
      const botService = await BotService.fromId(botId);
      botService.assertIsNotAlreadyStopped();
      await eventBus.emit("stopBot", botService.bot);
    }),
  );

  fastify.post("/actions/bot.restart", async (request: AuthedRequest, reply) =>
    control(request, reply, "bot.restart", async (botId) => {
      const botService = await BotService.fromId(botId);

      if (botService.bot.enabled) {
        await eventBus.emit("stopBot", botService.bot);
        // Re-read, so the start sees the state the stop just wrote.
        const stopped = await BotService.fromId(botId);
        await eventBus.emit("startBot", stopped.bot);
      } else {
        await eventBus.emit("startBot", botService.bot);
      }
    }),
  );

  /**
   * Place replacement exits for stranded positions.
   *
   * `limit` bounds one invocation so this can be done in reviewable batches
   * rather than as one irreversible sweep.
   */
  fastify.post("/actions/position.recoverStranded", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const limit = Math.min(num(body.limit) ?? 25, 200);
    const botId = num(body.botId);

    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) {
      agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "position.recoverStranded", target: { botId: botId ?? null }, outcome: "denied", detail: permission.reason });

      return reply.code(403).send({ error: "forbidden", message: permission.reason });
    }

    const rate = agentAccess.controlLimiter.check(actor.name);
    if (!rate.allowed) {
      return reply.code(429).send({ error: "rate_limited", retryAfterMs: rate.retryAfterMs });
    }

    const result = await recoverPositions(OWNER_ID, { botId, limit });
    dashboardService.invalidate();

    agentAccess.record({
      actor: actor.name,
      actorKind: actor.kind,
      action: "position.recoverStranded",
      target: { botId: botId ?? null, limit },
      outcome: result.failed > 0 && result.placed === 0 ? "failed" : "allowed",
      detail: `placed ${result.placed}, failed ${result.failed}`,
    });

    return result;
  });

  /**
   * Write off positions the exchange never filled.
   *
   * Cancels the real exits resting against them first, then corrects the
   * fabricated entry rows. It refuses any bot that is still running, so the
   * normal sequence is stop the bot, clear, then start it again.
   */
  fastify.post("/actions/position.clearUnbacked", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const botId = num(body.botId);

    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) {
      agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "position.clearUnbacked", target: { botId: botId ?? null }, outcome: "denied", detail: permission.reason });

      return reply.code(403).send({ error: "forbidden", message: permission.reason });
    }

    const rate = agentAccess.controlLimiter.check(actor.name);
    if (!rate.allowed) {
      return reply.code(429).send({ error: "rate_limited", retryAfterMs: rate.retryAfterMs });
    }

    const results = await clearUnbackedPositions(OWNER_ID, botId);
    dashboardService.invalidate();

    const cleared = results.filter((result) => result.error === null);
    const failed = results.filter((result) => result.error !== null);
    const writtenOff = cleared.reduce((total, result) => total + result.claimedCost, 0);
    const exitsCancelled = cleared.reduce((total, result) => total + result.exitsCancelled, 0);

    agentAccess.record({
      actor: actor.name,
      actorKind: actor.kind,
      action: "position.clearUnbacked",
      target: { botId: botId ?? null },
      outcome: failed.length > 0 && cleared.length === 0 ? "failed" : "allowed",
      detail: `cleared ${cleared.length}, failed ${failed.length}, wrote off ${writtenOff.toFixed(2)}`,
    });

    return {
      ok: failed.length === 0,
      total: results.length,
      cleared: cleared.length,
      failed: failed.length,
      writtenOffCapital: writtenOff,
      exitsCancelled,
      results,
    };
  });

  /**
   * Delete every trade of a bot. Destructive and irreversible.
   *
   * Live orders are cancelled on the exchange first, and a running bot is
   * refused - see ../processing/executors/purge-bot.ts.
   */
  fastify.post("/actions/bot.purgeTrades", async (request: AuthedRequest, reply) =>
    control(request, reply, "bot.purgeTrades", async (botId) => {
      const result = await purgeBotTrades(botId, OWNER_ID);
      if (result.error) throw new Error(result.error);
    }),
  );

  /** Set the capital cap and minimum profit. Zero clears a limit. */
  fastify.post("/actions/bot.setLimits", async (request: AuthedRequest, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    return control(request, reply, "bot.setLimits", async (botId) => {
      await setBotLimits(botId, OWNER_ID, {
        maxCapital: body.maxCapital === undefined ? undefined : num(body.maxCapital) ?? 0,
        minProfit: body.minProfit === undefined ? undefined : num(body.minProfit) ?? 0,
      });
    });
  });

  /** The emergency switch. Admin only - an agent cannot unfreeze itself. */
  fastify.post("/actions/freeze", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;

    if (actor.kind !== "admin") {
      agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "freeze", target: {}, outcome: "denied", detail: "Admin only" });

      return reply.code(403).send({ error: "forbidden", message: "Only the admin password may change the freeze switch." });
    }

    const frozen = (request.body as { frozen?: unknown } | undefined)?.frozen !== false;
    agentAccess.setFrozen(frozen);
    agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "freeze", target: { frozen }, outcome: "allowed", detail: null });

    return { ok: true, frozen };
  });

  // --- Regime governor -----------------------------------------------------

  /**
   * What the council currently thinks, and what it is doing to each bot.
   *
   * Reads the local mirror rather than the research service, so this answers
   * even while the council is down — with `ageMs` making the staleness visible
   * instead of silently serving an old view as current.
   */
  fastify.get("/regime", async () => {
    const policies = (await xprisma.regimePolicy.findMany()) as RegimePolicyRow[];
    const bots = (await xprisma.bot.findMany({
      select: { id: true, name: true, symbol: true, enabled: true, maxCapital: true, minProfit: true },
    })) as { id: number; name: string; symbol: string; enabled: boolean; maxCapital: number | null; minProfit: number | null }[];

    const symbols = [...new Set(bots.map((b) => b.symbol))];
    const convictions: Record<string, unknown> = {};
    const now = Date.now();

    for (const symbol of symbols) {
      const row = (await xprisma.regimeConviction.findFirst({
        where: { symbol },
        orderBy: { asOf: "desc" },
      })) as RegimeConvictionRow | null;

      if (!row) continue;

      const asOf = Number(row.asOf);
      convictions[symbol] = {
        symbol,
        stance: row.stance,
        confidence: row.confidence,
        asOf,
        ageMs: now - asOf,
        summary: row.summary,
        model: row.model,
        costUsd: row.costUsd,
      };
    }

    const managed = bots.map((bot) => {
      const policy = policies.find((p) => p.botId === bot.id) ?? null;
      const conviction = convictions[bot.symbol] as { stance?: string; confidence?: number; asOf?: number } | undefined;

      const decision = policy
        ? applyRegimeGovernor(
            {
              botId: policy.botId,
              baselineMaxCapital: policy.baselineMaxCapital,
              baselineMinProfit: policy.baselineMinProfit,
              armed: policy.armed,
              floorFactor: policy.floorFactor,
              maxAgeMs: policy.maxAgeMs,
            },
            conviction
              ? {
                  symbol: bot.symbol,
                  stance: conviction.stance as never,
                  confidence: conviction.confidence ?? 0,
                  asOf: conviction.asOf ?? 0,
                  summary: "",
                }
              : null,
            now,
          )
        : null;

      return {
        botId: bot.id,
        name: bot.name,
        symbol: bot.symbol,
        enabled: bot.enabled,
        managed: policy !== null,
        armed: policy?.armed ?? false,
        baselineMaxCapital: policy?.baselineMaxCapital ?? null,
        currentMaxCapital: bot.maxCapital,
        minProfit: bot.minProfit,
        // What the governor would decide right now, so the panel shows intent
        // even between polls.
        wouldCap: decision?.maxCapital ?? null,
        factor: decision?.factor ?? 1,
        reduced: decision?.reduced ?? false,
        notes: decision?.notes ?? [],
      };
    });

    return { convictions: Object.values(convictions), bots: managed };
  });

  /** The learning journal, newest first, optionally filtered by status. */
  fastify.get("/learning", async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = Math.min(Math.max(num(query.limit) ?? 30, 1), 100);
    const status = str(query.status);

    const entries = (await xprisma.learningJournal.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    })) as LearningRow[];

    return {
      entries: entries.map((entry) => ({
        ...entry,
        stats: safeParse(entry.stats),
        proposal: safeParse(entry.proposal),
      })),
    };
  });

  // ---------- AI settings ----------
  //
  // The operator's LLM choice, set from the dashboard and persisted so it
  // survives restarts. Saving applies live via the runtime override — no
  // restart. The key is never echoed back, only a mask.

  // `opencode-go` is deliberately absent: Zen and Go are one account and one
  // key, and offering both invited a key being pointed at a tier it had no
  // entitlement to. A saved row still naming it is migrated on read.
  const AI_PROVIDER_IDS = ["anthropic", "openai", "openrouter", "gemini", "ollama", "opencode-zen", "custom"];

  type AiSettingsRow = { provider: string; model: string; apiKey: string | null; baseUrl: string | null };

  /**
   * The saved row, with any base URL we have since discovered to be dead
   * rewritten to the working one. The repair is applied on read rather than by
   * a migration so that a configuration saved against the old default starts
   * working on this deploy, without the operator having to notice, and the
   * corrected value is what the panel shows and the next save persists.
   */
  const loadAiSettings = async (): Promise<AiSettingsRow | null> => {
    const row = (await xprisma.aiSettings.findUnique({ where: { id: 1 } })) as AiSettingsRow | null;
    if (!row || row.provider === "none") return row;

    const migrated = migrateProviderChoice(row.provider, row.baseUrl);
    if (!migrated.changed) return row;

    // Said out loud, because moving somebody between billing tiers is not the
    // kind of thing that should happen quietly.
    logger.info(`[AI] Saved settings migrated: ${row.provider} ${row.baseUrl ?? "(no URL)"} -> ${migrated.id} ${migrated.baseUrl}`);

    return { ...row, provider: migrated.id, baseUrl: migrated.baseUrl };
  };

  /** Push a saved row into the council immediately. */
  function applyAiSettings(row: AiSettingsRow | null) {
    if (!row || row.provider === "none") {
      setRuntimeProvider(null);
      return;
    }

    setRuntimeProvider({
      id: row.provider as ProviderId,
      baseUrl: row.baseUrl ?? "",
      model: row.model,
      ...(row.apiKey ? { apiKey: row.apiKey } : {}),
    });
  }

  const maskKey = (key: string | null | undefined) =>
    key ? `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)` : null;

  fastify.get("/ai-settings", async () => {
    const row = await loadAiSettings();

    return {
      saved: row
        ? {
            provider: row.provider,
            model: row.model,
            baseUrl: row.baseUrl ?? null,
            hasKey: Boolean(row.apiKey),
            keyMasked: maskKey(row.apiKey),
          }
        : null,
    };
  });

  function defaultBaseUrlFor(providerId: string): string {
    const defaults: Record<string, string> = {
      anthropic: "https://api.anthropic.com",
      openai: "https://api.openai.com/v1",
      openrouter: "https://openrouter.ai/api/v1",
      gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
      ollama: "http://127.0.0.1:11434/v1",
      "opencode-zen": "https://opencode.ai/zen/v1",
    };
    return defaults[providerId] ?? "";
  }

  /**
   * List models for a provider. The key may arrive blank when the operator
   * already has a stored one and did not retype it; fall back to storage.
   */
  fastify.post("/actions/ai-models", async (request: AuthedRequest, reply) => {
    const permission = agentAccess.canControl(request.actor!);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    const body = ((request.body ?? {}) as Record<string, unknown>) || {};
    const providerId = str(body.provider);
    if (!providerId || !AI_PROVIDER_IDS.includes(providerId)) {
      return reply.code(400).send({ error: "bad_request", message: "unknown provider" });
    }

    const row = await loadAiSettings();
    const apiKey = (str(body.apiKey) || (row && row.provider === providerId ? row.apiKey : "")) ?? "";
    const baseUrl =
      str(body.baseUrl) || (row && row.provider === providerId ? row.baseUrl : "") || defaultBaseUrlFor(providerId);

    if (providerId !== "ollama" && !apiKey) {
      return reply.code(400).send({ error: "bad_request", message: `an API key for ${providerId} is required` });
    }

    const models = await listModelCatalog({
      id: providerId as ProviderId,
      model: "",
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
    });

    if (models.length === 0) {
      return reply.code(502).send({
        error: "unavailable",
        message: `The ${providerId} endpoint returned no models. Check the API key and base URL.`,
      });
    }

    // `free` is counted here rather than in the browser so an external agent
    // reading this endpoint gets the same answer the picker shows.
    return { ok: true, models, freeCount: models.filter((model: ModelInfo) => model.free).length };
  });


  // --- Chat ----------------------------------------------------------------

  /**
   * Assemble what the assistant is allowed to see.
   *
   * The fleet as the dashboard shows it, plus the three things an operator most
   * often asks about that are not in the snapshot: stranded positions, the
   * council's standing convictions, and learning proposals waiting on a
   * decision. No credentials, no share links, no host details.
   */
  async function buildChatContext(): Promise<ChatContext> {
    /*
     * Everything here comes from the snapshot the dashboard already builds.
     *
     * This used to call `findStrandedPositions`, which loads every smart trade
     * this owner has ever had with all of its orders attached — on every single
     * chat message. `positions.abandoned` is the same number: `summarizePositions`
     * counts every position whose exit state is not "live", which is precisely a
     * position holding stock with nothing working to sell it.
     */
    const snapshot = buildSnapshot(await derived(), {});

    const convictionRows = (await xprisma.regimeConviction.findMany({
      orderBy: { asOf: "desc" },
      take: 60,
    })) as RegimeConvictionRow[];

    const latestPerSymbol = new Map<string, RegimeConvictionRow>();
    for (const row of convictionRows) if (!latestPerSymbol.has(row.symbol)) latestPerSymbol.set(row.symbol, row);

    const proposals = (await xprisma.learningJournal.findMany({
      where: { status: "proposed" },
      orderBy: { createdAt: "desc" },
      take: 10,
    })) as LearningRow[];

    const now = Date.now();

    return {
      fleet: {
        realisedPnl: snapshot.fleet.realized.netPnl,
        floatingPnl: snapshot.fleet.positions.floatingPnl,
        openPositions: snapshot.fleet.positions.open,
      },
      health: null,
      bots: snapshot.bots.map((bot) => ({
        botId: bot.botId,
        name: bot.name,
        symbol: bot.symbol,
        enabled: bot.enabled,
        netPnl: bot.realized.netPnl,
        floatingPnl: bot.positions.floatingPnl,
        trades: bot.realized.trades,
        openPositions: bot.positions.open,
        strandedPositions: bot.positions.abandoned,
      })),
      convictions: [...latestPerSymbol.values()].map((row) => ({
        symbol: row.symbol,
        stance: row.stance,
        confidence: row.confidence,
        ageHours: (now - Number(row.asOf)) / 3_600_000,
      })),
      openProposals: proposals.map((row) => ({ id: row.id, botName: row.botName, lossStreak: row.lossStreak })),
    };
  }

  /** Chat is cheap per call but bills per token; this keeps a stuck loop bounded. */
  const chatLimiter = new RateLimiter(20, 60_000);

  /**
   * Ask the configured model about the fleet.
   *
   * Returns prose plus any proposals it made, already validated against the
   * allowlist. **Nothing is executed here** — carrying a proposal out is a
   * separate call to /actions/ai-execute, which is what lets the same code path
   * serve both a confirmation click and the autopilot switch.
   */
  fastify.post("/actions/ai-chat", async (request: AuthedRequest, reply) => {
    const permission = agentAccess.canControl(request.actor!);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    const running = aiGuards.killSwitch.check();
    if (!running.allowed) return reply.code(503).send({ error: "ai_disabled", message: running.reason });

    // Checked before the call, recorded after it: a request that is refused
    // costs nothing and should not be billed against the day.
    const affordable = aiGuards.budget.check();
    if (!affordable.allowed) return reply.code(429).send({ error: "budget_exhausted", message: affordable.reason });

    const limit = chatLimiter.check(request.actor!.name);
    if (!limit.allowed) {
      return reply
        .code(429)
        .send({ error: "rate_limited", message: `Too many questions at once, retry in ${Math.ceil(limit.retryAfterMs / 1000)}s` });
    }

    const provider = resolveProvider();
    if (!provider || !provider.model) {
      return reply.code(503).send({
        error: "unavailable",
        message: "No AI provider is configured. Set one in AI settings first.",
      });
    }

    const body = (request.body ?? {}) as { messages?: unknown };
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((entry): entry is ChatMessage => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({
        role: entry.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: String(entry.content ?? ""),
      }))
      .filter((entry) => entry.content);

    if (messages.length === 0) return reply.code(400).send({ error: "bad_request", message: "Nothing to answer" });

    const answer = await chatCompletionDetailed(provider, {
      system: SYSTEM_PROMPT,
      user: buildUserTurn(await buildChatContext(), messages),
      maxTokens: 1200,
      timeoutMs: 45_000,
    });

    if (!answer.ok) {
      // Logged as well as returned. The browser shows one operator this once;
      // the log is what tells the next person why the AI was quiet all morning.
      recordProviderOutcome(answer);
      logger.warn(`[AI] chat via ${provider.id}/${provider.model} failed: ${answer.reason}`);

      return reply.code(502).send({
        error: "unavailable",
        message: `${provider.id} could not answer: ${answer.reason}`,
      });
    }

    recordProviderOutcome(answer);
    aiGuards.budget.record(answer.tokens);
    logger.info(
      `[AI] chat via ${provider.id}/${provider.model}: ${answer.tokens} tokens, ${aiGuards.budget.spent().used} used today`,
    );

    const { prose, proposals } = extractProposals(answer.text);

    // A proposal the model is not allowed to make is dropped and reported, not
    // silently swallowed: the operator should know it tried.
    const checked = proposals.map((proposal: Proposal) => validateProposal(proposal));
    const allowed = checked.filter((result) => result.ok).map((result) => (result as { proposal: Proposal }).proposal);
    const refused = checked.filter((result) => !result.ok).map((result) => (result as { reason: string }).reason);

    return {
      reply: refused.length > 0 ? `${prose}\n\n(Ignored: ${refused.join("; ")}.)` : prose,
      proposals: allowed,
      model: `${provider.id} · ${provider.model}`,
    };
  });

  /**
   * Carry out exactly one validated proposal.
   *
   * Dispatched back through this plugin's own routes rather than calling the
   * executors directly, so a proposal goes through the identical path an
   * operator's click takes: scope check, freeze switch, rate limit, audit
   * record, and an entry in the AI action feed. There is no second, softer way
   * in — which is the property that makes arming autopilot a reviewable
   * decision rather than an open door.
   */
  fastify.post("/actions/ai-execute", async (request: AuthedRequest, reply) => {
    const permission = agentAccess.canControl(request.actor!);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    const running = aiGuards.killSwitch.check();
    if (!running.allowed) return reply.code(503).send({ error: "ai_disabled", message: running.reason });

    const body = (request.body ?? {}) as { proposal?: Proposal; autonomous?: unknown };
    const proposal = body.proposal;
    if (!proposal || typeof proposal !== "object") {
      return reply.code(400).send({ error: "bad_request", message: "No proposal given" });
    }

    const validation = validateProposal(proposal);
    if (!validation.ok) return reply.code(400).send({ error: "bad_request", message: validation.reason });

    const unattended = body.autonomous === true;

    /*
     * The autopilot budget, enforced where it cannot be edited.
     *
     * The dashboard counts down from twenty and disarms itself, but that
     * counter lives in a browser tab: a reload re-arms it, a bug can ignore it,
     * and a direct caller never had it. This is the copy that decides.
     */
    if (unattended) {
      const budget = aiGuards.autonomy.check();
      if (!budget.allowed) {
        recordAiAction({
          chip: "denied",
          title: "Autopilot limit reached",
          detail: budget.reason,
          botId: typeof validation.proposal.params.botId === "number" ? validation.proposal.params.botId : null,
        });

        return reply.code(429).send({ error: "autonomy_exhausted", message: budget.reason });
      }
    }

    const target = ALLOWED_ACTIONS[validation.proposal.action];

    /*
     * A single-use nonce, not a header the caller controls.
     *
     * The inner route reads it to decide whether the journal entry is marked
     * unattended. As a plain `x-ai-autonomous: 1` header, anyone could set it on
     * a direct request and forge the audit trail in either direction.
     */
    const nonce = unattended ? aiGuards.nonces.issue(randomUUID()) : "";

    const result = await fastify.inject({
      method: "POST",
      url: `/api/dash/actions/${target.path}`,
      headers: {
        "content-type": "application/json",
        authorization: request.headers.authorization ?? "",
        "x-agent-token": (request.headers["x-agent-token"] as string) ?? "",
        "x-ai-nonce": nonce,
      },
      payload: validation.proposal.params,
    });

    const payload = result.json<Record<string, unknown>>();

    if (result.statusCode >= 400) {
      return reply.code(result.statusCode).send(payload);
    }

    // Counted only on success. A refused action cost nothing and spending the
    // budget on it would let a run of failures lock out the working ones.
    if (unattended) aiGuards.autonomy.record();

    return {
      ok: true,
      action: validation.proposal.action,
      result: payload,
      autonomyRemaining: aiGuards.autonomy.remaining(),
    };
  });

  /**
   * Stop the AI, or start it again.
   *
   * Deliberately separate from `/actions/freeze`. Freezing disables every agent
   * control path, including the buttons an operator would use to undo whatever
   * the AI just did — so the moment you most want to stop it is the moment
   * freezing takes your own tools away too. This stops the AI and leaves you
   * yours.
   */
  fastify.post("/actions/ai.disable", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;
    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    const reason = str((request.body as Record<string, unknown> | undefined)?.reason) ?? `stopped by ${actor.name}`;

    aiGuards.killSwitch.stop(reason);
    agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "ai.disable", target: {}, outcome: "allowed", detail: reason });
    logger.warn(`[AI] disabled: ${reason}`);

    recordAiAction({ chip: "settings", severity: "warning", title: "AI switched off", detail: reason });

    return { ok: true, stopped: true };
  });

  fastify.post("/actions/ai.enable", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;
    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    aiGuards.killSwitch.start();
    // A deliberate re-enable starts the unattended allowance over: the operator
    // has looked at what happened and decided it may carry on.
    aiGuards.autonomy.reset();
    agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "ai.enable", target: {}, outcome: "allowed", detail: null });
    logger.info(`[AI] re-enabled by ${actor.name}`);

    recordAiAction({ chip: "settings", title: "AI switched back on", detail: `Re-enabled by ${actor.name}.` });

    return { ok: true, stopped: false };
  });

  /** What the guards currently allow, for the dashboard and for health checks. */
  fastify.get("/ai/status", async () => {
    const provider = resolveProvider();

    return {
      configured: Boolean(provider && provider.model),
      provider: provider ? { id: provider.id, model: provider.model } : null,
      stopped: aiGuards.killSwitch.isStopped(),
      autonomyRemaining: aiGuards.autonomy.remaining(),
      budget: aiGuards.budget.spent(),
    };
  });

  /**
   * Conviction history, oldest first, so the dashboard can draw the council
   * changing its mind rather than only repeating its latest word.
   *
   * One call returns every symbol's timeline; the card grid fetches it once
   * instead of once per symbol. Rows beyond `limit` per symbol are dropped —
   * the runs are twice daily, so 30 covers a month, which is longer than any
   * regime worth watching has ever lasted.
   */
  fastify.get("/regime/history", async (request) => {
    const limit = Math.min(Math.max(num((request.query as Record<string, unknown>).limit) ?? 30, 1), 200);
    const rows = (await xprisma.regimeConviction.findMany({
      orderBy: { asOf: "desc" },
      take: limit * 10,
    })) as RegimeConvictionRow[];

    const bySymbol = new Map<string, { stance: string; confidence: number; asOf: number }[]>();
    for (const row of rows) {
      const list = bySymbol.get(row.symbol) ?? [];
      if (list.length >= limit) continue;
      list.push({ stance: row.stance, confidence: row.confidence, asOf: Number(row.asOf) });
      bySymbol.set(row.symbol, list);
    }

    const history: Record<string, unknown[]> = {};
    for (const [symbol, list] of bySymbol) history[symbol] = list.reverse();

    return { history };
  });


  /** The full debate behind one symbol's conviction, proxied from the council. */
  fastify.get("/regime/transcript", async (request, reply) => {
    const symbol = str((request.query as Record<string, unknown>).symbol);
    if (!symbol) return reply.code(400).send({ error: "bad_request", message: "symbol is required" });

    const base = process.env.RESEARCH_URL || "http://127.0.0.1:8801";
    try {
      const res = await fetch(`${base}/convictions/latest/${encodeURIComponent(symbol)}/full`);
      if (!res.ok) return reply.code(res.status).send({ error: "unavailable", message: `research service returned ${res.status}` });

      return await res.json();
    } catch (error) {
      return reply.code(503).send({ error: "unavailable", message: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Recent research runs, their cost and their duration. */
  fastify.get("/regime/runs", async (request, reply) => {
    const base = process.env.RESEARCH_URL || "http://127.0.0.1:8801";
    try {
      const res = await fetch(`${base}/runs?limit=${num((request.query as Record<string, unknown>).limit) ?? 50}`);
      if (!res.ok) return reply.code(res.status).send({ error: "unavailable", message: `research service returned ${res.status}` });

      return await res.json();
    } catch (error) {
      return reply.code(503).send({ error: "unavailable", message: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * Put a bot under regime management, or change how it is managed.
   *
   * `baselineMaxCapital` defaults to the bot's current cap, so bringing a bot
   * under management is by default a no-op: the governor starts from exactly
   * where the operator left it and can only go down from there.
   */
  fastify.post("/actions/regime.setPolicy", async (request: AuthedRequest, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    return control(request, reply, "regime.setPolicy", async (botId) => {
      const bot = (await xprisma.bot.findUnique({ where: { id: botId }, select: { maxCapital: true, minProfit: true } })) as
        | { maxCapital: number | null; minProfit: number | null }
        | null;

      if (!bot) throw new Error(`No bot ${botId}`);

      const existing = (await xprisma.regimePolicy.findUnique({ where: { botId } })) as RegimePolicyRow | null;

      // Seeding order matters. An explicit value always wins. Otherwise a bot
      // that is already managed keeps its stored baseline, and only a brand new
      // policy is seeded from the bot's current cap.
      //
      // Re-deriving the baseline from the current cap on every call looks
      // harmless and is not: the governor *writes* that column, so re-arming a
      // bot while it is throttled would adopt the throttled figure as the new
      // ceiling and the reduction would never be given back.
      const baseline = num(body.baselineMaxCapital) ?? existing?.baselineMaxCapital ?? bot.maxCapital;
      const armed = body.armed === undefined ? true : body.armed !== false;
      const floorFactor = Math.min(1, Math.max(0, num(body.floorFactor) ?? 0.1));
      const maxAgeMs = num(body.maxAgeMs) ?? 93_600_000;

      await xprisma.regimePolicy.upsert({
        where: { botId },
        create: {
          botId,
          baselineMaxCapital: baseline,
          baselineMinProfit: bot.minProfit,
          armed,
          floorFactor,
          maxAgeMs,
        },
        update: { baselineMaxCapital: baseline, armed, floorFactor, maxAgeMs },
      });
    });
  });

  /** Take a bot out of regime management entirely, restoring its baseline cap. */
  fastify.post("/actions/regime.unmanage", async (request: AuthedRequest, reply) =>
    control(request, reply, "regime.unmanage", async (botId) => {
      const policy = (await xprisma.regimePolicy.findUnique({ where: { botId } })) as RegimePolicyRow | null;
      if (!policy) throw new Error(`Bot ${botId} is not under regime management`);

      if (policy.baselineMaxCapital !== null) {
        await setBotLimits(botId, OWNER_ID, { maxCapital: policy.baselineMaxCapital });
      }
      await xprisma.regimePolicy.delete({ where: { botId } });
    }),
  );

  /**
   * The disarm switch: every managed bot back to its baseline, now.
   *
   * Deliberately does not take a botId — when an operator reaches for this,
   * they want the whole fleet released, not one bot at a time.
   */
  fastify.post("/actions/regime.disarm", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;

    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) {
      agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "regime.disarm", target: {}, outcome: "denied", detail: permission.reason! });

      return reply.code(403).send({ error: "forbidden", message: permission.reason });
    }

    const result = await disarmRegime();
    dashboardService.invalidate();
    agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "regime.disarm", target: result, outcome: "allowed", detail: null });
    logger.warn(`[Dashboard] ${actor.kind} "${actor.name}" disarmed the regime governor`);

    return { ok: true, ...result };
  });

  /** Force a reconcile without waiting out the poll interval. */
  fastify.post("/actions/regime.sync", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;

    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    const result = await syncRegime();
    dashboardService.invalidate();
    agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "regime.sync", target: result, outcome: "allowed", detail: null });

    return { ok: true, ...result };
  });

  /** Ask the council to run now, out of schedule. */
  fastify.post("/actions/regime.runNow", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;

    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    const symbols = ((request.body ?? {}) as { symbols?: unknown }).symbols;
    const ok = await requestResearchRun(Array.isArray(symbols) ? symbols.filter((s): s is string => typeof s === "string") : []);

    agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "regime.runNow", target: { symbols }, outcome: ok ? "allowed" : "failed", detail: ok ? null : "research service unreachable" });

    if (!ok) return reply.code(503).send({ error: "unavailable", message: "The research service did not accept the run." });

    return { ok: true, queued: true };
  });

  /** Run the loss-streak sweep now instead of waiting for the timer. */
  fastify.post("/actions/learning.evaluate", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;

    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    const result = await evaluateLearning(OWNER_ID);
    agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "learning.evaluate", target: {}, outcome: "allowed", detail: null });

    return { ok: true, ...result };
  });

  /** Apply a proposal: clamp into guardrails, snapshot previous settings first. */
  fastify.post("/actions/learning.apply", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;

    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    const id = num(((request.body ?? {}) as Record<string, unknown>).id);
    if (id === undefined) return reply.code(400).send({ error: "bad_request", message: "id is required" });

    try {
      const result = await applyLearning(id, OWNER_ID);
      dashboardService.invalidate();
      agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "learning.apply", target: { id }, outcome: "allowed", detail: null });
      logger.info(`[Dashboard] ${actor.kind} "${actor.name}" applied learning entry ${id}`);

      return { ok: true, ...result };
    } catch (error) {
      return reply.code(409).send({ error: "conflict", message: error instanceof Error ? error.message : String(error) });
    }
  });

  fastify.post("/actions/learning.revert", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;

    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    const id = num(((request.body ?? {}) as Record<string, unknown>).id);
    if (id === undefined) return reply.code(400).send({ error: "bad_request", message: "id is required" });

    try {
      await revertLearning(id, OWNER_ID);
      dashboardService.invalidate();
      agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "learning.revert", target: { id }, outcome: "allowed", detail: null });

      return { ok: true, id };
    } catch (error) {
      return reply.code(409).send({ error: "conflict", message: error instanceof Error ? error.message : String(error) });
    }
  });

  fastify.post("/actions/learning.dismiss", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;

    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    const id = num(((request.body ?? {}) as Record<string, unknown>).id);
    if (id === undefined) return reply.code(400).send({ error: "bad_request", message: "id is required" });

    try {
      await dismissLearning(id);
      agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "learning.dismiss", target: { id }, outcome: "allowed", detail: null });

      return { ok: true, id };
    } catch (error) {
      return reply.code(409).send({ error: "conflict", message: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Verify a configuration end-to-end by listing its models. */
  fastify.post("/actions/ai-settings.test", async (request: AuthedRequest, reply) => {
    const permission = agentAccess.canControl(request.actor!);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    const body = ((request.body ?? {}) as Record<string, unknown>) || {};
    const providerId = str(body.provider);
    if (!providerId || !AI_PROVIDER_IDS.includes(providerId)) {
      return reply.code(400).send({ error: "bad_request", message: "unknown provider" });
    }

    const row = await loadAiSettings();
    const apiKey = (str(body.apiKey) || (row && row.provider === providerId ? row.apiKey : "")) ?? "";
    const baseUrl =
      str(body.baseUrl) || (row && row.provider === providerId ? row.baseUrl : "") || defaultBaseUrlFor(providerId);

    if (providerId !== "ollama" && !apiKey) {
      return reply.code(400).send({ error: "bad_request", message: `an API key for ${providerId} is required` });
    }

    // A model id is needed because the test is a real completion, and the point
    // is to prove *this* model answers. Fall back to whatever is saved.
    const model = str(body.model) || (row && row.provider === providerId ? row.model : "") || "";
    if (!model) {
      return reply.code(400).send({ error: "bad_request", message: "choose a model before testing" });
    }

    // Deliberately a completion, not a model listing. Listing `/models` on
    // OpenRouter succeeds for a key that is pure invention — verified: an
    // obviously fake key returns the full 417-model catalogue — so the old
    // version of this route reported "Connection OK" for a provider that could
    // never answer. Only a completion exercises the key, the credit and the
    // model id together.
    const outcome = await probeProvider({
      id: providerId as ProviderId,
      model,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
    });

    recordProviderOutcome(outcome);
    if (!outcome.ok) logger.warn(`[AI] connection test for ${providerId}/${model} failed: ${outcome.reason}`);

    return outcome.ok
      ? { ok: true, model, message: `${providerId} answered using ${model}.` }
      : { ok: false, model, message: outcome.reason };
  });

  /** Save the operator's choice; it becomes live immediately, no restart. */
  fastify.post("/actions/ai-settings.save", async (request: AuthedRequest, reply) => {
    const actor = request.actor!;

    const permission = agentAccess.canControl(actor);
    if (!permission.allowed) return reply.code(403).send({ error: "forbidden", message: permission.reason });

    const body = ((request.body ?? {}) as Record<string, unknown>) || {};
    const providerId = str(body.provider);

    // Disabling the AI layer is a legitimate save.
    if (providerId === "none") {
      await xprisma.aiSettings.upsert({
        where: { id: 1 },
        create: { id: 1, provider: "none", model: "" },
        update: { provider: "none", model: "", apiKey: null, baseUrl: null },
      });
      applyAiSettings(null);
      agentAccess.record({ actor: actor.name, actorKind: actor.kind, action: "ai-settings.save", target: { provider: "none" }, outcome: "allowed", detail: null });
      logger.info(`[Dashboard] ${actor.kind} "${actor.name}" disabled the AI council`);

      return { ok: true, enabled: false };
    }

    if (!providerId || !AI_PROVIDER_IDS.includes(providerId)) {
      return reply.code(400).send({ error: "bad_request", message: "unknown provider" });
    }

    const model = str(body.model);
    if (!model) return reply.code(400).send({ error: "bad_request", message: "model is required" });

    const row = await loadAiSettings();
    const apiKey = str(body.apiKey) || (row && row.provider === providerId ? row.apiKey : "") || "";
    const needsKey = providerId !== "ollama";
    if (!apiKey && needsKey) {
      return reply.code(400).send({ error: "bad_request", message: `an API key for ${providerId} is required` });
    }

    const baseUrl =
      str(body.baseUrl) || (row && row.provider === providerId ? row.baseUrl : "") || defaultBaseUrlFor(providerId);

    const saved = (await xprisma.aiSettings.upsert({
      where: { id: 1 },
      create: { id: 1, provider: providerId, model, apiKey: apiKey || null, baseUrl },
      update: { provider: providerId, model, apiKey: apiKey || null, baseUrl },
    })) as AiSettingsRow;

    applyAiSettings(saved);
    dashboardService.invalidate();
    agentAccess.record({
      actor: actor.name,
      actorKind: actor.kind,
      action: "ai-settings.save",
      target: { provider: providerId, model },
      outcome: "allowed",
      detail: null,
    });
    logger.info(`[Dashboard] ${actor.kind} "${actor.name}" set the AI council to ${providerId}:${model}`);

    return { ok: true, enabled: true, provider: providerId, model };
  });
}
