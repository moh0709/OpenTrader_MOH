/**
 * The board model, and above all the migration.
 *
 * The migration runs exactly once per browser, against a board somebody built
 * by hand over weeks, and there is no second chance at it — a bug here silently
 * throws away work that cannot be recovered from anywhere. So it is tested from
 * the data side, in node, rather than being left to a click-through.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TABS,
  activeTab,
  addTab,
  migrate,
  normalise,
  removeTab,
  renameTab,
  seed,
  tabHolding,
  uniqueId,
  withActive,
  withWidgets,
} from "./board.js";

/** Stands in for the widget catalogue, which cannot be imported in node. */
const KNOWN = new Set([
  "kpi",
  "fleet",
  "leaderboard",
  "closedTrades",
  "health",
  "events",
  "equity",
  "aiChat",
  "aiActions",
  "convictionBoard",
  "learningJournal",
  "arbitrageScanner",
]);

let counter = 0;
const deps = {
  knownType: (type) => KNOWN.has(type),
  makeInstance: (type) => ({ uid: `w-${++counter}`, type, span: 4, rows: 2, config: {} }),
};

const instance = (type, over = {}) => ({ uid: `saved-${type}`, type, span: 6, rows: 3, config: {}, ...over });

describe("seed", () => {
  it("lays out every default tab, with the first one open", () => {
    const board = seed(deps);

    expect(board.tabs.map((tab) => tab.id)).toEqual(DEFAULT_TABS.map((tab) => tab.id));
    expect(board.activeTab).toBe(DEFAULT_TABS[0].id);
  });

  it("materialises widget ids into instances", () => {
    const board = seed(deps);
    const overview = board.tabs[0];

    expect(overview.widgets.length).toBeGreaterThan(0);
    for (const widget of overview.widgets) {
      expect(widget.uid).toMatch(/^w-\d+$/);
      expect(typeof widget.type).toBe("string");
    }
  });

  it("gives the AI tab the chat and the action window", () => {
    const ai = seed(deps).tabs.find((tab) => tab.id === "ai");

    expect(ai.widgets.map((widget) => widget.type)).toEqual(
      expect.arrayContaining(["aiChat", "aiActions"]),
    );
  });

  it("skips widget types this build does not have", () => {
    const board = seed({ ...deps, knownType: (type) => type === "kpi" });

    for (const tab of board.tabs) {
      for (const widget of tab.widgets) expect(widget.type).toBe("kpi");
    }
  });
});

describe("migrate", () => {
  const v1 = { widgets: [instance("fleet"), instance("equity"), instance("health")] };

  it("keeps your board exactly as it was, on the first tab, open", () => {
    const board = migrate(v1, deps);

    expect(board.activeTab).toBe("overview");
    // Same widgets, same order, same uids, same sizes. Nothing re-sorted.
    expect(board.tabs[0].widgets).toEqual(v1.widgets);
  });

  it("appends the new tabs after yours rather than mixing them in", () => {
    const board = migrate(v1, deps);

    expect(board.tabs).toHaveLength(DEFAULT_TABS.length);
    expect(board.tabs.map((tab) => tab.id)).toEqual(DEFAULT_TABS.map((tab) => tab.id));
    expect(board.tabs.some((tab) => tab.id === "ai")).toBe(true);
  });

  it("drops widgets whose type no longer exists", () => {
    const board = migrate({ widgets: [instance("fleet"), instance("longGone")] }, deps);

    expect(board.tabs[0].widgets.map((w) => w.type)).toEqual(["fleet"]);
  });

  it("falls back to a fresh board when there is nothing worth keeping", () => {
    expect(migrate({ widgets: [] }, deps).tabs[0].widgets.length).toBeGreaterThan(0);
    expect(migrate({ widgets: [instance("longGone")] }, deps).tabs[0].widgets.length).toBeGreaterThan(0);
    expect(migrate(undefined, deps).tabs).toHaveLength(DEFAULT_TABS.length);
  });
});

