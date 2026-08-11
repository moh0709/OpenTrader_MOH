/**
 * Share links: the manager the owner sees, and the live feed a recipient sees.
 *
 * One module because the two sides are one feature and share their vocabulary,
 * but they never mix at runtime: a page either has a share token in its URL, in
 * which case it is the read-only feed and nothing else is reachable, or it does
 * not, in which case it is the dashboard.
 *
 * The recipient view is deliberately thin. It reads one endpoint that returns
 * only what a viewer is allowed to know, it holds no admin password, and it
 * never learns who else has been given a link.
 */
import { el, mount } from "./dom.js";
import { count, dateTime, duration, money, percent, pnlClass, timeAgo } from "./format.js";

const DEVICE_KEY = "otAnalytics.deviceId.v1";

/** The share token in the URL, if this page is a shared feed. */
export function shareToken() {
  return new URLSearchParams(window.location.search).get("share");
}

/**
 * A stable id for this browser.
 *
 * The link binds to the first device that opens it, so this has to survive
 * reloads. Clearing browser storage looks like a new device, which is why the
 * owner can free a link from whatever is holding it.
 */
export function deviceId() {
  let id = window.localStorage.getItem(DEVICE_KEY);

  if (!id) {
    id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, "");
    window.localStorage.setItem(DEVICE_KEY, id);
  }

  return id;
}

async function shareApi(path, token) {
  const response = await window.fetch(`/api/share${path}`, {
    headers: { "x-share-token": token, "x-share-device": deviceId() },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || `HTTP ${response.status}`);
    error.code = payload?.error;
    throw error;
  }

  return payload;
}

// ---------- the recipient's live feed ----------

function stat(label, value, cls) {
  return el("div", { class: "stat" }, [
    el("div", { class: "stat__label", text: label }),
    el("div", { class: `stat__value ${cls ?? ""}`.trim(), text: value }),
  ]);
}

function renderFeed(root, data) {
  const { fleet } = data;

  mount(
    root,
    el("div", { class: "stat-row" }, [
      stat("Realised profit", money(fleet.netPnl, { signed: true }), pnlClass(fleet.netPnl)),
      stat("Closed trades", count(fleet.trades)),
      stat("Floating", fleet.floatingPnl === null ? "—" : money(fleet.floatingPnl, { signed: true }), pnlClass(fleet.floatingPnl)),
      stat("Open positions", count(fleet.openPositions)),
      stat("Bots running", `${count(fleet.enabledBots)}/${count(fleet.bots)}`),
    ]),

    el("div", { class: "section-title", text: "Bots" }),
    el("table", { class: "table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Bot" }),
          el("th", { text: "Symbol" }),
          el("th", { text: "Realised" }),
          el("th", { text: "Floating" }),
          el("th", { text: "Trades" }),
          el("th", { text: "Open" }),
        ]),
      ]),
      el(
        "tbody",
        {},
        data.bots.map((bot) =>
          el("tr", {}, [
            el("td", { class: "table__name" }, [
              el("span", { text: bot.name }),
              el("span", { class: "small muted", text: bot.enabled ? " running" : " stopped" }),
            ]),
            el("td", { text: bot.symbol }),
            el("td", { class: pnlClass(bot.netPnl), text: money(bot.netPnl, { signed: true }) }),
            el("td", {
              class: pnlClass(bot.floatingPnl),
              text: bot.floatingPnl === null ? "—" : money(bot.floatingPnl, { signed: true }),
            }),
            el("td", { text: count(bot.trades) }),
            el("td", { text: count(bot.openPositions) }),
          ]),
        ),
      ),
    ]),

    el("div", { class: "section-title", text: "Recent closed trades" }),
    data.recentTrades.length === 0
      ? el("div", { class: "empty", text: "No closed trades yet." })
      : el("table", { class: "table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "Bot" }),
              el("th", { text: "Symbol" }),
              el("th", { text: "Buy" }),
              el("th", { text: "Close" }),
              el("th", { text: "Profit" }),
              el("th", { text: "Win %" }),
              el("th", { text: "Held" }),
              el("th", { text: "Closed" }),
            ]),
          ]),
          el(
            "tbody",
            {},
            data.recentTrades.map((trade) =>
              el("tr", { title: dateTime(trade.exitAt) }, [
                el("td", { class: "table__name", text: trade.botName }),
                el("td", { text: trade.symbol }),
                el("td", { text: trade.entryPrice.toFixed(2) }),
                el("td", { text: trade.exitPrice.toFixed(2) }),
                el("td", { class: pnlClass(trade.netPnl), text: money(trade.netPnl, { signed: true }) }),
                el("td", { class: pnlClass(trade.pnlPercent), text: percent(trade.pnlPercent) }),
                el("td", { text: duration(trade.holdMs) }),
                el("td", { class: "muted", text: timeAgo(trade.exitAt) }),
              ]),
            ),
          ),
        ]),
  );
}

