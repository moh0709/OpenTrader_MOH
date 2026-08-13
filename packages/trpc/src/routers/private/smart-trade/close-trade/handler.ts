import { getTradeOps, type CloseTradeResult } from "../../../../services/trade-ops.registry.js";
import type { Context } from "../../../../utils/context.js";

// Logging lives in the closer itself (packages/bot), which records every
// cancel, placement and outcome. Duplicating it here would only add a
// dependency edge for no extra information.
import type {
  TCloseAllTradesInputSchema,
  TCloseBotTradesInputSchema,
  TCloseTradeInputSchema,
  TOpenTradeInputSchema,
} from "./schema.js";

type Options<T> = {
  ctx: { user: NonNullable<Context["user"]> };
  input: T;
};

/** Roll a batch of per-deal results into a summary a caller can act on. */
function summarize(results: CloseTradeResult[]) {
  return {
    ok: true,
    total: results.length,
    closed: results.filter((r) => r.outcome === "closed").length,
    cancelled: results.filter((r) => r.outcome === "canceled_unfilled").length,
    alreadyClosed: results.filter((r) => r.outcome === "already_closed").length,
    results,
  };
}

/**
 * Force close ("force take profit") a single deal.
 */
export async function closeTrade({ input }: Options<TCloseTradeInputSchema>) {
  const { smartTradeId, mode } = input;

  const result = await getTradeOps().closeSmartTrade(smartTradeId, mode);

  return { ok: true, ...result };
}

/**
 * Force close every open deal belonging to one bot.
 */
export async function closeBotDeals({ input }: Options<TCloseBotTradesInputSchema>) {
  const { botId, mode } = input;

  const results = await getTradeOps().closeBotTrades(botId, mode);

  return summarize(results);
}

/**
 * Force close every open deal across every bot and account.
 *
 * The confirm flag is enforced by the schema, but re-checked here so the
 * guarantee does not depend on validation being wired correctly upstream.
 */
export async function closeEverything({ input }: Options<TCloseAllTradesInputSchema>) {
  const { confirm, mode } = input;

  if (confirm !== true) {
    throw new Error("closeAll requires confirm: true — it closes deals across every bot and account.");
  }

  const results = await getTradeOps().closeAllTrades(mode);

  return summarize(results);
}

/**
 * Force-open a deal, bypassing strategy.
 *
 * The daemon refuses rather than resizes when a request exceeds its limits, so
 * a rejected call returns ok: false with the reasons rather than quietly
 * opening something smaller than was asked for.
 */
export async function openTrade({ input }: Options<TOpenTradeInputSchema>) {
  return getTradeOps().openSmartTrade(input);
}
