/**
 * The widget board: tabs, placement, drag-to-reorder, resize and persistence.
 *
 * Widgets sit on a 12 column grid. Each instance stores its own span, its own
 * row height and its own config, and the whole board is persisted to
 * localStorage so a reload restores the view you built.
 *
 * The board is divided into tabs, and **only the active tab is built**. That is
 * not just tidiness: every chart sizes itself to its container and redraws on
 * each refresh, so a single grid holding thirty widgets paid for all thirty
 * every five seconds to show you the six you were looking at. Switching tabs
 * disposes the old controllers and builds the new ones, which is why a tab you
 * are not on costs nothing at all.
 *
 * Height has two modes. "Auto" lets a widget grow to its content, which suits
 * tables and check lists; "Fixed" pins it to a row count, which keeps a wall of
 * widgets tidy. Either way the container includes its axis labels, so a chart
 * never ends up with a tiny nested scrollbar.
 */
import { el } from "./dom.js";
import { groupSlug } from "./groups.js";
import {
  PRESETS,
  activeTab,
  addTab,
  loadBoard,
  removeTab,
  renameTab,
  saveBoard,
  seed,
  tabHolding,
  withActive,
  withWidgets,
} from "./board.js";
import { boardStorage, store } from "./store.js";
import { getWidget, widgetCatalog } from "../widgets/index.js";

export { PRESETS };

let gridNode = null;
let board = { activeTab: null, tabs: [] };
let sequence = 1;

const controllers = new Map();
/** Notified whenever the set of tabs, or which one is active, changes. */
const boardListeners = new Set();

/** The dependencies board.js needs but deliberately does not import. */
const deps = {
  makeInstance: (type, config) => makeInstance(type, config),
  knownType: (type) => Boolean(getWidget(type)),
};

export function initLayout(node) {
  gridNode = node;
  board = loadBoard(deps);
  reseed();
  renderAll();
  announce();

  // Widget headers are built once, and several of them fill a bot dropdown from
  // the snapshot. On a cold load that snapshot has not arrived yet, leaving the
  // dropdowns empty, so rebuild the board the first time data lands.
  let seeded = false;
  const unsubscribe = store.subscribe((reason) => {
    if (seeded || reason !== "snapshot" || !store.data.snapshot) return;

    seeded = true;
    unsubscribe();
    renderAll();
  });
}

/**
 * Continue the uid sequence past everything already on the board.
 *
 * Uids are DOM selectors, and they have to be unique across every tab, not just
 * the visible one — a widget added on the AI tab must not collide with one that
 * has been sitting on Analytics since last week.
 */
function reseed() {
  const uids = board.tabs.flatMap((tab) => tab.widgets.map((widget) => Number(String(widget.uid).split("-")[1])));
  const highest = uids.reduce((max, value) => (Number.isFinite(value) ? Math.max(max, value) : max), 0);

  sequence = highest + 1;
}

function makeInstance(type, config = {}) {
  const widget = getWidget(type);

  return {
    uid: `w-${sequence++}`,
    type,
    span: widget.defaultSpan ?? 4,
    rows: widget.defaultRows ?? 2,
    config: { ...widget.defaultConfig, ...config },
  };
}

// ---------- Tabs ----------

export function onBoardChange(listener) {
  boardListeners.add(listener);

  return () => boardListeners.delete(listener);
}

function announce() {
  for (const listener of boardListeners) {
    try {
      listener(board);
    } catch (error) {
      console.error("[analytics] board listener failed", error);
    }
  }
}

export function boardTabs() {
  return board.tabs.map((tab) => ({ id: tab.id, name: tab.name, count: tab.widgets.length }));
}

/**
 * The id of the tab holding any of these widget types, or null.
 *
 * Only the active tab is built, so a widget that is not on screen cannot report
 * anything about itself. This is how the page finds the right tab to mark when
 * something arrives for a widget nobody is currently looking at.
 */
export function tabIdHolding(types) {
  return tabHolding(board, types)?.id ?? null;
}

export function activeTabId() {
  return activeTab(board)?.id ?? null;
}

/** Switch tabs. A no-op when already there, so a repeated click costs nothing. */
export function selectTab(id) {
  if (id === board.activeTab || !board.tabs.some((tab) => tab.id === id)) return false;

  board = withActive(board, id);
  persist();
  renderAll();
  announce();

  return true;
}

export function createTab(name) {
  board = addTab(board, name);
  persist();
  renderAll();
  announce();

  return board.activeTab;
}

export function retitleTab(id, name) {
  board = renameTab(board, id, name);
  persist();
  announce();
}

export function dropTab(id) {
  const before = board.tabs.length;
  board = removeTab(board, id);
  if (board.tabs.length === before) return false;

  persist();
  renderAll();
  announce();

  return true;
}

// ---------- Widgets on the active tab ----------

function instances() {
  return activeTab(board)?.widgets ?? [];
}

function setInstances(widgets) {
  board = withWidgets(board, board.activeTab, widgets);
}

function persist() {
  saveBoard(board);
}

export function instanceCount(type) {
  return instances().filter((instance) => instance.type === type).length;
}

