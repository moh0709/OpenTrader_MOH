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
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eventBus } from "@opentrader/event-bus";
import { xprisma } from "@opentrader/db";
import { findStrandedPositions, recoverPositions } from "../processing/executors/recover-position.js";
import { previewPurge, purgeBotTrades, setBotLimits } from "../processing/executors/purge-bot.js";
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
import { logger } from "@opentrader/logger";
import type { Actor, AgentActionRecord, BotLogRow, BucketSize, DashboardEvent, LeaderboardMetric } from "@opentrader/trpc";
import {
  BotService,
  agentAccess,
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

type AuthedRequest = FastifyRequest & { actor?: Actor };

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
      { path: "GET /api/dash/positions/stranded", params: { botId: "number" }, description: "Positions holding stock with no exit order, and what recovery would place for each. Read-only dry run." },
      { path: "GET /api/dash/bots/:botId/purge-preview", params: {}, description: "What purging a bot would delete, and whether it is currently allowed. Read-only." },
      { path: "GET /api/dash/bots/:botId/limits", params: {}, description: "A bot's capital cap and minimum profit." },
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

    return buildHealthView({
      derived: context,
      database: dashboardService.getDatabaseStats(),
      databasePath: dashboardService.databaseFile(),
      process: dashboardService.processStats(),
      host: dashboardService.hostStats(),
      lastBotActivity,
      paperFillPatchApplied: dashboardService.hasPaperFillFix(),
      apiLatencyMs: Date.now() - startedAt,
    });
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

      return { ok: true, action, botId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      agentAccess.record({ actor: actor.name, actorKind: actor.kind, action, target: { botId }, outcome: "failed", detail: message });

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
}
