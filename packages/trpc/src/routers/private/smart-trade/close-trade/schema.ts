import { z } from "zod";

export const ZCloseModeSchema = z
  .enum(["market", "limit"])
  .default("market")
  .describe(
    "market: cancel the resting exit and sell immediately at the best available price (guaranteed exit, taker fee). " +
      "limit: rest the exit on the passive side of the book (maker fee, but may not fill).",
  );

export const ZCloseTradeInputSchema = z.object({
  smartTradeId: z.number().int().positive().describe("ID of the deal to force close"),
  mode: ZCloseModeSchema,
});
export type TCloseTradeInputSchema = z.infer<typeof ZCloseTradeInputSchema>;

export const ZCloseBotTradesInputSchema = z.object({
  botId: z.number().int().positive().describe("Close every open deal belonging to this bot"),
  mode: ZCloseModeSchema,
});
export type TCloseBotTradesInputSchema = z.infer<typeof ZCloseBotTradesInputSchema>;

export const ZCloseAllTradesInputSchema = z.object({
  /**
   * Required opt-in. This closes positions across every bot and every exchange
   * account, so it must never be reachable by a caller that only meant to close
   * one deal and got the endpoint wrong.
   */
  confirm: z.literal(true).describe("Must be exactly true. Closes deals across ALL bots and accounts."),
  mode: ZCloseModeSchema,
});
export type TCloseAllTradesInputSchema = z.infer<typeof ZCloseAllTradesInputSchema>;

/**
 * Force-opening a deal. Deliberately bypasses the strategy that would normally
 * decide entries, so the daemon applies hard limits (per-order notional, open
 * position count, daily budget, symbol allowlist) that this input cannot widen.
 */
export const ZOpenTradeInputSchema = z
  .object({
    botId: z.number().int().positive().describe("Bot supplying the exchange account and default symbol"),
    symbol: z.string().optional().describe("Defaults to the bot's own symbol"),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().positive().optional().describe("Size in base currency"),
    quoteAmount: z.number().positive().optional().describe("Size in quote currency; converted at the current price"),
    orderType: z.enum(["market", "limit"]).default("market"),
    price: z.number().positive().optional().describe("Required for a limit entry"),
    takeProfitPrice: z.number().positive().optional().describe("Optional resting exit placed once the entry fills"),
  })
  .refine((v) => v.quantity !== undefined || v.quoteAmount !== undefined, {
    message: "Give either quantity or quoteAmount",
  })
  .refine((v) => v.orderType !== "limit" || v.price !== undefined, {
    message: "A limit entry requires a price",
  });
export type TOpenTradeInputSchema = z.infer<typeof ZOpenTradeInputSchema>;
