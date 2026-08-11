/**
 * Shared state and persisted settings.
 *
 * One store feeds every widget. A refresh tick fetches the snapshot once and
 * publishes it here, so twelve widgets on screen still cost one request rather
 * than twelve.
 */
const SETTINGS_KEY = "otAnalytics.settings.v1";
const LAYOUT_KEY = "otAnalytics.layout.v1";
const CURSOR_KEY = "otAnalytics.eventCursor.v1";

export const DEFAULT_SETTINGS = {
  refreshMs: 5000,
  theme: "system",
  toastsEnabled: true,
  toastSound: false,
  /** Toast only on closed deals, or on every event type. */
  toastScope: "trades",
  /** Bot start/stop buttons. Off by default: the dashboard observes. */
  controlsEnabled: false,
  /** Hide bots whose trades are dust, e.g. a test bot with 1e-7 quantities. */
  hideDustBots: false,
  dustThreshold: 1,
  leaderboardMetric: "netPnl",
  widgetHeight: "auto",
};

function read(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;

    const parsed = JSON.parse(raw);

    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or blocked localStorage must not break the dashboard.
  }
}

class Store {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}) };
    this.data = {
      snapshot: null,
      health: null,
      /** Recipients currently watching a shared live feed. */
      watchers: [],
      /** Per-widget slices keyed by widget instance id. */
      slices: new Map(),
    };
    this.status = { lastUpdated: null, loading: false, error: null };
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  emit(reason) {
    for (const listener of this.listeners) {
      try {
        listener(reason);
      } catch (error) {
        console.error("[analytics] listener failed", error);
      }
    }
  }

  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    write(SETTINGS_KEY, this.settings);
    this.emit("settings");
  }

  setSnapshot(snapshot) {
    this.data.snapshot = snapshot;
    this.status.lastUpdated = Date.now();
    this.status.error = null;
    this.emit("snapshot");
  }

  setHealth(health) {
    this.data.health = health;
    this.emit("health");
  }

  setSlice(widgetId, value) {
    this.data.slices.set(widgetId, value);
    this.emit(`slice:${widgetId}`);
  }

  getSlice(widgetId) {
    return this.data.slices.get(widgetId);
  }

  setError(error) {
    this.status.error = error;
    this.emit("error");
  }

  setLoading(loading) {
    this.status.loading = loading;
    this.emit("loading");
  }

  /**
   * Bots after the dust filter.
   *
   * A test bot trading 1e-7 of an asset distorts every fleet average, so it can
   * be filtered out by the value it has ever put to work.
   */
  visibleBots() {
    const bots = this.data.snapshot?.bots ?? [];
    if (!this.settings.hideDustBots) return bots;

    const threshold = this.settings.dustThreshold;

    return bots.filter(
      (bot) => bot.realized.volume >= threshold || bot.positions.costBasis >= threshold || bot.realized.trades === 0,
    );
  }

  visibleBotIds() {
    return new Set(this.visibleBots().map((bot) => bot.botId));
  }

  botName(botId) {
    return this.data.snapshot?.bots?.find((bot) => bot.botId === botId)?.name ?? `Bot ${botId}`;
  }

  botSymbol(botId) {
    return this.data.snapshot?.bots?.find((bot) => bot.botId === botId)?.symbol ?? "";
  }
}

export const store = new Store();

export const layoutStorage = {
  load: () => read(LAYOUT_KEY, null),
  save: (layout) => write(LAYOUT_KEY, layout),
  clear: () => window.localStorage.removeItem(LAYOUT_KEY),
};

export const cursorStorage = {
  load: () => {
    const value = Number(window.localStorage.getItem(CURSOR_KEY));

    return Number.isFinite(value) && value > 0 ? value : 0;
  },
  save: (cursor) => window.localStorage.setItem(CURSOR_KEY, String(cursor)),
};
