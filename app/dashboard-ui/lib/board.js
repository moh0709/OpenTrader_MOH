/**
 * The board: which tabs exist, what is on each of them, and which one you are
 * looking at.
 *
 * The dashboard used to be one long grid holding every widget you had ever
 * added. That works up to about a dozen; past it you scroll to find anything,
 * every chart on the page redraws on every refresh, and the presets — the only
 * way to get a focused view — replaced your whole board to give you one.
 *
 * Tabs make the preset idea permanent: each tab is its own board, only the
 * active one is rendered, and switching costs nothing because the others were
 * never built.
 *
 * Everything here is pure data. The widget catalogue reaches for `document` the
 * moment it loads, so this module knows nothing about widgets beyond their type
 * ids: callers pass in `makeInstance` to build one and `knownType` to say which
 * ids still exist. That is what keeps the migration testable in node, which
 * matters more here than anywhere else on the page — it runs once, against a
 * board somebody built by hand, and there is no second chance at it.
 */
import { groupSlug } from "./groups.js";
import { boardStorage, layoutStorage } from "./store.js";

/**
 * Named widget sets. These began as the preset buttons in settings and are now
 * also the seed for the default tabs, so there is one list per view rather than
 * one per view per feature.
 */
export const PRESETS = {
  overview: ["kpi", "leaderboard", "fleet", "closedTrades", "health"],
  desk: ["kpi", "gridLadder", "openPositions", "closedTrades", "abandoned", "events"],
  analytics: ["kpi", "equity", "winLoss", "pnlDistribution", "holdTime", "heatmap", "fees"],
  ops: ["kpi", "health", "events", "botLogs", "fleet"],
  // The AI desk: what the council thinks, what it is doing about it, and the
  // argument it had on the way there.
  mission: ["kpi", "convictionBoard", "regimeImpact", "learningJournal", "researchRoom", "researchLog"],
};

/**
 * The tabs a new board starts with.
 *
 * `id` doubles as the URL fragment, so these are also the deep links. The AI
 * tab is deliberately not last: it is the one this whole feature exists for,
 * and burying it behind Operations would say the opposite.
 */
export const DEFAULT_TABS = [
  { id: "overview", name: "Overview", widgets: PRESETS.overview },
  { id: "trades", name: "Trades", widgets: PRESETS.desk },
  { id: "ai", name: "AI", widgets: ["aiChat", "aiActions", "convictionBoard", "learningJournal"] },
  { id: "analytics", name: "Analytics", widgets: PRESETS.analytics },
  { id: "research", name: "Research", widgets: PRESETS.mission },
  { id: "arbitrage", name: "Arbitrage", widgets: ["arbitrageScanner", "arbitrageVenues"] },
  { id: "operations", name: "Operations", widgets: PRESETS.ops },
];

/** A tab name as a URL fragment, e.g. "Grid & market" -> "grid-market". */
export const slugify = groupSlug;

/** `base`, or `base-2`, `base-3`… until it is not already taken. */
export function uniqueId(base, taken) {
  const root = base || "tab";
  if (!taken.includes(root)) return root;

  let suffix = 2;
  while (taken.includes(`${root}-${suffix}`)) suffix += 1;

  return `${root}-${suffix}`;
}

/** Build one tab from a spec, materialising each widget id into an instance. */
function buildTab(spec, makeInstance, knownType) {
  return {
    id: spec.id,
    name: spec.name,
    widgets: spec.widgets.filter((type) => knownType(type)).map((type) => makeInstance(type)),
  };
}

/** A board with the default tabs, for a browser that has never been here. */
export function seed({ makeInstance, knownType }) {
  return {
    activeTab: DEFAULT_TABS[0].id,
    tabs: DEFAULT_TABS.map((spec) => buildTab(spec, makeInstance, knownType)),
  };
}

/**
 * Turn a saved v1 layout into a tabbed board.
 *
 * The rule that matters: **the board you built stays exactly as you built it**,
 * on the first tab, active. The new tabs are appended after it. Anything else —
 * merging, re-sorting, replacing it with a preset — would be the dashboard
 * throwing away work on the strength of an upgrade, which is not a trade the
 * user agreed to.
 */
