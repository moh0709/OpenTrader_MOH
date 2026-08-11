/**
 * Dashboard bootstrap: login, chrome, drawers and the refresh loop.
 *
 * The dashboard shares the admin password the main OpenTrader UI already stores,
 * so there is no second account and no second session to manage. If nothing is
 * stored, the login card here writes it rather than bouncing you to the other
 * interface and back.
 */
import { clearPassword, getPassword, setPassword, verifyPassword } from "./lib/api.js";
import { store } from "./lib/store.js";
import { initToasts, toast, toastForEvent } from "./lib/toast.js";
import { initPoller, resetCursor, schedule, tick } from "./lib/poller.js";
import { PRESETS, addWidget, applyHeightMode, applyPreset, initLayout, instanceCount, resetLayout } from "./lib/layout.js";
import { groupedCatalog } from "./widgets/index.js";
import { el, mount } from "./lib/dom.js";
import { money, timeAgo } from "./lib/format.js";
import { fetchWatchers, renderShareManager, shareToken, startLiveFeed } from "./lib/share.js";

const app = document.getElementById("app");
const login = document.getElementById("login");

// ---------- Theme ----------

function applyTheme() {
  const theme = store.settings.theme;

  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const effective = current ?? (prefersDark ? "dark" : "light");

  store.updateSettings({ theme: effective === "dark" ? "light" : "dark" });
  applyTheme();
}

// ---------- Login ----------

function showLogin(message) {
  login.hidden = false;
  app.hidden = true;

  const error = login.querySelector("[data-login-error]");
  error.hidden = !message;
  error.textContent = message ?? "";
}

function showApp() {
  login.hidden = true;
  app.hidden = false;
}

login.querySelector("[data-login-form]").addEventListener("submit", async (event) => {
  event.preventDefault();

  const input = event.target.elements.password;
  const password = input.value.trim();
  if (!password) return;

  const button = event.target.querySelector("button");
  button.disabled = true;
  button.textContent = "Checking…";

  if (await verifyPassword(password)) {
    setPassword(password);
    resetCursor();
    start();
  } else {
    showLogin("That password was not accepted.");
    input.select();
  }

  button.disabled = false;
  button.textContent = "Unlock";
});

// ---------- Chrome ----------

function bindChrome() {
  const refreshSelect = document.querySelector("[data-refresh-select]");
  refreshSelect.value = String(store.settings.refreshMs);
  refreshSelect.addEventListener("change", () => {
    store.updateSettings({ refreshMs: Number(refreshSelect.value) });
    schedule();
  });

  document.querySelector("[data-refresh-now]").addEventListener("click", () => void tick({ force: true }));
  document.querySelector("[data-toggle-theme]").addEventListener("click", toggleTheme);
  document.querySelector("[data-open-catalog]").addEventListener("click", () => openDrawer("catalog"));
  document.querySelector("[data-open-share]")?.addEventListener("click", () => openDrawer("share"));
  document.querySelector("[data-open-settings]").addEventListener("click", () => openDrawer("settings"));
  document.querySelector("[data-health-pill]").addEventListener("click", () => addWidget("health"));

  for (const node of document.querySelectorAll("[data-catalog-close]")) {
    node.addEventListener("click", () => closeDrawer("catalog"));
  }
  for (const node of document.querySelectorAll("[data-settings-close]")) {
    node.addEventListener("click", () => closeDrawer("settings"));
  }
  for (const node of document.querySelectorAll("[data-share-close]")) {
    node.addEventListener("click", () => closeDrawer("share"));
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDrawer("catalog");
      closeDrawer("settings");
      closeDrawer("share");
    }
  });
}

function openDrawer(which) {
  const node = document.querySelector(`[data-${which}]`);
  if (which === "catalog") renderCatalog();
  if (which === "settings") renderSettings();
  if (which === "share") renderShareManager(document.querySelector("[data-share-body]"));
  node.hidden = false;
}

function closeDrawer(which) {
  document.querySelector(`[data-${which}]`).hidden = true;
}