function renderRefusal(message) {
  document.body.replaceChildren(
    el("div", { class: "login" }, [
      el("div", { class: "login__card" }, [
        el("h1", { class: "login__title", text: "Live feed" }),
        el("p", { class: "login__text", text: message }),
      ]),
    ]),
  );
}

/**
 * Run the page as a recipient's live feed.
 *
 * Every poll re-authorises against the server, so a revoked or expired link
 * stops working within one refresh rather than lasting as long as the tab does.
 */
export function startLiveFeed(token) {
  document.title = "Live feed";

  const app = document.getElementById("app");
  const login = document.getElementById("login");
  login.hidden = true;
  app.hidden = false;

  // Strip the dashboard chrome: none of it applies to a read-only viewer.
  for (const selector of ["[data-open-catalog]", "[data-open-settings]", "[data-health-pill]", "[data-open-share]", "[data-share-presence]"]) {
    document.querySelector(selector)?.remove();
  }

  document.querySelector(".brand__text").textContent = "Live feed";
  document.querySelector(".btn--back")?.remove();

  const grid = document.querySelector("[data-grid]");
  const card = el("article", { class: "widget", style: { "--w": "12" } }, [
    el("header", { class: "widget__head", style: { cursor: "default" } }, [
      el("span", { class: "widget__title", text: "Live feed" }),
      el("span", { class: "widget__meta", "data-feed-meta": "" }),
    ]),
    el("div", { class: "widget__body", "data-feed-body": "" }, [el("div", { class: "empty", text: "Connecting…" })]),
  ]);

  mount(grid, card);
  document.querySelector("[data-empty]")?.setAttribute("hidden", "");

  const body = card.querySelector("[data-feed-body]");
  const meta = card.querySelector("[data-feed-meta]");
  const hero = document.querySelector("[data-hero-pnl]");
  const heroMeta = document.querySelector("[data-hero-meta]");

  let timer = null;

  const poll = async () => {
    if (document.visibilityState !== "visible") return;

    try {
      const data = await shareApi("/snapshot", token);

      hero.textContent = money(data.fleet.netPnl, { signed: true });
      hero.className = `topbar__hero-value ${pnlClass(data.fleet.netPnl)}`;
      heroMeta.textContent = `${count(data.fleet.trades)} closed trades`;
      meta.textContent = `${data.viewer.name} · updated ${new Date(data.generatedAt).toLocaleTimeString()}`;

      renderFeed(body, data);
      document.querySelector("[data-refresh-status]").textContent = "live";
    } catch (error) {
      // "Already in use" and "expired" are final: stop polling and say so.
      if (["in_use", "expired", "revoked", "invalid"].includes(error.code)) {
        window.clearInterval(timer);
        renderRefusal(error.message);
        return;
      }

      document.querySelector("[data-refresh-status]").textContent = "reconnecting…";
    }
  };

  void poll();
  timer = window.setInterval(() => void poll(), 10_000);
  document.addEventListener("visibilitychange", () => void poll());
}

// ---------- the owner's share manager ----------

