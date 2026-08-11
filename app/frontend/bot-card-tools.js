/**
 * Adds Purge and Limits controls to every bot card on the bot list.
 *
 * The bundled frontend is a prebuilt React application with no source here, so
 * these are injected the same way the Analytics nav link is. Each card exposes a
 * link with the stable class `BotCard-bot-title` whose href carries the bot id,
 * which is what anchors the injection - class names elsewhere in the bundle are
 * minified and change on every upstream build.
 *
 * Both controls talk to /api/dash, which shares the admin password already in
 * localStorage, so there is no second session to manage.
 *
 * Purge is destructive and irreversible: it deletes every trade a bot owns, open
 * and closed. The confirmation is therefore built from a real server-side
 * preview - actual trade and order counts, open positions, realised profit about
 * to be discarded - rather than a generic "are you sure".
 */
const MARK = "data-opentrader-bot-tools";
const STYLE_ID = "opentrader-bot-tools-style";
const CARD_LINK = "a.BotCard-bot-title";

// ---------- api ----------

function authHeaders() {
  const password = window.localStorage.getItem("ADMIN_PASSWORD");

  return password ? { authorization: password, "content-type": "application/json" } : { "content-type": "application/json" };
}

async function api(path, options = {}) {
  const response = await window.fetch(`/api/dash${path}`, { headers: authHeaders(), ...options });
  const payload = await response.json().catch(() => null);

  if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);

  return payload;
}

