/**
 * The pure parts of the AI widgets: which actions a filter shows, how the
 * header's one figure is counted, and how a proposal is put into words before
 * anyone is asked to approve it.
 *
 * Imported from the module directly rather than through the catalogue, which
 * pulls in the charting code and reaches for `document` while it loads.
 */
import { describe, expect, it } from "vitest";
import { countRecent, describeProposal, filterActions } from "./ai.js";

const at = 1_700_000_000_000;

const action = (chip, over = {}) => ({
  seq: 1,
  id: "ai-1",
  at,
  chip,
  severity: "info",
  botId: 3,
  botName: "Grid-ETH",
  symbol: "ETH/USDT",
  smartTradeId: null,
  title: "t",
  detail: "d",
  target: { botId: 3 },
  autonomous: false,
  ...over,
});

const LIST = [
  action("open"),
  action("close"),
  action("take-profit"),
  action("risk"),
  action("cap"),
  action("denied"),
  action("analysis"),
  action("decision"),
  action("adjust"),
  action("settings"),
  action("learning"),
];

describe("filterActions", () => {
  it("shows everything under All", () => {
    expect(filterActions(LIST, "all")).toHaveLength(LIST.length);
  });

  it("groups the money-moving chips under Trades", () => {
    expect(filterActions(LIST, "trades").map((a) => a.chip)).toEqual(["open", "close", "take-profit"]);
  });

  it("groups everything that stopped or capped the AI under Risk", () => {
    expect(filterActions(LIST, "risk").map((a) => a.chip)).toEqual(["risk", "cap", "denied"]);
  });

  it("groups the council's reasoning under Thinking", () => {
    expect(filterActions(LIST, "thinking").map((a) => a.chip)).toEqual(["analysis", "decision"]);
  });

  it("groups anything that altered a setting under Changes", () => {
    expect(filterActions(LIST, "changes").map((a) => a.chip)).toEqual(["adjust", "settings", "learning"]);
  });

  it("covers every chip across the four narrow filters, so nothing is unreachable", () => {
    const covered = new Set(
      ["trades", "risk", "thinking", "changes"].flatMap((id) => filterActions(LIST, id).map((a) => a.chip)),
    );

    expect(covered.size).toBe(LIST.length);
  });

  it("falls back to everything when handed a filter it does not know", () => {
    expect(filterActions(LIST, "nope")).toBe(LIST);
  });
});

describe("countRecent", () => {
  it("counts only what happened inside the window", () => {
    const list = [action("open", { at }), action("open", { at: at - 30 * 60_000 }), action("open", { at: at - 2 * 3_600_000 })];

    expect(countRecent(list, at)).toBe(2);
  });

  it("counts nothing from an empty feed", () => {
    expect(countRecent([], at)).toBe(0);
  });

  it("includes an action exactly on the boundary rather than dropping it", () => {
    expect(countRecent([action("open", { at: at - 3_600_000 })], at)).toBe(1);
  });
});

describe("describeProposal", () => {
  it("reads the action and its parameters as words", () => {
    expect(describeProposal({ action: "bot.stop", params: { botId: 3 } })).toBe("bot.stop — botId 3");
  });

  it("lists several parameters", () => {
    expect(describeProposal({ action: "bot.setLimits", params: { botId: 3, maxCapital: 60 } })).toBe(
      "bot.setLimits — botId 3, maxCapital 60",
    );
  });

  it("says just the action when it takes no parameters", () => {
    expect(describeProposal({ action: "regime.disarm", params: {} })).toBe("regime.disarm");
    expect(describeProposal({ action: "regime.sync" })).toBe("regime.sync");
  });
});
