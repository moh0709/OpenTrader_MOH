import { describe, expect, it } from "vitest";
import { statusOf, toTickerItem, toTickerItems } from "./ticker.js";

const position = (over = {}) => ({
  smartTradeId: 1,
  botId: 8,
  symbol: "BTC/USD",
  entryPrice: 60_000,
  costBasis: 1000,
  markPrice: 61_000,
  marketValue: 1016.67,
  floatingPnl: 16.67,
  floatingPnlPercent: 1.667,
  exitState: "live",
  ...over,
});

describe("statusOf", () => {
  it("calls a working exit order a take profit", () => {
    expect(statusOf(position({ exitState: "live" }))).toBe("TAKE PROFIT");
  });

  it("calls a cancelled exit floating, because that is the case worth noticing", () => {
    expect(statusOf(position({ exitState: "abandoned" }))).toBe("FLOATING");
  });

  it("calls a position with no exit order open", () => {
    expect(statusOf(position({ exitState: "missing" }))).toBe("OPEN");
  });
});

describe("toTickerItem", () => {
  it("builds the line from the position", () => {
    const item = toTickerItem(position(), { 8: "Hermes mini" });

    expect(item.botName).toBe("Hermes mini");
    expect(item.symbol).toBe("BTC/USD");
    expect(item.status).toBe("TAKE PROFIT");
    expect(item.opened).toContain("1,000");
    expect(item.value).toContain("1,016");
    expect(item.floating).toContain("+");
    expect(item.change).toContain("1.67");
  });

  it("marks a gain up and a loss down", () => {
    expect(toTickerItem(position({ floatingPnlPercent: 2 })).direction).toBe("up");
    expect(toTickerItem(position({ floatingPnlPercent: -2, floatingPnl: -20 })).direction).toBe("down");
    expect(toTickerItem(position({ floatingPnlPercent: 0, floatingPnl: 0 })).direction).toBe("flat");
  });

  it("carries a direction glyph, so colour is never the only signal", () => {
    expect(toTickerItem(position({ floatingPnlPercent: 2 })).arrow).toBe("\u25b2");
    expect(toTickerItem(position({ floatingPnlPercent: -2 })).arrow).toBe("\u25bc");
  });

  it("keeps the raw percent for ordering as well as the formatted one", () => {
    const item = toTickerItem(position({ floatingPnlPercent: -3.5 }));

    expect(item.changeValue).toBe(-3.5);
    expect(typeof item.change).toBe("string");
  });

  it("drops a position with no live price rather than showing it as flat", () => {
    expect(toTickerItem(position({ markPrice: null, floatingPnl: null }))).toBeNull();
    expect(toTickerItem(position({ floatingPnl: null }))).toBeNull();
  });

  it("prefers a name the row already carries, as a shared feed sends", () => {
    expect(toTickerItem(position({ botName: "From share" }), { 8: "From map" }).botName).toBe("From share");
  });

  it("falls back to the bot id, then to a dash when there is no bot", () => {
    expect(toTickerItem(position(), {}).botName).toBe("Bot 8");
    expect(toTickerItem(position({ botId: null }), {}).botName).toBe("\u2014");
  });
});

describe("toTickerItems", () => {
  it("shows the worst first, so losses are not buried at the end of the cycle", () => {
    const items = toTickerItems(
      [
        position({ smartTradeId: 1, floatingPnlPercent: 5 }),
        position({ smartTradeId: 2, floatingPnlPercent: -8 }),
        position({ smartTradeId: 3, floatingPnlPercent: 0.5 }),
      ],
      {},
    );

    expect(items.map((item) => item.changeValue)).toEqual([-8, 0.5, 5]);
  });

  it("omits unpriced positions entirely", () => {
    const items = toTickerItems([position({ smartTradeId: 1 }), position({ smartTradeId: 2, markPrice: null })], {});

    expect(items).toHaveLength(1);
  });
});
