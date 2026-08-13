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
export * from "./channels/index.js";
export { CCXTCandlesProvider } from "./market-data/ccxt-candles.provider.js";
export { Platform } from "./platform.js";
export { App } from "./app.js";
export { closeSmartTrade, closeBotTrades, closeAllTrades } from "./trade-closer.js";
export type { CloseMode, CloseOutcome, CloseTradeResult } from "./trade-closer.js";
export {
  findStrandedPositions,
  recoverPosition,
  recoverPositions,
  type RecoverablePosition,
  type RecoveryResult,
} from "./processing/executors/recover-position.js";
export {
  previewPurge,
  purgeBotTrades,
  setBotLimits,
  type PurgePreview,
  type PurgeResult,
  type SetLimitsResult,
} from "./processing/executors/purge-bot.js";
export { openSmartTrade, manualLimitsFromEnv, manualNotionalToday, openManualPositions } from "./trade-opener.js";
export type { OpenTradeParams, OpenTradeResult, ManualTradeLimits } from "./trade-opener.js";
