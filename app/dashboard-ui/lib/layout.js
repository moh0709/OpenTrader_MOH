/**
 * The widget board: placement, drag-to-reorder, resize and persistence.
 *
 * Widgets sit on a 12 column grid. Each instance stores its own span, its own
 * row height and its own config, and the whole board is persisted to
 * localStorage so a reload restores the view you built.
 *
 * Height has two modes. "Auto" lets a widget grow to its content, which suits
 * tables and check lists; "Fixed" pins it to a row count, which keeps a wall of
 * widgets tidy. Either way the container includes its axis labels, so a chart
 * never ends up with a tiny nested scrollbar.
 */
import { el } from "./dom.js";
import { groupSlug } from "./groups.js";
import { layoutStorage, store } from "./store.js";
import { getWidget, widgetCatalog } from "../widgets/index.js";

let gridNode = null;
let instances = [];
let sequence = 1;

const controllers = new Map();

export function initLayout(node) {
  gridNode = node;
  instances = loadLayout();
  renderAll();

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

function loadLayout() {
  const saved = layoutStorage.load();

  if (Array.isArray(saved?.widgets) && saved.widgets.length > 0) {
    const restored = saved.widgets.filter((instance) => getWidget(instance.type));
    sequence = restored.reduce((max, instance) => Math.max(max, Number(instance.uid.split("-")[1])), 0) + 1;

    // A pinned widget must always be present, even in an older saved layout.
    for (const widget of widgetCatalog()) {
      if (widget.pinned && !restored.some((instance) => instance.type === widget.id)) {
        restored.unshift(makeInstance(widget.id));
      }
    }

    return restored;
  }

  return preset("overview");
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

export const PRESETS = {
  overview: ["kpi", "leaderboard", "fleet", "closedTrades", "health"],
  desk: ["kpi", "gridLadder", "openPositions", "closedTrades", "abandoned", "events"],
  analytics: ["kpi", "equity", "winLoss", "pnlDistribution", "holdTime", "heatmap", "fees"],
  ops: ["kpi", "health", "events", "botLogs", "fleet"],
};

export function preset(name) {
  sequence = 1;

  return (PRESETS[name] ?? PRESETS.overview).map((type) => makeInstance(type));
}

export function applyPreset(name) {
  destroyAll();
  instances = preset(name);
  persist();
  renderAll();
}

export function resetLayout() {
  layoutStorage.clear();
  destroyAll();
  instances = preset("overview");
  persist();
  renderAll();
}

function persist() {
  layoutStorage.save({ widgets: instances });
}

export function instanceCount(type) {
  return instances.filter((instance) => instance.type === type).length;
}

export function addWidget(type, config) {
  const widget = getWidget(type);
  if (!widget) return;
  if (widget.singleton && instanceCount(type) > 0) {
    // Already on the board: scroll to it rather than adding a duplicate.
    const existing = instances.find((instance) => instance.type === type);
    focusCards([existing.uid]);
    return;
  }

  const instance = makeInstance(type, config);
  instances.push(instance);
  persist();
  renderAll();

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
 * Put a whole widget group on the board and scroll to it.
 *
 * This is what the "Arbitrage" button in the main app navigates to. The widgets
 * already existed in the catalogue, but reaching them meant opening the Add
 * widget drawer and knowing to look under a group heading — so the button led to
 * a board that showed no arbitrage at all.
 *
 * Missing widgets are added and kept, rather than shown as a temporary view: the
 * board is the user's own layout, and a group they asked for by name belongs on
 * it. Repeat visits add nothing further and just scroll back to it.
 */
export function focusGroup(slug) {
  const wanted = widgetCatalog().filter((widget) => groupSlug(widget.group) === slug);
  if (wanted.length === 0) return false;

  const added = [];

  for (const widget of wanted) {
    if (instanceCount(widget.id) > 0) continue;

    const instance = makeInstance(widget.id);
    instances.push(instance);
    added.push(instance);
  }

  if (added.length > 0) {
    persist();
    renderAll();
  }

  const uids = instances.filter((instance) => wanted.some((w) => w.id === instance.type)).map((i) => i.uid);
  focusCards(uids);

  return true;
}

export function removeWidget(uid) {
  const instance = instances.find((item) => item.uid === uid);
  if (!instance || getWidget(instance.type)?.pinned) return;

  destroy(uid);
  instances = instances.filter((item) => item.uid !== uid);
  persist();
  renderAll();
}

export function updateConfig(uid, patch) {
  const instance = instances.find((item) => item.uid === uid);
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

  for (const instance of instances) gridNode.append(buildCard(instance));

  document.querySelector("[data-empty]")?.toggleAttribute("hidden", instances.length > 0);
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

    const from = instances.findIndex((item) => item.uid === dragUid);
    const to = instances.findIndex((item) => item.uid === instance.uid);
    if (from < 0 || to < 0) return;

    const [moved] = instances.splice(from, 1);
    instances.splice(to, 0, moved);
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
  return instances;
}
