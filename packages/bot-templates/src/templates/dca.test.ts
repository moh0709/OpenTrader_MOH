import { afterEach, describe, expect, it, vi } from "vitest";

import { dca } from "./dca.js";

describe("dca indicator snapshot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists the exact indicators used for the entry decision", () => {
    vi.spyOn(Date, "now").mockReturnValue(1786149000000);

    const state: Record<string, unknown> = {};
    const context = {
      config: {
        id: 6,
        symbol: "SOL/USD",
        settings: {
          entry: {
            quantity: 1,
            type: "Market",
            conditions: {
              combinator: "and",
              rules: [
                {
                  field: "RSI",
                  operator: "<=",
                  value: {
                    indicatorValue: "28",
                    timeframe: "4h",
                    periods: "14",
                  },
                  id: "sol-rsi-entry",
                },
              ],
              id: "sol-entry",
            },
          },
          tp: { percent: 4 },
          sl: { percent: 20 },
          safetyOrders: [],
        },
      },
      onStart: false,
      onStop: false,
      onProcess: true,
      state,
    };

    const indicators = {
      RSI: {
        "4h": {
          '{"periods":14}': 56.22,
        },
      },
    };

    const iterator = dca(context as never) as Generator<unknown, unknown, unknown>;
    iterator.next();
    iterator.next(indicators);

    expect(state.indicatorSnapshot).toEqual({
      values: indicators,
      updatedAt: 1786149000000,
    });
  });
});
