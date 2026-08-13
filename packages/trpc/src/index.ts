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
export { trpc } from "./trpc.js";
export { type AppRouter, appRouter } from "./routers/appRouter.js";
export { createContext, type Context } from "./utils/context.js";
export {
  registerTradeOps,
  getTradeOps,
  resetTradeOps,
  type TradeOps,
  type CloseMode,
  type CloseOutcome,
  type CloseTradeResult,
} from "./services/trade-ops.registry.js";
export { BotService } from "./services/bot.service.js";
export { dashboardService, type BotLogRow } from "./services/dashboard.service.js";
export * from "./services/dashboard-views.js";
export { agentAccess, type Actor, type AgentScope, type AgentActionRecord } from "./services/agent-access.js";
export type { BucketSize, DashboardEvent, LeaderboardMetric } from "./services/analytics/index.js";