// ---------- chrome ----------

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .ot-bot-tools { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
    .ot-bot-tools button {
      font: inherit; font-size: 12px; line-height: 1;
      padding: 5px 10px; border-radius: 6px; cursor: pointer;
      border: 1px solid var(--joy-palette-divider, rgba(128,128,128,.3));
      background: var(--joy-palette-background-surface, transparent);
      color: var(--joy-palette-text-primary, inherit);
    }
    .ot-bot-tools button:hover { border-color: var(--joy-palette-neutral-outlinedBorder, #888); }
    .ot-bot-tools button[data-tone="danger"] { color: var(--joy-palette-danger-plainColor, #d03b3b); }
    .ot-bot-tools button[disabled] { opacity: .5; cursor: default; }
    .ot-bot-limit { font-size: 11px; opacity: .7; align-self: center; }

    .ot-modal { position: fixed; inset: 0; z-index: 9999; display: grid; place-items: center; }
    .ot-modal__scrim { position: absolute; inset: 0; background: rgba(0,0,0,.45); }
    .ot-modal__card {
      position: relative; width: min(430px, calc(100vw - 32px));
      max-height: calc(100vh - 40px); overflow: auto;
      padding: 18px; border-radius: 12px;
      background: var(--joy-palette-background-surface, #fff);
      color: var(--joy-palette-text-primary, #111);
      box-shadow: 0 10px 40px rgba(0,0,0,.35);
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .ot-modal__title { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
    .ot-modal__sub { font-size: 12.5px; opacity: .75; margin: 0 0 14px; }
    .ot-modal__row { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 13px; }
    .ot-modal__row b { font-variant-numeric: tabular-nums; }
    .ot-modal__warn {
      margin: 12px 0; padding: 9px 11px; border-radius: 8px; font-size: 12.5px;
      border-left: 3px solid var(--joy-palette-danger-plainColor, #d03b3b);
      background: var(--joy-palette-background-level1, rgba(128,128,128,.1));
    }
    .ot-modal__field { margin: 12px 0; }
    .ot-modal__field label { display: block; font-size: 12.5px; font-weight: 500; margin-bottom: 4px; }
    .ot-modal__field input {
      font: inherit; width: 100%; padding: 8px 10px; border-radius: 8px;
      border: 1px solid var(--joy-palette-divider, rgba(128,128,128,.35));
      background: var(--joy-palette-background-body, transparent);
      color: inherit;
    }
    .ot-modal__hint { font-size: 11.5px; opacity: .7; margin-top: 4px; line-height: 1.4; }
    .ot-modal__actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
    .ot-modal__actions button {
      font: inherit; font-size: 13px; padding: 8px 14px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--joy-palette-divider, rgba(128,128,128,.3));
      background: transparent; color: inherit;
    }
    .ot-modal__actions button[data-primary] {
      background: var(--joy-palette-primary-solidBg, #2a78d6); border-color: transparent; color: #fff;
    }
    .ot-modal__actions button[data-primary][data-tone="danger"] {
      background: var(--joy-palette-danger-solidBg, #d03b3b);
    }
    .ot-modal__actions button[disabled] { opacity: .6; cursor: default; }
    .ot-modal__error { color: var(--joy-palette-danger-plainColor, #d03b3b); font-size: 12.5px; margin-top: 10px; }
  `;
  document.head.append(style);
}

/** A modal returning a promise that resolves true when the primary action ran. */
function modal({ title, subtitle, body, confirmLabel, tone, onConfirm, confirmDisabled = false }) {
  ensureStyles();

  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "ot-modal";

    const scrim = document.createElement("div");
    scrim.className = "ot-modal__scrim";

    const card = document.createElement("div");
    card.className = "ot-modal__card";

    const heading = document.createElement("h2");
    heading.className = "ot-modal__title";
    heading.textContent = title;

    const sub = document.createElement("p");
    sub.className = "ot-modal__sub";
    sub.textContent = subtitle ?? "";

    const actions = document.createElement("div");
    actions.className = "ot-modal__actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.dataset.primary = "";
    if (tone) confirm.dataset.tone = tone;
    confirm.textContent = confirmLabel;
    confirm.disabled = confirmDisabled;

    const error = document.createElement("p");
    error.className = "ot-modal__error";
    error.hidden = true;

    const close = (result) => {
      root.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };

    const onKey = (event) => {
      if (event.key === "Escape") close(false);
    };

    cancel.addEventListener("click", () => close(false));
    scrim.addEventListener("click", () => close(false));
    document.addEventListener("keydown", onKey);

    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      const label = confirm.textContent;
      confirm.textContent = "Working…";
      error.hidden = true;

      try {
        await onConfirm();
        close(true);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : String(err);
        error.hidden = false;
        confirm.disabled = false;
        cancel.disabled = false;
        confirm.textContent = label;
      }
    });

    actions.append(cancel, confirm);
    card.append(heading, sub, body, error, actions);
    root.append(scrim, card);
    document.body.append(root);

    (body.querySelector("input") ?? confirm).focus();
  });
}

const row = (label, value) => {
  const node = document.createElement("div");
  node.className = "ot-modal__row";

  const left = document.createElement("span");
  left.textContent = label;

  const right = document.createElement("b");
  right.textContent = value;

  node.append(left, right);

  return node;
};

const field = (label, value, hint, attrs = {}) => {
  const wrap = document.createElement("div");
  wrap.className = "ot-modal__field";

  const caption = document.createElement("label");
  caption.textContent = label;

  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.step = "any";
  input.value = value ?? "";
  input.placeholder = "no limit";
  Object.assign(input, attrs);

  const note = document.createElement("div");
  note.className = "ot-modal__hint";
  note.textContent = hint;

  wrap.append(caption, input, note);
  wrap.__input = input;

  return wrap;
};

// ---------- actions ----------

const money = (value) =>
  typeof value === "number" ? value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";

async function openPurge(botId, botName) {
  let preview;
  try {
    preview = await api(`/bots/${botId}/purge-preview`);
  } catch (err) {
    window.alert(`Could not read the bot: ${err.message}`);
    return;
  }

  const body = document.createElement("div");
  body.append(
    row("Trades", String(preview.trades)),
    row("Orders", String(preview.orders)),
    row("Open positions", String(preview.openPositions)),
    row("Live orders on the exchange", String(preview.liveOrders)),
    row("Realised profit to be discarded", money(preview.realizedPnl)),
  );

  const warn = document.createElement("div");
  warn.className = "ot-modal__warn";
  warn.textContent = preview.blockedReason
    ? preview.blockedReason
    : `This deletes every trade this bot owns, open and closed, and cannot be undone. ${
        preview.liveOrders > 0
          ? `Its ${preview.liveOrders} live order(s) are cancelled on the exchange first, so nothing is left resting.`
          : "It has no live orders to cancel."
      }`;
  body.append(warn);

  const done = await modal({
    title: `Purge ${botName}`,
    subtitle: "Reset this bot to zero.",
    body,
    confirmLabel: "Purge everything",
    tone: "danger",
    confirmDisabled: !!preview.blockedReason,
    onConfirm: () => api("/actions/bot.purgeTrades", { method: "POST", body: JSON.stringify({ botId }) }),
  });

  if (done) window.location.reload();
}

async function openLimits(botId, botName) {
  let bot;
  try {
    bot = await api(`/bots/${botId}/limits`);
  } catch (err) {
    window.alert(`Could not read the bot: ${err.message}`);
    return;
  }

  const quote = (bot.symbol || "").split("/")[1] || "quote";

  const body = document.createElement("div");
  const capital = field(
    `Maximum capital (${quote})`,
    bot.maxCapital,
    `The most this bot may have committed at once, counting open positions and resting buy orders. New entries are skipped once the total would exceed it. Leave empty or 0 for no limit.`,
  );
  const profit = field(
    `Minimum profit per trade (${quote})`,
    bot.minProfit,
    `A take profit that would earn less than this is raised to the price that does, so tight grid levels cannot close for a fraction of a cent. Leave empty or 0 for no limit.`,
  );

  body.append(capital, profit);

  await modal({
    title: `Limits for ${botName}`,
    subtitle: bot.enabled ? "Applies to orders placed from now on." : "Applies once the bot is started.",
    body,
    confirmLabel: "Save limits",
    onConfirm: () =>
      api("/actions/bot.setLimits", {
        method: "POST",
        body: JSON.stringify({
          botId,
          maxCapital: Number(capital.__input.value) || 0,
          minProfit: Number(profit.__input.value) || 0,
        }),
      }),
  });
}

// ---------- injection ----------

function botIdFrom(link) {
  const match = /\/dashboard\/bot\/(\d+)/.exec(link.getAttribute("href") ?? "");

  return match ? Number(match[1]) : null;
}

/** The card body: the closest ancestor that holds the whole card, not just the title. */
function cardFor(link) {
  let node = link.parentElement;

  for (let depth = 0; node && depth < 6; depth += 1) {
    if ((node.className || "").toString().includes("Card")) return node;
    node = node.parentElement;
  }

  return link.parentElement;
}

export function attachBotTools(doc = document) {
  let added = 0;

  for (const link of doc.querySelectorAll(CARD_LINK)) {
    const botId = botIdFrom(link);
    if (botId === null) continue;

    const card = cardFor(link);
    if (!card || card.querySelector(`[${MARK}]`)) continue;

    const name = link.textContent?.trim() || `Bot ${botId}`;

    const tools = document.createElement("div");
    tools.className = "ot-bot-tools";
    tools.setAttribute(MARK, "");

    const limits = document.createElement("button");
    limits.type = "button";
    limits.textContent = "Limits";
    limits.title = "Cap the capital this bot may use, and the minimum profit per trade";

    const purge = document.createElement("button");
    purge.type = "button";
    purge.dataset.tone = "danger";
    purge.textContent = "Purge";
    purge.title = "Delete every trade of this bot and start from zero";

    // The card is a link: without this, clicking a button navigates to the bot.
    for (const [button, handler] of [
      [limits, () => openLimits(botId, name)],
      [purge, () => openPurge(botId, name)],
    ]) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void handler();
      });
    }

    tools.append(limits, purge);
    card.append(tools);
    added += 1;
  }

  return added;
}

export function startBotCardTools() {
  if (typeof window === "undefined" || window.__openTraderBotToolsStarted) return;
  window.__openTraderBotToolsStarted = true;

  ensureStyles();

  let queued = false;
  const sync = () => {
    queued = false;
    attachBotTools();
  };

  const observer = new MutationObserver(() => {
    if (queued) return;

    queued = true;
    window.setTimeout(sync, 0);
  });

  observer.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });

  attachBotTools();
}

if (typeof window !== "undefined") startBotCardTools();
