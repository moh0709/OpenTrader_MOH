/**
 * The refresh loop.
 *
 * One tick fetches the snapshot and the event delta in a single batched request
 * and publishes them to the store; every widget renders from that. Twelve
 * widgets on screen still cost one round trip.
 *
 * Health is checked on a slower cadence than the snapshot, because it reads
 * process and filesystem statistics that do not change every five seconds.
 *
 * Polling stops while the tab is hidden and fires immediately on return, so a
 * dashboard left open in a background tab is not quietly hammering the daemon.
 */
import { UnauthorizedError, batch } from "./api.js";
import { cursorStorage, store } from "./store.js";

const HEALTH_EVERY_MS = 15_000;

let timer = null;
let inFlight = false;
let lastHealthAt = 0;
let eventCursor = cursorStorage.load();
let onEvents = () => {};
let onUnauthorized = () => {};

export function initPoller({ onEvents: eventsHandler, onUnauthorized: unauthorizedHandler }) {
  onEvents = eventsHandler ?? onEvents;
  onUnauthorized = unauthorizedHandler ?? onUnauthorized;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      schedule();
      void tick();
    } else {
      stop();
    }
  });

  schedule();
  void tick();
}

export function schedule() {
  stop();

  const interval = store.settings.refreshMs;
  if (!interval || document.visibilityState !== "visible") return;

  timer = window.setInterval(() => void tick(), interval);
}

export function stop() {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

export async function tick({ force = false } = {}) {
  if (inFlight) return;
  if (!force && document.visibilityState !== "visible") return;

  inFlight = true;
  store.setLoading(true);

  const wantHealth = force || Date.now() - lastHealthAt > HEALTH_EVERY_MS;

  const calls = [
    { path: "dashboard.snapshot", input: { metric: store.settings.leaderboardMetric } },
    { path: "dashboard.events", input: { since: eventCursor, limit: 30 } },
    // The bottom ticker used to poll this on a timer of its own, at the same
    // five seconds, which cost a second round trip to the same daemon that also
    // runs the trading loop. tRPC batches several procedures into one request,
    // so riding along here is free.
    //
    // No `state`: the filter is an enum of live/abandoned/missing, and leaving
    // it off is what means "all three", which is what the bar shows.
    { path: "dashboard.positions", input: { includePending: false } },
  ];
  if (wantHealth) calls.push({ path: "dashboard.health", input: {} });

  try {
    const [snapshot, events, positions, health] = await batch(calls);

    if (snapshot instanceof Error) store.setError(snapshot.message);
    else if (snapshot) store.setSnapshot(snapshot);

    // Keep the last good set on a failed poll: a blank bar would read as "no
    // open trades", which is a different and more alarming claim than "we could
    // not check just now".
    if (positions && !(positions instanceof Error)) store.setPositions(positions);

    if (events && !(events instanceof Error)) {
      // A cursor of 0 only initialises: the server returns no events, so a first
      // load never replays the whole history as a burst of toasts.
      const isFirstSync = eventCursor === 0;
      eventCursor = events.cursor ?? eventCursor;
      cursorStorage.save(eventCursor);

      if (!isFirstSync && events.events?.length) onEvents(events.events);
    }

    if (health && !(health instanceof Error)) {
      store.setHealth(health);
      lastHealthAt = Date.now();
    }
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      stop();
      onUnauthorized();
    } else {
      store.setError(error.message);
    }
  } finally {
    inFlight = false;
    store.setLoading(false);
  }
}

/** Re-initialise the cursor, e.g. after logging in as a different user. */
export function resetCursor() {
  eventCursor = 0;
  cursorStorage.save(0);
}