export function applyPreset(name) {
  destroyAll();
  setInstances((PRESETS[name] ?? PRESETS.overview).filter(deps.knownType).map((type) => makeInstance(type)));
  persist();
  renderAll();
  announce();
}

/** Put every tab back to its default contents, discarding the saved board. */
export function resetLayout() {
  boardStorage.clear();
  destroyAll();
  board = seed(deps);
  persist();
  renderAll();
  announce();
}

export function addWidget(type, config) {
  const widget = getWidget(type);
  if (!widget) return;

  if (widget.singleton && instanceCount(type) > 0) {
    // Already on this tab: scroll to it rather than adding a duplicate.
    const existing = instances().find((instance) => instance.type === type);
    focusCards([existing.uid]);
    return;
  }

  const instance = makeInstance(type, config);
  setInstances([...instances(), instance]);
  persist();
  renderAll();
  announce();

  focusCards([instance.uid]);
}

// ---------- Focus ----------

const FOCUS_MS = 2000;

/**
 * Which cards are currently ringed, and until when.
 *
 * Held here rather than only on the elements because the board rebuilds itself
 * when the first snapshot arrives, which is normally about a second after a cold
 * load - precisely the path a deep link takes. Without this the ring would be
 * thrown away almost as soon as it appeared.
 */
let focused = { uids: [], until: 0 };

function ring(card) {
  card.classList.remove("widget--focus");
  // Restart the animation rather than let a second click land on a class the
  // element already carries, which would play nothing.
  void card.offsetWidth;
  card.classList.add("widget--focus");
}

/** Re-apply a still-live ring to freshly built cards. Does not scroll again. */
function restoreFocus() {
  if (Date.now() >= focused.until) return;

  for (const uid of focused.uids) {
    const card = gridNode?.querySelector(`[data-uid="${uid}"]`);
    if (card) ring(card);
  }
}

/**
 * Scroll a set of cards into view and mark them briefly.
 *
 * The mark matters when the widgets were already on the board: without it a
 * scroll to a board that is mostly one shade of grey gives no confirmation that
 * anything happened, which reads as a dead link.
 */
function focusCards(uids) {
  const cards = uids.map((uid) => gridNode?.querySelector(`[data-uid="${uid}"]`)).filter(Boolean);
  if (cards.length === 0) return;

  focused = { uids: [...uids], until: Date.now() + FOCUS_MS };

  cards[0].scrollIntoView({ behavior: "smooth", block: "center" });
  for (const card of cards) ring(card);

  window.setTimeout(() => {
    focused = { uids: [], until: 0 };
    for (const uid of uids) gridNode?.querySelector(`[data-uid="${uid}"]`)?.classList.remove("widget--focus");
  }, FOCUS_MS);
}

/**
 * Bring a whole widget group into view.
 *
 * This is what the "Arbitrage" button in the main app navigates to, as a link to
 * /analytics/#arbitrage. Before tabs it added the group's widgets to whatever
 * board happened to be open; now it first looks for a tab that already holds
 * them, because that tab is where they belong and switching to it leaves the
 * user's own boards untouched.
 *
 * Only when no tab owns the group does it fall back to the old behaviour of
 * placing the widgets on the current tab and keeping them — a group asked for by
 * name should still end up somewhere.
 */
export function focusGroup(slug) {
  const wanted = widgetCatalog().filter((widget) => groupSlug(widget.group) === slug);
  if (wanted.length === 0) return false;

  const home = tabHolding(board, wanted.map((widget) => widget.id));
  if (home) {
    selectTab(home.id);
    focusCards(home.widgets.filter((w) => wanted.some((x) => x.id === w.type)).map((w) => w.uid));

    return true;
  }

  const added = [];

  for (const widget of wanted) {
    if (instanceCount(widget.id) > 0) continue;

    const instance = makeInstance(widget.id);
    added.push(instance);
  }

  if (added.length > 0) {
    setInstances([...instances(), ...added]);
    persist();
    renderAll();
    announce();
  }

  const uids = instances().filter((instance) => wanted.some((w) => w.id === instance.type)).map((i) => i.uid);
  focusCards(uids);

  return true;
}

/**
 * Switch to the tab with this id. Used by the hash router.
 *
 * Reports whether the tab *exists*, not whether it switched — being asked for
 * the tab you are already on is a handled request, and returning false would
 * send the caller on to try the fragment as a widget group instead, which for
 * "ai" or "arbitrage" would then place a second copy of those widgets on the
 * tab that already holds them.
 */
export function focusTab(slug) {
  if (!board.tabs.some((tab) => tab.id === slug)) return false;

  selectTab(slug);

  return true;
}

export function removeWidget(uid) {
  const instance = instances().find((item) => item.uid === uid);
  if (!instance || getWidget(instance.type)?.pinned) return;

  destroy(uid);
  setInstances(instances().filter((item) => item.uid !== uid));
  persist();
  renderAll();
  announce();
}

export function updateConfig(uid, patch) {
  const instance = instances().find((item) => item.uid === uid);
  if (!instance) return;

  instance.config = { ...instance.config, ...patch };
  persist();
  renderOne(instance);
}

