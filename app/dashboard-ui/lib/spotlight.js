/**
 * Point at the thing the AI just touched, and say what it did.
 *
 * A feed tells you what happened. It does not tell you *where* — you still have
 * to find the bot in a table of fourteen and match it up yourself. This rings
 * the row and puts one sentence beside it, so following along costs a glance
 * instead of a search.
 *
 * Three rules keep it from becoming wallpaper:
 *
 *   One at a time. Two bubbles on screen is two things to read at once, which
 *   is none.
 *
 *   Nothing older than thirty seconds. Coming back to a background tab must not
 *   fire forty bubbles at a board you are not looking at any more.
 *
 *   The dwell is derived from the text, not fixed. "Closed BTC/USDT, +$3.40"
 *   and a full sentence do not take the same time to read, and giving them the
 *   same three seconds shortchanges one of them.
 */
import { el } from "./dom.js";

/** Reading speed, in milliseconds per character, and the range it is held to. */
const MS_PER_CHAR = 45;
const MIN_DWELL = 2000;
const MAX_DWELL = 4000;

/** Older than this and the moment has passed; the feed still has the record. */
const STALE_MS = 30_000;

/**
 * How long to hold a bubble, from how much there is to read.
 *
 * The detail carries the meaning, so it sets the pace; the title is short by
 * construction (48 characters, capped at the source) and only nudges it.
 */
export function dwellMs(action) {
  const characters = `${action?.title ?? ""} ${action?.detail ?? ""}`.trim().length;

  return Math.min(MAX_DWELL, Math.max(MIN_DWELL, characters * MS_PER_CHAR));
}

/**
 * Where to point, most specific first.
 *
 * A trade row beats the bot row that contains it, which beats a card for the
 * symbol, which beats the widget the action belongs to. The AI tab is the last
 * resort so that something is always highlighted: an action nobody can see
 * happen is the failure this whole feature exists to fix.
 */
export function selectorsFor(action) {
  const target = action?.target ?? {};
  const selectors = [];

  if (target.smartTradeId !== undefined && target.smartTradeId !== null) {
    selectors.push(`[data-trade-id="${target.smartTradeId}"]`);
  }
  if (target.botId !== undefined && target.botId !== null) selectors.push(`[data-bot-id="${target.botId}"]`);
  if (target.symbol) selectors.push(`[data-symbol="${target.symbol}"]`);
  if (target.widget) selectors.push(`[data-type="${target.widget}"]`);

  selectors.push('[data-tabs] [data-tab="ai"]');

  return selectors;
}

/** The first of those selectors that is actually on screen right now. */
export function resolveTarget(action, root = document) {
  for (const selector of selectorsFor(action)) {
    const node = root.querySelector(selector);
    if (node) return node;
  }

  return null;
}

let bubble = null;
let queue = [];
let showing = false;
let enabled = () => true;

function ensureBubble() {
  if (bubble) return bubble;

  bubble = el("div", { class: "spot", role: "status", "aria-live": "polite", hidden: true });
  document.body.append(bubble);

  return bubble;
}

/**
 * Put the bubble beside its target.
 *
 * Above by preference — a row's own text is below it and covering the next row
 * would hide the very thing being compared — and below when there is no room.
 * Horizontally clamped so a card at the right edge does not push it off screen.
 */
function place(node, box) {
  const rect = node.getBoundingClientRect();
  const margin = 8;
  const above = rect.top - box.height - margin;
  const top = above > 8 ? above : Math.min(window.innerHeight - box.height - 8, rect.bottom + margin);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - box.width - 8);

  bubble.style.top = `${Math.max(8, top)}px`;
  bubble.style.left = `${left}px`;
}

function play(action) {
  const node = resolveTarget(action);
  if (!node) return next();

  const card = ensureBubble();

  card.replaceChildren(
    el("div", { class: "spot__head" }, [
      el("span", { class: "chip", dataset: { chip: action.chip }, text: action.chip.replace(/-/g, " ") }),
      el("span", { class: "spot__title", text: action.title }),
    ]),
    action.detail ? el("div", { class: "spot__detail", text: action.detail }) : null,
  );

  card.dataset.severity = action.severity ?? "info";
  card.hidden = false;
  // Measure after it is in the flow, so the placement uses real dimensions.
  place(node, card.getBoundingClientRect());

  node.classList.add("is-ai-target");
  card.classList.add("spot--in");

  window.setTimeout(() => {
    node.classList.remove("is-ai-target");
    card.classList.remove("spot--in");
    card.hidden = true;
    next();
  }, dwellMs(action));
}

function next() {
  showing = false;

  // Anything that has been waiting too long has stopped being news. Dropped
  // rather than shown late: the feed still holds every one of them.
  const now = Date.now();
  queue = queue.filter((action) => now - action.at <= STALE_MS);

  const action = queue.shift();
  if (!action) return;

  showing = true;
  play(action);
}

/** Queue actions to be pointed at, oldest first. */
export function spotlight(actions) {
  if (!enabled()) return;

  const now = Date.now();
  queue.push(...actions.filter((action) => now - action.at <= STALE_MS));

  if (!showing) next();
}

/**
 * Start listening.
 *
 * `isEnabled` is read on every action rather than once, so turning the setting
 * off takes effect immediately instead of at the next reload.
 */
export function initSpotlight({ subscribe, isEnabled = () => true } = {}) {
  enabled = isEnabled;
  ensureBubble();

  // Clicking a row in the action window asks for that one specifically, whether
  // or not it is recent — an explicit request is never stale.
  document.addEventListener("opentrader:spotlight", (event) => {
    const action = event.detail?.action;
    if (!action) return;

    queue.push({ ...action, at: Date.now() });
    if (!showing) next();
  });

  // A hidden tab queues nothing: everything in it would be stale by the time
  // anyone looked, and the feed is the right place to catch up.
  return subscribe?.((fresh) => {
    if (document.visibilityState !== "visible") return;

    spotlight(fresh);
  });
}
