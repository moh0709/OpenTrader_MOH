/**
 * Copyright 2024 bludnic
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Repository URL: https://github.com/bludnic/opentrader
 */
import { logger } from "@opentrader/logger";
import { retentionDays, xprisma } from "@opentrader/db";
import { createServer, CreateServerOptions } from "./server.js";
import { RegimeService } from "./regime/regime.service.js";
import { startLearningLoop } from "./learning/learning.service.js";
import { setRuntimeProvider } from "@opentrader/ai-team";
import { dashboardService } from "@opentrader/trpc";
import { bootstrapPlatform, type Platform } from "./platform.js";
import { runPreflight } from "./preflight.js";
import { startAiJournalStore } from "./ai/ai-journal-store.js";

type AppParams = {
  server: CreateServerOptions;
};

/** How often bot logs are pruned. Slow: the window is measured in days. */
const LOG_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The dashboard runs as the single local user, matching the tRPC context. */
const OWNER_ID = 1;

export class App {
  /**
   * Constructs an instance of the class Daemon, called from the create class method.
   *
   * @param platform - The platform instance used by the class.
   * @param server - The server instance created by the `createServer` function.
   */
  private logPruneTimer: NodeJS.Timeout | null = null;
  private regime = new RegimeService();
  private stopLearning: (() => void) | null = null;
  private stopAiJournal: (() => void) | null = null;

  constructor(
    private platform: Platform,
    private server: ReturnType<typeof createServer>,
    serverOptions?: CreateServerOptions,
  ) {
    // Said once, at boot, before anything starts trading. Warnings only: a
    // daemon that refuses to start is a daemon not managing open positions,
    // which is a worse outcome than the configuration it objected to.
    runPreflight({
      env: process.env,
      host: serverOptions?.host ?? "",
      databasePath: dashboardService.databaseFile(),
    });

    this.startLogPruning();
    this.regime.start();
    // Restore the operator's saved AI settings before any strategy can tick,
    // so the council comes up on the provider they chose rather than whatever
    // the environment happens to carry.
    void xprisma.aiSettings
      .findUnique({ where: { id: 1 } })
      .then((row) => {
        if (!row) return;
        if (row.provider === "none") {
          setRuntimeProvider(null);
          logger.info("[AI] Council disabled by saved settings");
        } else {
          setRuntimeProvider({
            id: row.provider as never,
            baseUrl: row.baseUrl ?? "",
            model: row.model,
            ...(row.apiKey ? { apiKey: row.apiKey } : {}),
          });
          logger.info(`[AI] Council restored to ${row.provider}:${row.model}`);
        }
      })
      .catch((err) => logger.warn(`[AI] Could not restore saved settings: ${err instanceof Error ? err.message : String(err)}`));
    // The learning sweep is advisory and off the trading path; it only ever
    // writes journal proposals, which a human applies.
    this.stopLearning = startLearningLoop(OWNER_ID);

    // Bring the AI action feed back from the database, and keep writing to it.
    // Best-effort throughout: an install without the table logs one line and
    // carries on with the in-memory feed.
    void startAiJournalStore()
      .then((stop) => {
        this.stopAiJournal = stop;
      })
      .catch((err) => logger.warn(`[AI] Action history unavailable: ${err instanceof Error ? err.message : String(err)}`));
  }

  /**
   * Periodically drop bot logs past the retention window.
   *
   * The table is append-only and grows for as long as the daemon runs, so
   * without this it only ever gets bigger. Runs off the trading path, and is
   * disabled by setting BOT_LOG_RETENTION_DAYS to 0.
   */
  private startLogPruning() {
    const days = retentionDays();
    if (days <= 0) {
      logger.info("Bot log pruning is disabled (BOT_LOG_RETENTION_DAYS=0)");
      return;
    }

    const prune = async () => {
      try {
        const deleted = await xprisma.botLog.prune();
        if (deleted > 0) logger.info(`Pruned ${deleted} bot log entries older than ${days} days`);
      } catch (err) {
        logger.warn(`Could not prune bot logs: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    void prune();
    this.logPruneTimer = setInterval(() => void prune(), LOG_PRUNE_INTERVAL_MS);
    // Never hold the process open just for housekeeping.
    this.logPruneTimer.unref?.();
  }

  /**
   * Creates a new Daemon instance.
   * @param params - The parameters required to create the Daemon.
   * @returns A promise that resolves to a Daemon instance.
   */
  static async create(params: AppParams): Promise<App> {
    const platform = await bootstrapPlatform();
    logger.info("✅ Platform bootstrapped successfully");

    const server = createServer(params.server);
    await server.listen();

    logger.info(`RPC Server listening on port ${params.server.port}`);
    logger.info(`OpenTrader UI: http://${params.server.host}:${params.server.port}`);

    return new App(platform, server, params.server);
  }

  /**
   * Restarts the app by shutting down and bootstrapping the platform.
   */
  async restart() {
    await this.platform.shutdown();

    this.platform = await bootstrapPlatform();
  }

  /**
   * Shuts down the app by closing the server and shutting down the platform.
   */
  async shutdown() {
    logger.info("Shutting down Platform...");

    if (this.logPruneTimer) {
      clearInterval(this.logPruneTimer);
      this.logPruneTimer = null;
    }

    this.regime.stop();
    if (this.stopLearning) {
      this.stopLearning();
      this.stopLearning = null;
    }

    if (this.stopAiJournal) {
      this.stopAiJournal();
      this.stopAiJournal = null;
    }

    await this.server.close();
    logger.info("Fastify Server has shut down gracefully.");

    await this.platform.shutdown();
    logger.info("Platform has shut down gracefully. Press CTRL+C to exit.");
  }
}
