import { router } from "../../../trpc.js";
import { authorizedProcedure } from "../../../procedures.js";
import { getSmartTrades } from "./get-smart-trades/handler.js";
import { ZGetSmartTradesSchema } from "./get-smart-trades/schema.js";
import { getInfiniteSmartTrades } from "./get-infinite-smart-trades/handler.js";
import { ZGetInfiniteSmartTradesSchema } from "./get-infinite-smart-trades/schema.js";
import { getSmartTrade } from "./get-smart-trade/handler.js";
import { ZGetSmartTradeInputSchema } from "./get-smart-trade/schema.js";
import { closeBotDeals, closeEverything, closeTrade } from "./close-trade/handler.js";
import {
  ZCloseAllTradesInputSchema,
  ZCloseBotTradesInputSchema,
  ZCloseTradeInputSchema,
} from "./close-trade/schema.js";

export const smartTradeRouter = router({
  list: authorizedProcedure.input(ZGetSmartTradesSchema).query(getSmartTrades),
  infiniteList: authorizedProcedure.input(ZGetInfiniteSmartTradesSchema).query(getInfiniteSmartTrades),
  getOne: authorizedProcedure.input(ZGetSmartTradeInputSchema).query(getSmartTrade),

  /**
   * Force take profit / close deal. These are the only endpoints in the API
   * that act on an individual trade.
   */
  close: authorizedProcedure.input(ZCloseTradeInputSchema).mutation(closeTrade),
  closeBotTrades: authorizedProcedure.input(ZCloseBotTradesInputSchema).mutation(closeBotDeals),
  closeAll: authorizedProcedure.input(ZCloseAllTradesInputSchema).mutation(closeEverything),
});