/** Header figures: the one number the dashboard leads with, plus health. */
function renderHeader() {
  const snapshot = store.data.snapshot;
  const heroValue = document.querySelector("[data-hero-pnl]");
  const heroMeta = document.querySelector("[data-hero-meta]");

  if (snapshot) {
    const { realized, positions } = snapshot.fleet;
    const total = positions.floatingPnl === null ? realized.netPnl : realized.netPnl + positions.floatingPnl;

    heroValue.textContent = money(total, { signed: true });
    heroValue.className = `topbar__hero-value ${total > 0 ? "pos" : total < 0 ? "neg" : ""}`.trim();
    heroMeta.textContent =
      positions.floatingPnl === null
        ? `${money(realized.netPnl, { signed: true })} realised`
        : `${money(realized.netPnl, { signed: true })} realised, ${money(positions.floatingPnl, { signed: true })} floating`;
  }

  const health = store.data.health;
  const pill = document.querySelector("[data-health-pill]");
  const pillText = document.querySelector("[data-health-pill-text]");

  if (health) {
    pill.dataset.status = health.status;
    pillText.textContent =
      health.status === "ok"
        ? "All checks passing"
        : health.status === "crit"
          ? `${health.counts.crit} critical`
          : health.status === "warn"
            ? `${health.counts.warn} warning${health.counts.warn === 1 ? "" : "s"}`
            : "Health unknown";
  }

  const banner = document.querySelector("[data-banner]");
  if (store.status.error) {
    banner.hidden = false;
    banner.textContent = `Last refresh failed: ${store.status.error}`;
  } else {
    banner.hidden = true;
  }
}

function renderRefreshStatus() {
  const node = document.querySelector("[data-refresh-status]");
  if (!node) return;

  if (store.status.loading) {
    node.textContent = "updating…";
  } else if (store.status.lastUpdated) {
    node.textContent = timeAgo(store.status.lastUpdated);
  } else {
    node.textContent = "—";
  }

  // Widgets dim while a refresh is in flight rather than flashing a skeleton.
  document.querySelectorAll(".widget").forEach((card) => card.classList.toggle("widget--stale", store.status.loading));
}

// ---------- Catalog drawer ----------

function renderCatalog() {
  const body = document.querySelector("[data-catalog-body]");
  const nodes = [];

  for (const [group, widgets] of groupedCatalog()) {
    nodes.push(el("div", { class: "catalog__group", text: group }));

    for (const widget of widgets) {
      const used = instanceCount(widget.id);

      nodes.push(
        el(
          "button",
          {
            class: "catalog__item",
            type: "button",
            dataset: { active: String(used > 0) },
            onclick: () => {
              addWidget(widget.id);
              renderCatalog();
            },
          },
          [
            el("div", { style: { flex: "1" } }, [
              el("div", { class: "catalog__name", text: widget.name }),
              el("div", { class: "catalog__desc", text: widget.description }),
            ]),
            used > 0 ? el("span", { class: "catalog__count", text: widget.singleton ? "on board" : `${used} on board` }) : null,
          ],
        ),
      );
    }
  }

  mount(body, ...nodes);
}

// ---------- Settings drawer ----------