export function migrate(saved, { makeInstance, knownType }) {
  const kept = (saved?.widgets ?? []).filter((instance) => instance && knownType(instance.type));

  if (kept.length === 0) return seed({ makeInstance, knownType });

  const yours = { id: DEFAULT_TABS[0].id, name: DEFAULT_TABS[0].name, widgets: kept };
  const rest = DEFAULT_TABS.slice(1).map((spec) => buildTab(spec, makeInstance, knownType));

  return { activeTab: yours.id, tabs: [yours, ...rest] };
}

/**
 * Repair a saved board into something renderable.
 *
 * A widget that no longer exists in the catalogue is dropped rather than
 * crashing the board around it; a board with no tabs left, or one pointing at a
 * tab that is gone, is put back on its feet rather than shown as an error. This
 * runs on every load, so it is also the place a hand-edited localStorage entry
 * stops being dangerous.
 */
export function normalise(saved, { makeInstance, knownType }) {
  if (!saved || !Array.isArray(saved.tabs)) return null;

  const tabs = saved.tabs
    .filter((tab) => tab && typeof tab.id === "string" && tab.id)
    .map((tab) => ({
      id: tab.id,
      name: typeof tab.name === "string" && tab.name.trim() ? tab.name : tab.id,
      widgets: Array.isArray(tab.widgets) ? tab.widgets.filter((w) => w && knownType(w.type)) : [],
    }));

  if (tabs.length === 0) return seed({ makeInstance, knownType });

  const activeTab = tabs.some((tab) => tab.id === saved.activeTab) ? saved.activeTab : tabs[0].id;

  return { activeTab, tabs };
}

/**
 * The board to render, from whatever this browser has stored.
 *
 * v1 is read but never deleted. It costs a few kilobytes and it is the only way
 * back if the migration turns out to have been wrong about someone's board.
 */
export function loadBoard(deps) {
  const restored = normalise(boardStorage.load(), deps);
  if (restored) return restored;

  const v1 = layoutStorage.load();
  if (v1 && Array.isArray(v1.widgets) && v1.widgets.length > 0) return migrate(v1, deps);

  return seed(deps);
}

export function saveBoard(board) {
  boardStorage.save(board);
}

// ---------- Tab operations ----------
//
// Pure: each takes a board and returns a new one, so they can be tested without
// a document and reasoned about without wondering who mutated what.

export function activeTab(board) {
  return board.tabs.find((tab) => tab.id === board.activeTab) ?? board.tabs[0];
}

export function withActive(board, id) {
  return board.tabs.some((tab) => tab.id === id) ? { ...board, activeTab: id } : board;
}

export function withWidgets(board, id, widgets) {
  return {
    ...board,
    tabs: board.tabs.map((tab) => (tab.id === id ? { ...tab, widgets } : tab)),
  };
}

export function addTab(board, name) {
  const label = (name ?? "").trim() || "New tab";
  const tab = { id: uniqueId(slugify(label), board.tabs.map((t) => t.id)), name: label, widgets: [] };

  return { activeTab: tab.id, tabs: [...board.tabs, tab] };
}

export function renameTab(board, id, name) {
  const label = (name ?? "").trim();
  if (!label) return board;

  // The id is the deep link and is deliberately left alone: renaming a tab must
  // not silently break a bookmark or the main app's Arbitrage button.
  return { ...board, tabs: board.tabs.map((tab) => (tab.id === id ? { ...tab, name: label } : tab)) };
}

/** Remove a tab. The last one is kept: a board with no tabs has nowhere to go. */
export function removeTab(board, id) {
  if (board.tabs.length <= 1) return board;

  const index = board.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return board;

  const tabs = board.tabs.filter((tab) => tab.id !== id);
  const activeId = board.activeTab === id ? tabs[Math.min(index, tabs.length - 1)].id : board.activeTab;

  return { activeTab: activeId, tabs };
}

/** Which tab holds a widget of this type, if any. Used by the deep links. */
export function tabHolding(board, types) {
  const wanted = new Set(types);

  return board.tabs.find((tab) => tab.widgets.some((widget) => wanted.has(widget.type))) ?? null;
}
