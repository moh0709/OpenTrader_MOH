import type { Dictionary, Market } from "ccxt";
import type { ExchangeCode } from "@opentrader/types";
import { xprisma } from "@opentrader/db";
import type { ICacheProvider } from "../../../types/cache/cache-provider.interface.js";
import type { IExchange } from "../../../types/exchange.interface.js";

type CacheKey = ExchangeCode | `demo-${ExchangeCode}`;

export class PrismaCacheProvider implements ICacheProvider {
  async getMarkets(exchange: IExchange) {
    const startTime = Date.now();

    const cacheKey = `${exchange.isDemo ? "demo-" : ""}${exchange.exchangeCode}` as const;
    const cachedMarkets = await xprisma.markets.findUnique({
      where: {
        exchangeCode: cacheKey,
      },
    });

    if (cachedMarkets) {
      // The column is TEXT holding the JSON written by cacheMarkets, so it has
      // to be parsed back. Returning it raw handed the caller a string wearing
      // a Dictionary type, and a cache that returns the wrong shape is worse
      // than no cache at all. Latent so far only because nothing calls
      // setCacheProvider: the default MemoryCacheProvider is what actually runs.
      const markets = JSON.parse(cachedMarkets.markets) as Dictionary<Market>;
      const duration = (Date.now() - startTime) / 1000;

      console.info(
        `PrismaCacheProvider: Fetched ${Object.keys(markets).length} markets on ${cacheKey} from cache in ${duration}s`,
      );

      return markets;
    }

    // If not cached, loadMarkets and cache to DB
    const markets = await exchange.ccxt.loadMarkets();

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    console.info(
      `PrismaCacheProvider: Fetched ${Object.keys(markets).length} markets on ${cacheKey} exchange in ${duration}s`,
    );

    return this.cacheMarkets(markets, cacheKey);
  }

  private async cacheMarkets(markets: Dictionary<Market>, cacheKey: CacheKey) {
    await xprisma.markets.create({
      data: {
        exchangeCode: cacheKey,
        markets: JSON.stringify(markets),
      },
    });
    return markets;
  }
}