function renderSettings() {
  const body = document.querySelector("[data-settings-body]");
  const s = store.settings;

  const checkbox = (label, key, hint) =>
    el("div", { class: "field" }, [
      el("label", { class: "switch" }, [
        el("input", {
          type: "checkbox",
          checked: s[key],
          onchange: (event) => {
            store.updateSettings({ [key]: event.target.checked });
            renderSettings();
          },
        }),
        el("span", { class: "field__label", style: { marginBottom: "0" }, text: label }),
      ]),
      hint ? el("div", { class: "field__hint", text: hint }) : null,
    ]);

  const dropdown = (label, key, options, hint, onChange) =>
    el("div", { class: "field" }, [
      el("label", { class: "field__label", text: label }),
      el(
        "select",
        {
          class: "select",
          onchange: (event) => {
            const raw = event.target.value;
            const value = /^\d+$/.test(raw) ? Number(raw) : raw;
            store.updateSettings({ [key]: value });
            onChange?.();
          },
        },
        options.map((option) =>
          el("option", { value: option.value, text: option.label, selected: String(s[key]) === String(option.value) }),
        ),
      ),
      hint ? el("div", { class: "field__hint", text: hint }) : null,
    ]);

  mount(
    body,
    el("div", { class: "section-title", text: "Refresh" }),
    dropdown(
      "Refresh interval",
      "refreshMs",
      [
        { value: 0, label: "Paused" },
        { value: 1000, label: "Every second" },
        { value: 2000, label: "Every 2 seconds" },
        { value: 5000, label: "Every 5 seconds" },
        { value: 10000, label: "Every 10 seconds" },
        { value: 30000, label: "Every 30 seconds" },
        { value: 60000, label: "Every minute" },
      ],
      "Polling pauses while this tab is hidden and resumes when you come back.",
      () => {
        document.querySelector("[data-refresh-select]").value = String(store.settings.refreshMs);
        schedule();
      },
    ),

    el("div", { class: "section-title", text: "Notifications" }),
    checkbox("Show toasts", "toastsEnabled"),
    dropdown(
      "Toast on",
      "toastScope",
      [
        { value: "trades", label: "Closed deals only" },
        { value: "important", label: "Closed deals, errors and agent actions" },
        { value: "all", label: "Everything" },
      ],
      "A closed deal toast shows whether it won or lost, the amount and the percent.",
    ),
    checkbox("Play a sound", "toastSound"),

    el("div", { class: "section-title", text: "Board" }),
    dropdown(
      "Widget height",
      "widgetHeight",
      [
        { value: "auto", label: "Automatic - grow to content" },
        { value: "fixed", label: "Fixed - use the resize handle" },
      ],
      "Drag the corner of any widget to change its width, and its height in fixed mode.",
      applyHeightMode,
    ),
    el("div", { class: "field" }, [
      el("label", { class: "field__label", text: "Load a preset" }),
      el(
        "div",
        { class: "field__row" },
        Object.keys(PRESETS).map((name) =>
          el("button", {
            class: "btn btn--sm",
            type: "button",
            text: name[0].toUpperCase() + name.slice(1),
            onclick: () => {
              if (window.confirm(`Replace the current board with the ${name} preset?`)) applyPreset(name);
            },
          }),
        ),
      ),
      el("div", { class: "field__hint", text: "Replaces every widget on the board." }),
    ]),

    el("div", { class: "section-title", text: "Data" }),
    checkbox(
      "Hide dust bots",
      "hideDustBots",
      "Excludes bots whose trades are negligible, such as a test bot dealing in fractions of a cent. They otherwise distort every fleet average.",
    ),

    el("div", { class: "section-title", text: "Control" }),
    checkbox(
      "Enable bot controls",
      "controlsEnabled",
      "Adds start and stop buttons to the bot fleet widget, behind a confirmation. Off by default: this dashboard observes.",
    ),
    el("div", { class: "field__hint", style: { marginTop: "-8px" } }, [
      el("span", {
        text: "External automation uses the REST API at /api/dash with its own scoped token, configured with DASHBOARD_AGENT_TOKENS on the server. See /api/dash/manifest.",
      }),
    ]),

    el("div", { class: "section-title", text: "Session" }),
    el("div", { class: "field__row" }, [
      el("button", {
        class: "btn btn--sm",
        type: "button",
        text: "Reset layout",
        onclick: () => {
          if (window.confirm("Reset the board to the default widgets?")) {
            resetLayout();
            closeDrawer("settings");
          }
        },
      }),
      el("button", {
        class: "btn btn--sm btn--danger",
        type: "button",
        text: "Sign out",
        onclick: () => {
          clearPassword();
          window.location.reload();
        },
      }),
    ]),
  );
}

// ---------- Start ----------

function start() {
  showApp();
  applyTheme();
  bindChrome();
  initToasts(document.querySelector("[data-toasts]"), document.querySelector("[data-toasts-alerts]"));
  initLayout(document.querySelector("[data-grid]"));

  store.subscribe((reason) => {
    if (reason === "snapshot" || reason === "health" || reason === "error") renderHeader();
    if (reason === "loading" || reason === "snapshot") renderRefreshStatus();
  });

  // Keep "updated Xs ago" honest between refreshes.
  window.setInterval(renderRefreshStatus, 1000);

  // Who is watching a shared feed. Published to the store so the Overview
  // widget can show it beside "N/N bots running".
  const pollWatchers = async () => {
    if (document.visibilityState !== "visible") return;

    const { watchers, blocked } = await fetchWatchers();

    store.data.watchers = watchers;
    store.emit("watchers");

    // Someone tried to open a link from a device that does not hold it. Stays
    // on screen until dismissed: this is the one thing here worth interrupting for.
    for (const attempt of blocked) {
      toast({
        title: "Share link used on another device",
        message: `${attempt.name} <${attempt.email}> tried to open their link from a device that is not theirs. They were refused.`,
        hint: `${new Date(attempt.at).toLocaleTimeString()} — close this to dismiss`,
        severity: "danger",
        sticky: true,
      });
    }
  };

  void pollWatchers();
  window.setInterval(() => void pollWatchers(), 15_000);

  initPoller({
    onEvents: (events) => {
      for (const event of events) toastForEvent(event);
      // The live-events widget keeps its own buffer, fed here.
      for (const listener of store.eventListeners ?? []) listener(events);
    },
    onUnauthorized: () => {
      clearPassword();
      showLogin("Your session is no longer valid. Sign in again.");
    },
  });

  renderHeader();
}

// A share token means this page is a recipient's read-only feed, not the
// dashboard: no admin password, no widgets, no presence list.
const token = shareToken();

if (token) startLiveFeed(token);
else if (getPassword()) start();
else showLogin();
