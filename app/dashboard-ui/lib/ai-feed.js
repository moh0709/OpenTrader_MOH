/**
 * The AI action stream, polled once and shared.
 *
 * Three things on this page want to know what the AI just did: the action
 * window on the AI tab, the highlight bubbles on the board, and the AI News
 * lane in the bottom bar. Each polling separately would triple the request rate
 * and let the three of them disagree about what had happened, so they all read
 * from here — the same arrangement the trade ticker and the watcher list
 * already use in `app.js`.
 *
 * The cursor is a sequence number, not a timestamp: the daemon records a
 * council verdict and the order it placed in the same millisecond, and a
 * timestamp cursor would silently drop the second one. The session id catches
 * the other half of that problem — sequence numbers restart at zero when the
 * daemon restarts, so a cursor from the previous run would otherwise wait
 * forever for a number that will never come again.
 */
import { getPassword } from "./api.js";
import { store } from "./store.js";

/**
 * How often to ask, when the dashboard is refreshing at all.
 *
 * Fast enough to feel live, and never faster than the board's own refresh — a
 * feed that keeps polling while the operator has paused the dashboard is both
 * surprising and, on a daemon that is also running the trading loop, rude.
 */
const POLL_MS = 3000;

function interval() {
  const refresh = store.settings.refreshMs;

  return refresh === 0 ? 0 : Math.max(POLL_MS, refresh);
}

/** How much history to keep in the browser. The daemon keeps 500. */
const BUFFER_MAX = 300;

let cursor = 0;
let session = null;
let buffer = [];
let timer = null;
let started = false;
/** null while unknown, then true/false once the settings have been read. */
let configured = null;

const listeners = new Set();

async function dash(path) {
  const response = await fetch(`/api/dash/${path}`, { headers: { authorization: getPassword() ?? "" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  return response.json();
}

/**
 * Whether an AI provider is configured at all.
 *
 * Worth knowing separately from "has it done anything", because the two need
 * opposite responses: an empty feed with no provider is a setup step, an empty
 * feed with a provider is simply a quiet morning.
 */
export function isConfigured() {
  return configured;
}

/** Everything held, newest first — which is the order all three consumers show. */
export function actions() {
  return buffer;
}

/**
 * Listen for new actions.
 *
 * The callback is handed the new ones **oldest first**, because a consumer that
 * animates them (the bubble queue) has to play them in the order they happened.
 * Use `actions()` for the display order.
 */
export function subscribe(listener) {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

function emit(fresh) {
  for (const listener of listeners) {
    try {
      listener(fresh, buffer);
    } catch (error) {
      console.error("[analytics] AI feed listener failed", error);
    }
  }
}

async function poll() {
  if (document.visibilityState !== "visible") return;

  try {
    const query = new URLSearchParams({ since: String(cursor) });
    if (session) query.set("session", session);

    const payload = await dash(`ai/actions?${query}`);

    // The daemon restarted: its buffer is a different buffer, and it has already
    // replayed from the top. Ours must be replaced rather than appended to, or
    // every action would appear twice.
    if (payload.restarted || (session && payload.session !== session)) buffer = [];

    session = payload.session ?? session;
    cursor = payload.cursor ?? cursor;

    const fresh = payload.actions ?? [];
    if (fresh.length === 0) return;

    buffer = [...[...fresh].reverse(), ...buffer].slice(0, BUFFER_MAX);
    emit(fresh);
  } catch {
    // Keep the last good set. A cleared feed on one failed poll would read as
    // "the AI has done nothing", which is a different and misleading claim.
  }
}

/** (Re)arm the timer at whatever cadence the refresh setting currently implies. */
function schedule() {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }

  const every = interval();
  if (every === 0) return;

  timer = window.setInterval(() => void poll(), every);
}

/** Start polling. Safe to call more than once. */
export function startAiFeed() {
  if (started) return;
  started = true;

  void dash("ai-settings")
    .then((payload) => {
      configured = Boolean(payload.saved && payload.saved.provider && payload.saved.provider !== "none");
    })
    .catch(() => {
      configured = null;
    });

  void poll();
  schedule();

  // Pausing the dashboard pauses this too, and changing the interval moves it.
  store.subscribe((reason) => {
    if (reason === "settings") schedule();
  });

  // A hidden tab should not poll; catch up in one request on return rather than
  // replaying every tick that was missed.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void poll();
  });
}

export function stopAiFeed() {
  if (timer === null) return;

  window.clearInterval(timer);
  timer = null;
}

/** Test seam, and the path a sign-out takes: forget everything and start over. */
export function resetAiFeed() {
  cursor = 0;
  session = null;
  buffer = [];
  configured = null;
}