async function ownerApi(path, options = {}) {
  const password = window.localStorage.getItem("ADMIN_PASSWORD");
  const response = await window.fetch(`/api/dash${path}`, {
    headers: { authorization: password ?? "", "content-type": "application/json" },
    ...options,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `HTTP ${response.status}`);

  return payload;
}

const STATUS_LABEL = { active: "In use", unclaimed: "Not opened yet", expired: "Expired", revoked: "Revoked" };

function shareRow(share, refresh) {
  const actions = el("div", { class: "field__row", style: { marginTop: "6px" } }, [
    el("button", {
      class: "btn btn--sm",
      type: "button",
      text: "Copy link",
      onclick: async (event) => {
        await navigator.clipboard?.writeText(share.url).catch(() => undefined);
        event.target.textContent = "Copied";
        window.setTimeout(() => (event.target.textContent = "Copy link"), 1500);
      },
    }),
    share.status === "active"
      ? el("button", {
          class: "btn btn--sm",
          type: "button",
          title: "Let them open it on a different device",
          text: "Free device",
          onclick: async () => {
            await ownerApi(`/shares/${share.id}/release`, { method: "POST" });
            refresh();
          },
        })
      : null,
    el("button", {
      class: "btn btn--sm btn--danger",
      type: "button",
      text: "Delete",
      onclick: async () => {
        if (!window.confirm(`Delete the link for ${share.name}? They will lose access immediately.`)) return;
        await ownerApi(`/shares/${share.id}`, { method: "DELETE" });
        refresh();
      },
    }),
  ]);

  return el("div", { class: "catalog__item", style: { display: "block", cursor: "default" } }, [
    el("div", { style: { display: "flex", justifyContent: "space-between", gap: "10px" } }, [
      el("div", {}, [
        el("div", { class: "catalog__name" }, [
          share.watching ? el("span", { class: "led", title: "Watching now" }) : null,
          el("span", { text: share.name }),
        ]),
        el("div", { class: "catalog__desc", text: share.email }),
      ]),
      el("div", { style: { textAlign: "right" } }, [
        el("div", { class: "small", text: STATUS_LABEL[share.status] ?? share.status }),
        el("div", { class: "small muted", text: `until ${dateTime(share.expiresAt)}` }),
      ]),
    ]),
    share.emailError
      ? el("div", { class: "small neg", style: { marginTop: "4px" }, text: `Email not delivered: ${share.emailError}` })
      : el("div", {
          class: "small muted",
          style: { marginTop: "4px" },
          text: share.emailSentAt ? `Emailed ${timeAgo(share.emailSentAt)}` : "Not emailed — copy the link instead",
        }),
    actions,
  ]);
}

/** The Share drawer: issue a link, and manage the ones already out there. */
export function renderShareManager(body) {
  const refresh = () => void load();

  const load = async () => {
    let data;
    try {
      data = await ownerApi("/shares");
    } catch (error) {
      mount(body, el("div", { class: "empty", text: `Could not load share links: ${error.message}` }));
      return;
    }

    const name = el("input", { class: "input", type: "text", placeholder: "Their name" });
    const email = el("input", { class: "input", type: "email", placeholder: "their@email.com" });
    const expiry = el("input", { class: "input", type: "date" });
    // A week is the sensible default for "have a look at this".
    expiry.value = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

    const error = el("p", { class: "login__error", hidden: true });

    const submit = el("button", {
      class: "btn btn--primary btn--block",
      type: "button",
      text: "Create link and email it",
      onclick: async () => {
        error.hidden = true;
        submit.disabled = true;
        submit.textContent = "Creating…";

        try {
          await ownerApi("/shares", {
            method: "POST",
            body: JSON.stringify({
              name: name.value,
              email: email.value,
              // End of the chosen day, so "expires today" lasts all of today.
              expiresAt: new Date(`${expiry.value}T23:59:59Z`).toISOString(),
            }),
          });
          refresh();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          submit.disabled = false;
          submit.textContent = "Create link and email it";
        }
      },
    });

    mount(
      body,
      el("div", { class: "section-title", text: "Share the live feed" }),
      el("p", { class: "field__hint", style: { marginBottom: "12px" } }, [
        el("span", {
          text: "They get a read-only live feed. It works on the first device that opens it and nowhere else, until it expires.",
        }),
      ]),
      el("div", { class: "field" }, [el("label", { class: "field__label", text: "Name" }), name]),
      el("div", { class: "field" }, [el("label", { class: "field__label", text: "Email" }), email]),
      el("div", { class: "field" }, [el("label", { class: "field__label", text: "Expires" }), expiry]),
      error,
      submit,
      !data.emailEnabled
        ? el("div", { class: "note note--warn", style: { marginTop: "10px" } }, [
            el("span", { text: "Email sending is switched off. Create the link and copy it instead." }),
          ])
        : null,

      el("div", { class: "section-title", text: `Shared with (${data.shares.length})` }),
      data.shares.length === 0
        ? el("div", { class: "empty", text: "Nobody yet." })
        : el("div", {}, data.shares.map((share) => shareRow(share, refresh))),
    );
  };

  void load();
}

/**
 * The presence indicator: who is watching, shown to the owner only.
 *
 * Rendered next to the Overview heading so it sits with "7/7 bots running",
 * which is where you look for what is happening right now.
 */
export function renderWatchers(container, watchers) {
  if (!container) return;

  if (!watchers || watchers.length === 0) {
    container.replaceChildren();
    return;
  }

  container.replaceChildren(
    ...watchers.map((viewer) =>
      el("span", { class: "watcher", title: `${viewer.email} — watching now` }, [
        el("span", { class: "led" }),
        el("span", { text: viewer.name }),
      ]),
    ),
  );
}

export async function fetchWatchers() {
  try {
    const data = await ownerApi("/shares/watchers");

    return data.watchers ?? [];
  } catch {
    return [];
  }
}
