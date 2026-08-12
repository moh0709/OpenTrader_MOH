import { describe, expect, it } from "vitest";
import { markRising, statusOf, toTickerItem, toTickerItems } from "./ticker.js";

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
  targetPrice: 62_000,
  ...over,
});

describe("statusOf", () => {
  it("says take profit when an exit is working and the trade is up", () => {
    expect(statusOf(position({ exitState: "live", floatingPnl: 12 }))).toBe("TAKE PROFIT");
  });

  it("says floating when an exit is working but the trade is flat or down", () => {
    expect(statusOf(position({ exitState: "live", floatingPnl: -3 }))).toBe("FLOATING");
    expect(statusOf(position({ exitState: "live", floatingPnl: 0 }))).toBe("FLOATING");
  });

  it("says open when no exit order is working, however well the trade is doing", () => {
    expect(statusOf(position({ exitState: "missing", floatingPnl: 50 }))).toBe("OPEN");
    expect(statusOf(position({ exitState: "abandoned", floatingPnl: 50 }))).toBe("OPEN");
  });
});

describe("markRising", () => {
  it("flags nothing the first time, having nothing to compare against", () => {
    const seen = new Map();

    expect(markRising(toTickerItems([position()], {}), seen)[0].rising).toBeUndefined();
  });

  it("flags a trade whose value went up since the last poll", () => {
    const seen = new Map();

    markRising(toTickerItems([position({ marketValue: 1000 })], {}), seen);
    const after = markRising(toTickerItems([position({ marketValue: 1010 })], {}), seen);

    expect(after[0].rising).toBe(true);
  });

  it("does not flag a fall or a flat value", () => {
    const seen = new Map();

    markRising(toTickerItems([position({ marketValue: 1000 })], {}), seen);
    expect(markRising(toTickerItems([position({ marketValue: 990 })], {}), seen)[0].rising).toBeUndefined();
    expect(markRising(toTickerItems([position({ marketValue: 990 })], {}), seen)[0].rising).toBeUndefined();
  });

  it("tracks each trade separately", () => {
    const seen = new Map();
    const round = (a, b) =>
      markRising(toTickerItems([position({ smartTradeId: 1, marketValue: a }), position({ smartTradeId: 2, marketValue: b })], {}), seen);

    round(1000, 1000);
    const after = round(1010, 990);

    expect(after.find((i) => i.key === 1).rising).toBe(true);
    expect(after.find((i) => i.key === 2).rising).toBeUndefined();
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
