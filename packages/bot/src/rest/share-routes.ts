/**
 * The viewer side of a share link.
 *
 * Deliberately a separate plugin from the dashboard routes, because it is the
 * only surface on this server reachable without the admin password. Keeping it
 * apart makes its boundary something you can read in one file rather than a
 * condition buried in a shared handler.
 *
 * What a viewer may do is the whole of it: identify themselves with a token and
 * a device, and read a reduced snapshot. There is no control action here, no
 * bot list beyond what the feed shows, no health, no logs, no other share links.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { dashboardService, derive } from "@opentrader/trpc";
import { HEARTBEAT_INTERVAL_MS } from "../processing/share/share-links.js";
import { admitViewer } from "../processing/share/share.service.js";

const OWNER_ID = 1;

type ShareRequest = FastifyRequest & { viewer?: { name: string; email: string; expiresAt: number } };

/**
 * The shape this route reads out of the analytics.
 *
 * Declared here rather than imported, because the workspace declaration files
 * are not built in a clean checkout and the imported type degrades to any.
 */
type DerivedShape = {
  roundTrips: Array<{
    botId: number | null;
    symbol: string;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    netPnl: number;
    pnlPercent: number;
    holdMs: number;
    exitAt: number;
    outcome: string;
  }>;
  openPositions: Array<{
    botId: number | null;
    symbol: string;
    exitState: string;
    entryPrice: number;
    costBasis: number;
    markPrice: number | null;
    marketValue: number | null;
    floatingPnl: number | null;
    floatingPnlPercent: number | null;
  }>;
  botStats: Array<{
    name: string;
    symbol: string;
    enabled: boolean;
    realized: { trades: number; netPnl: number };
    positions: { open: number; floatingPnl: number | null };
  }>;
};

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

export async function shareRoutes(fastify: FastifyInstance) {
  /**
   * Every request re-checks the token and the device, and doubles as the
   * heartbeat. A revoked or expired link therefore stops working on the next
   * poll rather than at the end of some session.
   */
  fastify.addHook("preHandler", async (request: ShareRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const body = (request.body ?? {}) as Record<string, unknown>;

    const token = str(request.headers["x-share-token"]) ?? str(query.share) ?? str(body.token);
    const deviceId = str(request.headers["x-share-device"]) ?? str(query.device) ?? str(body.deviceId);

    if (!token || !deviceId) {
      return reply.code(401).send({ error: "invalid", message: "This link is not valid." });
    }

    const session = await admitViewer(token, deviceId);
    if (!session.ok) {
      // 403 for a link that exists but is not for this device, so the page can
      // tell "already in use" apart from "never valid".
      return reply.code(session.code === "in_use" ? 403 : 401).send({ error: session.code, message: session.message });
    }

    request.viewer = { name: session.name, email: session.email, expiresAt: session.expiresAt };
  });

  /** Confirms the link works and says who the viewer is. */
  fastify.get("/session", async (request: ShareRequest) => ({
    ok: true,
    name: request.viewer!.name,
    expiresAt: request.viewer!.expiresAt,
    heartbeatMs: HEARTBEAT_INTERVAL_MS,
  }));

  /**
   * The live feed.
   *
   * A reduced snapshot: fleet totals, per-bot performance and recent closed
   * trades. No exchange account details, no order ids, no health, and no share
   * links - a viewer must not be able to see who else has been given access.
   */
  fastify.get("/snapshot", async (request: ShareRequest) => {
    const context = await dashboardService.getContext(OWNER_ID);
    const analytics = derive(context) as DerivedShape;
    const closed = analytics.roundTrips;
    const priced = analytics.openPositions.every((position) => position.floatingPnl !== null);

    return {
      generatedAt: context.now,
      viewer: { name: request.viewer!.name, expiresAt: request.viewer!.expiresAt },
      fleet: {
        bots: context.bots.length,
        enabledBots: context.bots.filter((bot: { enabled: boolean }) => bot.enabled).length,
        trades: closed.length,
        netPnl: closed.reduce((sum, rt) => sum + rt.netPnl, 0),
        wins: closed.filter((rt) => rt.outcome === "win").length,
        losses: closed.filter((rt) => rt.outcome === "loss").length,
        openPositions: analytics.openPositions.length,
        // Null rather than a wrong number when any symbol could not be priced.
        floatingPnl: priced ? analytics.openPositions.reduce((sum, p) => sum + (p.floatingPnl ?? 0), 0) : null,
      },
      bots: analytics.botStats.map((bot) => ({
        name: bot.name,
        symbol: bot.symbol,
        enabled: bot.enabled,
        trades: bot.realized.trades,
        netPnl: bot.realized.netPnl,
        openPositions: bot.positions.open,
        floatingPnl: bot.positions.floatingPnl,
      })),
      // Open positions, for the bottom ticker. Deliberately reduced: bot name
      // and symbol rather than ids, no smart-trade or order identifiers, and
      // nothing a viewer could act on. It is the same class of information the
      // per-bot rows above already expose, one row per position instead of
      // summed, so the shared bar can say exactly what the owner's says.
      openPositions: analytics.openPositions.map((position) => ({
        botName: position.botId === null ? "—" : (context.botNames.get(position.botId) ?? `Bot ${position.botId}`),
        symbol: position.symbol,
        exitState: position.exitState,
        costBasis: position.costBasis,
        markPrice: position.markPrice,
        marketValue: position.marketValue,
        floatingPnl: position.floatingPnl,
        floatingPnlPercent: position.floatingPnlPercent,
        entryPrice: position.entryPrice,
      })),
      recentTrades: closed.slice(0, 30).map((rt) => ({
        botName: rt.botId === null ? "—" : (context.botNames.get(rt.botId) ?? `Bot ${rt.botId}`),
        symbol: rt.symbol,
        entryPrice: rt.entryPrice,
        exitPrice: rt.exitPrice,
        quantity: rt.quantity,
        netPnl: rt.netPnl,
        pnlPercent: rt.pnlPercent,
        holdMs: rt.holdMs,
        exitAt: rt.exitAt,
        outcome: rt.outcome,
      })),
      tickers: context.tickers.map((ticker: { symbol: string; last: number | null; stale: boolean }) => ({
        symbol: ticker.symbol,
        last: ticker.last,
        stale: ticker.stale,
      })),
    };
  });
}