function destroy(uid) {
  const controller = controllers.get(uid);
  if (controller) {
    controller.dispose?.();
    controllers.delete(uid);
  }
}

function destroyAll() {
  for (const uid of Array.from(controllers.keys())) destroy(uid);
}

function renderAll() {
  if (!gridNode) return;

  destroyAll();
  gridNode.replaceChildren();

  for (const instance of instances()) gridNode.append(buildCard(instance));

  document.querySelector("[data-empty]")?.toggleAttribute("hidden", instances().length > 0);
  restoreFocus();
}

function renderOne(instance) {
  const card = gridNode?.querySelector(`[data-uid="${instance.uid}"]`);
  if (!card) return;

  destroy(instance.uid);
  card.replaceWith(buildCard(instance));
}

function buildCard(instance) {
  const widget = getWidget(instance.type);
  const body = el("div", { class: "widget__body" });
  const meta = el("span", { class: "widget__meta" });

  const card = el("article", {
    class: "widget",
    dataset: { uid: instance.uid, type: instance.type, height: store.settings.widgetHeight },
    style: { "--w": String(instance.span), "--h": String(instance.rows) },
  });

  const head = el("header", { class: "widget__head", draggable: "true" }, [
    el("span", { class: "widget__title", text: widget.name }),
    meta,
    el("div", { class: "widget__tools" }, [
      ...(widget.tools?.(instance, api(instance, body, meta)) ?? []),
      widget.pinned
        ? null
        : el("button", {
            class: "widget__tool",
            type: "button",
            title: "Remove widget",
            "aria-label": `Remove ${widget.name}`,
            text: "✕",
            onclick: () => removeWidget(instance.uid),
          }),
    ]),
  ]);

  card.append(head, body);
  if (!widget.pinned) card.append(el("div", { class: "widget__resize", title: "Drag to resize" }));

  attachDrag(card, head, instance);
  attachResize(card, instance);

  const controller = widget.render(api(instance, body, meta));
  if (controller) controllers.set(instance.uid, controller);

  return card;
}

/** The surface a widget is handed: where to draw, and how to talk to the board. */
function api(instance, body, meta) {
  return {
    instance,
    config: instance.config,
    body,
    /** Secondary text in the widget header, e.g. a row count or a timestamp. */
    setMeta: (text) => {
      meta.textContent = text ?? "";
    },
    setConfig: (patch) => updateConfig(instance.uid, patch),
    store,
  };
}

// ---------- Drag to reorder ----------

let dragUid = null;

function attachDrag(card, handle, instance) {
  handle.addEventListener("dragstart", (event) => {
    dragUid = instance.uid;
    card.classList.add("widget--dragging");
    event.dataTransfer.effectAllowed = "move";
    // Firefox needs some payload for a drag to start at all.
    event.dataTransfer.setData("text/plain", instance.uid);
  });

  handle.addEventListener("dragend", () => {
    dragUid = null;
    card.classList.remove("widget--dragging");
    gridNode?.querySelectorAll(".widget--drop-target").forEach((node) => node.classList.remove("widget--drop-target"));
  });

  card.addEventListener("dragover", (event) => {
    if (!dragUid || dragUid === instance.uid) return;

    event.preventDefault();
    card.classList.add("widget--drop-target");
  });

  card.addEventListener("dragleave", () => card.classList.remove("widget--drop-target"));

  card.addEventListener("drop", (event) => {
    event.preventDefault();
    card.classList.remove("widget--drop-target");
    if (!dragUid || dragUid === instance.uid) return;

    const current = [...instances()];
    const from = current.findIndex((item) => item.uid === dragUid);
    const to = current.findIndex((item) => item.uid === instance.uid);
    if (from < 0 || to < 0) return;

    const [moved] = current.splice(from, 1);
    current.splice(to, 0, moved);
    setInstances(current);
    persist();
    renderAll();
  });
}

// ---------- Resize ----------

function attachResize(card, instance) {
  const handle = card.querySelector(".widget__resize");
  if (!handle) return;

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startY = event.clientY;
    const startSpan = instance.span;
    const startRows = instance.rows;
    const columnWidth = (gridNode.clientWidth - 11 * 14) / 12;

    const onMove = (moveEvent) => {
      // Snap to whole columns, so widgets always line up with their neighbours.
      const span = clamp(startSpan + Math.round((moveEvent.clientX - startX) / columnWidth), 3, 12);
      const rows = clamp(startRows + Math.round((moveEvent.clientY - startY) / 132), 1, 8);

      if (span !== instance.span || rows !== instance.rows) {
        instance.span = span;
        instance.rows = rows;
        card.style.setProperty("--w", String(span));
        card.style.setProperty("--h", String(rows));
      }
    };

    const onUp = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      persist();
      // Charts size to their container, so a resize needs a redraw.
      renderOne(instance);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Re-apply the auto/fixed height mode to every card without rebuilding them. */
export function applyHeightMode() {
  gridNode?.querySelectorAll(".widget").forEach((card) => {
    card.dataset.height = store.settings.widgetHeight;
  });
}

export function listInstances() {
  return instances();
}