describe("normalise", () => {
  const saved = {
    activeTab: "mine",
    tabs: [{ id: "mine", name: "Mine", widgets: [instance("kpi"), instance("gone")] }],
  };

  it("keeps a saved board and drops widgets that no longer exist", () => {
    const board = normalise(saved, deps);

    expect(board.tabs[0].widgets.map((w) => w.type)).toEqual(["kpi"]);
    expect(board.activeTab).toBe("mine");
  });

  it("says nothing when there is no saved board, so the caller can look elsewhere", () => {
    expect(normalise(null, deps)).toBeNull();
    expect(normalise({}, deps)).toBeNull();
    expect(normalise({ tabs: "not an array" }, deps)).toBeNull();
  });

  it("puts an active tab that no longer exists back onto the first one", () => {
    expect(normalise({ ...saved, activeTab: "deleted" }, deps).activeTab).toBe("mine");
  });

  it("rebuilds a board whose tabs are all unusable rather than showing an empty page", () => {
    const board = normalise({ activeTab: "x", tabs: [{ name: "no id" }, null] }, deps);

    expect(board.tabs).toHaveLength(DEFAULT_TABS.length);
  });

  it("names an unnamed tab after its id rather than leaving a blank tab", () => {
    expect(normalise({ activeTab: "a", tabs: [{ id: "a", widgets: [] }] }, deps).tabs[0].name).toBe("a");
  });
});

describe("tab operations", () => {
  const board = () => seed(deps);

  it("adds a tab, gives it a slug id and opens it", () => {
    const next = addTab(board(), "My  Desk");

    expect(next.tabs.at(-1).id).toBe("my-desk");
    expect(next.tabs.at(-1).name).toBe("My  Desk");
    expect(next.activeTab).toBe("my-desk");
  });

  it("does not reuse an id that is already taken", () => {
    const once = addTab(board(), "Desk");
    const twice = addTab(once, "Desk");

    expect(twice.tabs.at(-1).id).toBe("desk-2");
  });

  it("falls back to a usable id when the name has nothing to slug", () => {
    expect(addTab(board(), "***").tabs.at(-1).id).toBe("tab");
    expect(addTab(board(), "   ").tabs.at(-1).name).toBe("New tab");
  });

  it("keeps the id when a tab is renamed, so deep links survive", () => {
    const next = renameTab(board(), "ai", "Copilot");
    const tab = next.tabs.find((t) => t.name === "Copilot");

    expect(tab.id).toBe("ai");
  });

  it("ignores an empty rename rather than leaving an unlabelled tab", () => {
    expect(renameTab(board(), "ai", "   ").tabs.find((t) => t.id === "ai").name).toBe("AI");
  });

  it("removes a tab and opens its neighbour when it was the one you were on", () => {
    const start = withActive(board(), "ai");
    const index = start.tabs.findIndex((tab) => tab.id === "ai");
    const next = removeTab(start, "ai");

    expect(next.tabs.some((tab) => tab.id === "ai")).toBe(false);
    expect(next.activeTab).toBe(next.tabs[index].id);
  });

  it("leaves the open tab alone when a different one is removed", () => {
    const start = withActive(board(), "ai");

    expect(removeTab(start, "analytics").activeTab).toBe("ai");
  });

  it("refuses to remove the last tab, which would leave nowhere to go", () => {
    const single = { activeTab: "only", tabs: [{ id: "only", name: "Only", widgets: [] }] };

    expect(removeTab(single, "only")).toBe(single);
  });

  it("ignores a request to switch to a tab that is not there", () => {
    const start = board();

    expect(withActive(start, "nope")).toBe(start);
  });

  it("replaces the widgets of one tab and leaves the others untouched", () => {
    const start = board();
    const next = withWidgets(start, "ai", []);

    expect(next.tabs.find((tab) => tab.id === "ai").widgets).toEqual([]);
    expect(next.tabs.find((tab) => tab.id === "overview").widgets).toEqual(
      start.tabs.find((tab) => tab.id === "overview").widgets,
    );
  });
});

describe("tabHolding", () => {
  it("finds the tab that owns a group, which is where a deep link should land", () => {
    expect(tabHolding(seed(deps), ["arbitrageScanner"]).id).toBe("arbitrage");
  });

  it("says nothing when no tab holds any of them", () => {
    expect(tabHolding(seed(deps), ["nowhere"])).toBeNull();
  });
});

describe("activeTab", () => {
  it("falls back to the first tab rather than returning nothing", () => {
    expect(activeTab({ activeTab: "missing", tabs: [{ id: "a", name: "A", widgets: [] }] }).id).toBe("a");
  });
});

describe("uniqueId", () => {
  it("counts up only as far as it needs to", () => {
    expect(uniqueId("desk", [])).toBe("desk");
    expect(uniqueId("desk", ["desk"])).toBe("desk-2");
    expect(uniqueId("desk", ["desk", "desk-2"])).toBe("desk-3");
    expect(uniqueId("desk", ["desk", "desk-3"])).toBe("desk-2");
  });
});
