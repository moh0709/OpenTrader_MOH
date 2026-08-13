import { z } from "zod";

/**
 * Cross-venue arbitrage scan.
 *
 * Reads public order books only — no API keys, no orders. This endpoint answers
 * "is there an edge right now?", which on liquid pairs is almost always no, and
 * shows the working so the answer can be trusted.
 */
export const ZArbitrageScanInputSchema = z.object({
  symbol: z.string().default("BTC/USDT").describe("Market to scan, e.g. BTC/USDT"),
  venues: z
    .array(z.string())
    .optional()
    .describe("Exchange codes to compare. Defaults to every supported venue."),
  tradeQty: z
    .number()
    .positive()
    .default(0.01)
    .describe("Base quantity to price the spread at. Spread is size-dependent, so this matters."),
  minNetSpreadBps: z
    .number()
    .positive()
    .default(8)
    .describe("Net spread, after all costs, required before an opportunity counts as executable."),
  takerFeeBps: z.number().min(0).default(10).describe("Assumed taker fee per venue, in basis points"),
});
export type TArbitrageScanInputSchema = z.infer<typeof ZArbitrageScanInputSchema>;
