/**
 * The rules behind the highlight: how long a bubble stays, and what it points
 * at. Both are pure, and both are the kind of thing that is hard to check by
 * eye — a dwell that is 200ms short reads as "it flickered", not as a bug.
 */
import { describe, expect, it } from "vitest";
import { dwellMs, resolveTarget, selectorsFor } from "./spotlight.js";

const action = (over = {}) => ({
  chip: "open",
  severity: "info",
  title: "Opened ETH/USDT",
  detail: "Bought about 100.00 quote at market.",
  target: { botId: 3 },
  at: 1_700_000_000_000,
  ...over,
});

describe("dwellMs", () => {
  it("holds a short line for the two-second floor", () => {
    expect(dwellMs({ title: "Closed", detail: "+$3.40" })).toBe(2000);
  });

  it("holds a full sentence for the four-second ceiling", () => {
    expect(dwellMs({ title: "Cap cut on Grid-BTC", detail: "x".repeat(140) })).toBe(4000);
  });

  it("scales in between rather than jumping between two values", () => {
    const short = dwellMs({ title: "", detail: "x".repeat(50) });
    const longer = dwellMs({ title: "", detail: "x".repeat(70) });

    expect(short).toBeGreaterThan(2000);
    expect(longer).toBeGreaterThan(short);
    expect(longer).toBeLessThan(4000);
  });

  it("never goes outside the two-to-four second band, whatever it is handed", () => {
    for (const input of [undefined, null, {}, { detail: "" }, { detail: "y".repeat(10_000) }]) {
      const result = dwellMs(input);

      expect(result).toBeGreaterThanOrEqual(2000);
      expect(result).toBeLessThanOrEqual(4000);
    }
  });
});

describe("selectorsFor", () => {
  it("prefers a trade row over the bot row that contains it", () => {
    const selectors = selectorsFor(action({ target: { smartTradeId: 649, botId: 3 } }));

    expect(selectors[0]).toBe('[data-trade-id="649"]');
    expect(selectors[1]).toBe('[data-bot-id="3"]');
  });

  it("falls back through bot, symbol and widget in that order", () => {
    expect(selectorsFor(action({ target: { botId: 3, symbol: "ETH/USDT", widget: "fleet" } }))).toEqual([
      '[data-bot-id="3"]',
      '[data-symbol="ETH/USDT"]',
      '[data-type="fleet"]',
      '[data-tabs] [data-tab="ai"]',
    ]);
  });

  it("always ends at the AI tab, so nothing is ever unexplained", () => {
    // An action nobody can see happen is the failure this feature exists to fix.
    expect(selectorsFor(action({ target: {} })).at(-1)).toBe('[data-tabs] [data-tab="ai"]');
    expect(selectorsFor({}).at(-1)).toBe('[data-tabs] [data-tab="ai"]');
  });

  it("treats bot id zero as a bot id rather than as absent", () => {
    expect(selectorsFor(action({ target: { botId: 0 } }))[0]).toBe('[data-bot-id="0"]');
  });
});

describe("resolveTarget", () => {
  /** Enough of a document to answer querySelector for the ones we planted. */
  const root = (present) => ({
    querySelector: (selector) => (present.includes(selector) ? { selector } : null),
  });

  it("takes the most specific target that is actually on screen", () => {
    const node = resolveTarget(action({ target: { smartTradeId: 649, botId: 3 } }), root(['[data-bot-id="3"]']));

    expect(node.selector).toBe('[data-bot-id="3"]');
  });

  it("returns nothing when not even the fallback is there", () => {
    expect(resolveTarget(action(), root([]))).toBeNull();
  });
});
