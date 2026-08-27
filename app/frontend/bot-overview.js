/**
 * Two views of one snapshot: a bot picker on the "Bots" nav button, and the
 * position figures each bot card was missing.
 *
 * The bundled frontend is a prebuilt React application with no source in this
 * repository, so both are injected the way the Analytics link and the bot card
 * tools are. They live together because they answer the same question from the
 * same request - which bots exist, and what is each one holding - and splitting
 * them would mean two pollers asking /api/dash/snapshot for the same payload.
 *
 * Anchors are routes, never class names. The app's minified classes
 * ("joy-1o905kn") are regenerated on every upstream build, but "/#/dashboard/bot"
 * is part of its own URL scheme and survives them. The one exception is
 * `BotCard-bot-title`, which upstream sets deliberately and the existing card
 * tools already depend on.
 */

const NAV_MARK = "data-opentrader-bot-menu";
const FIGS_MARK = "data-opentrader-bot-figs";
const STYLE_ID = "opentrader-bot-overview-style";
const CARD_LINK = "a.BotCard-bot-title";

/** How long a snapshot is reused before another is fetched. */
const TTL_MS = 15_000;
/** How often the figures refresh while the list is on screen. */
const POLL_MS = 20_000;

// ---------- api ----------

function authHeaders() {
  const password = window.localStorage.getItem("ADMIN_PASSWORD");

  return password ? { authorization: password } : {};
}

async function api(path) {
  const response = await window.fetch(`/api/dash${path}`, { headers: authHeaders() });
  const payload = await response.json().catch(() => null);

  if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);

  return payload;
}

/**
 * The fleet, cached.
 *
 * One in-flight request is shared by every caller: the nav menu and a page of
 * cards otherwise open with a burst of identical requests for a payload the
 * server has already computed once.
 */
let cache = { at: 0, bots: null };
let inFlight = null;

export function readSnapshot(snapshot) {
  return (snapshot?.bots ?? []).map((bot) => ({
    id: bot.botId,
    name: bot.name || `Bot ${bot.botId}`,
    symbol: bot.symbol ?? "",
    enabled: Boolean(bot.enabled),
    open: bot.positions?.open ?? 0,
    underwater: bot.positions?.underwater ?? 0,
    floating: Number.isFinite(bot.positions?.floatingPnl) ? bot.positions.floatingPnl : null,
    costBasis: Number.isFinite(bot.positions?.costBasis) ? bot.positions.costBasis : null,
  }));
}

function fleet({ force = false } = {}) {
  if (!force && cache.bots && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.bots);
  if (inFlight) return inFlight;

  inFlight = api("/snapshot")
    .then((snapshot) => {
      cache = { at: Date.now(), bots: readSnapshot(snapshot) };

      return cache.bots;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

// ---------- formatting ----------

/** The quote asset a bot settles in, so a PAXG bot is not labelled in ETH. */
export function quoteOf(symbol) {
  const parts = String(symbol || "").split("/");

  return parts.length > 1 ? parts[1] : "";
}

/**
 * Formatted the way the rest of the app formats money, not the way the reader's
 * machine would.
 *
 * The locale is pinned rather than left to the browser: the app prints its own
 * profits as "+67.45 USDT", so on a machine set to a comma-decimal locale an
 * unpinned figure would render "-20,15" directly beside "+4.61" on the same
 * card, reading as a different kind of number rather than the same one.
 */
export function money(value, { signed = true } = {}) {
  if (value === null || !Number.isFinite(value)) return "—";

  const sign = signed && value > 0 ? "+" : value < 0 ? "-" : "";

  return `${sign}${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "up", "down" or "flat" - drives the colour, and nothing else. */
export function tone(value) {
  if (value === null || !Number.isFinite(value) || value === 0) return "flat";

  return value > 0 ? "up" : "down";
}

// ---------- styles ----------

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .ot-botmenu-toggle {
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; margin-left: -4px; padding: 0;
      border: 0; border-radius: 6px; cursor: pointer;
      background: transparent; color: var(--joy-palette-text-secondary, #52514e);
    }
    .ot-botmenu-toggle:hover {
      background: var(--joy-palette-neutral-plainHoverBg, rgba(128,128,128,.14));
      color: var(--joy-palette-text-primary, #0b0b0b);
    }
    .ot-botmenu-toggle svg { transition: transform .15s ease; }
    .ot-botmenu-toggle[aria-expanded="true"] svg { transform: rotate(180deg); }

    .ot-botmenu {
      position: fixed; z-index: 10000; min-width: 260px; max-width: 340px;
      max-height: min(70vh, 460px); overflow: auto; padding: 6px;
      border-radius: 10px;
      border: 1px solid var(--joy-palette-divider, rgba(128,128,128,.28));
      background: var(--joy-palette-background-surface, #fff);
      color: var(--joy-palette-text-primary, #111);
      box-shadow: 0 10px 30px rgba(0,0,0,.22);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .ot-botmenu__note { padding: 8px 10px; font-size: 12px; opacity: .7; }
    .ot-botmenu__item {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 9px; border-radius: 7px;
      text-decoration: none; color: inherit;
    }
    .ot-botmenu__item:hover { background: var(--joy-palette-neutral-plainHoverBg, rgba(128,128,128,.14)); }
    .ot-botmenu__id {
      flex: none; min-width: 30px; padding: 2px 5px; border-radius: 5px;
      font-size: 11px; font-variant-numeric: tabular-nums; text-align: center;
      background: var(--joy-palette-background-level1, rgba(128,128,128,.12));
      opacity: .85;
    }
    .ot-botmenu__body { flex: 1 1 auto; min-width: 0; }
    .ot-botmenu__name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ot-botmenu__sub { display: block; font-size: 11px; opacity: .65; }
    .ot-botmenu__dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--joy-palette-neutral-400, #9aa0a6); }
    .ot-botmenu__dot[data-on="1"] { background: var(--joy-palette-success-solidBg, #1a9c4c); }

    .ot-bot-figs {
      display: flex; gap: 16px; flex-wrap: wrap;
      margin-top: 10px; padding-top: 9px;
      border-top: 1px solid var(--joy-palette-divider, rgba(128,128,128,.2));
    }
    .ot-bot-figs__cell { display: flex; flex-direction: column; gap: 2px; }
    .ot-bot-figs__label {
      font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase;
      opacity: .6; white-space: nowrap;
    }
    .ot-bot-figs__value { font-size: 13.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .ot-bot-figs__value[data-tone="up"] { color: var(--joy-palette-success-plainColor, #1a7f42); }
    .ot-bot-figs__value[data-tone="down"] { color: var(--joy-palette-danger-plainColor, #d03b3b); }
    .ot-bot-figs__unit { font-size: 10.5px; font-weight: 400; opacity: .6; margin-left: 3px; }
    .ot-bot-figs__sub { font-size: 10.5px; opacity: .6; }
  `;
  document.head.append(style);
}

const SVG_NS = "http://www.w3.org/2000/svg";

function chevron() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M6 9.5 12 15.5 18 9.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2.2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);

  return svg;
}

// ---------- the nav menu ----------

/**
 * Every rendering of the "Bots" nav entry.
 *
 * The bar is drawn twice by the app - a row of buttons on a wide screen, a
 * drawer on a narrow one - and only one of them is in the document at a time.
 * Matching on the route rather than the layout picks up whichever is present,
 * and the trailing-slash tolerance covers both forms the router emits.
 */
export function isBotsRoute(href) {
  return /(^|#)\/dashboard\/bot\/?$/.test(String(href ?? ""));
}

function botsNavLinks(doc) {
  return [...doc.querySelectorAll("a[href]")].filter(
    (anchor) =>
      isBotsRoute(anchor.getAttribute("href")) &&
      // The route alone would also catch a "back to bots" link inside a page,
      // which would grow a chevron of its own. Both renderings of the nav entry
      // carry exactly this label and no other text - the icon is an svg - so it
      // is what separates the navigation from a link that merely points there.
      anchor.textContent?.trim() === "Bots",
  );
}

let openMenu = null;

function closeMenu() {
  if (!openMenu) return;

  openMenu.menu.remove();
  openMenu.toggle.setAttribute("aria-expanded", "false");
  openMenu = null;
}

function placeMenu(menu, toggle) {
  const box = toggle.getBoundingClientRect();
  const width = menu.offsetWidth || 280;
  // Kept inside the viewport: the nav sits well to the right on some widths,
  // where a menu aligned to its button would hang off the screen.
  const left = Math.min(Math.max(8, box.left - 8), window.innerWidth - width - 8);

  menu.style.top = `${Math.round(box.bottom + 6)}px`;
  menu.style.left = `${Math.round(left)}px`;
}

function menuItem(bot) {
  const item = document.createElement("a");
  item.className = "ot-botmenu__item";
  item.href = `/#/dashboard/bot/${bot.id}`;

  const dot = document.createElement("span");
  dot.className = "ot-botmenu__dot";
  dot.dataset.on = bot.enabled ? "1" : "0";
  dot.title = bot.enabled ? "Running" : "Stopped";

  const id = document.createElement("span");
  id.className = "ot-botmenu__id";
  id.textContent = `#${bot.id}`;

  const body = document.createElement("span");
  body.className = "ot-botmenu__body";

  const name = document.createElement("span");
  name.className = "ot-botmenu__name";
  name.textContent = bot.name;

  const sub = document.createElement("span");
  sub.className = "ot-botmenu__sub";
  sub.textContent = [bot.symbol, bot.open > 0 ? `${bot.open} open` : "no open trades"].filter(Boolean).join(" · ");

  body.append(name, sub);
  item.append(dot, id, body);
  // The menu is a picker, not a place to linger: choosing a bot closes it.
  item.addEventListener("click", () => closeMenu());

  return item;
}

function showMenu(toggle) {
  ensureStyles();

  const menu = document.createElement("div");
  menu.className = "ot-botmenu";
  menu.setAttribute("role", "menu");

  const note = document.createElement("div");
  note.className = "ot-botmenu__note";
  note.textContent = "Loading bots…";
  menu.append(note);

  document.body.append(menu);
  placeMenu(menu, toggle);

  toggle.setAttribute("aria-expanded", "true");
  openMenu = { menu, toggle };

  fleet()
    .then((bots) => {
      // The menu may have been dismissed while the request was in flight.
      if (openMenu?.menu !== menu) return;

      menu.textContent = "";

      if (bots.length === 0) {
        const empty = document.createElement("div");
        empty.className = "ot-botmenu__note";
        empty.textContent = "No bots yet.";
        menu.append(empty);
      } else {
        for (const bot of bots) menu.append(menuItem(bot));
      }

      placeMenu(menu, toggle);
    })
    .catch((error) => {
      if (openMenu?.menu !== menu) return;

      note.textContent = `Could not load bots: ${error.message}`;
    });
}

/** Give one "Bots" entry its chevron, leaving the entry itself untouched. */
function attachToggle(link) {
  if (link.nextElementSibling?.hasAttribute?.(NAV_MARK)) return false;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.setAttribute(NAV_MARK, "");
  toggle.className = "ot-botmenu-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-haspopup", "menu");
  toggle.setAttribute("aria-label", "Choose a bot");
  toggle.title = "Choose a bot";
  toggle.append(chevron());

  toggle.addEventListener("click", (event) => {
    // Without this the click reaches the nav link behind it and navigates to
    // the list, which is the one thing the chevron exists not to do.
    event.preventDefault();
    event.stopPropagation();

    if (openMenu?.toggle === toggle) {
      closeMenu();

      return;
    }

    closeMenu();
    showMenu(toggle);
  });

  link.after(toggle);

  return true;
}

// ---------- the card figures ----------

export function botIdFrom(link) {
  const match = /\/dashboard\/bot\/(\d+)/.exec(link.getAttribute("href") ?? "");

  return match ? Number(match[1]) : null;
}

/** The card body: the closest ancestor holding the whole card, not just the title. */
function cardFor(link) {
  let node = link.parentElement;

  for (let depth = 0; node && depth < 6; depth += 1) {
    if ((node.className || "").toString().includes("Card")) return node;
    node = node.parentElement;
  }

  return link.parentElement;
}

function cell(label) {
  const wrap = document.createElement("div");
  wrap.className = "ot-bot-figs__cell";

  const caption = document.createElement("span");
  caption.className = "ot-bot-figs__label";
  caption.textContent = label;

  const value = document.createElement("span");
  value.className = "ot-bot-figs__value";
  value.textContent = "…";

  wrap.append(caption, value);

  return { wrap, value };
}

function buildFigures() {
  const row = document.createElement("div");
  row.className = "ot-bot-figs";
  row.setAttribute(FIGS_MARK, "");

  const floating = cell("Floating");
  const open = cell("Open trades");

  row.append(floating.wrap, open.wrap);
  row._floating = floating.value;
  row._open = open.value;

  return row;
}

function fillFigures(row, bot) {
  // Only write when something actually changed.
  //
  // The MutationObserver that re-attaches these rows cannot tell our own writes
  // from React's, so an unconditional repaint would observe itself: fill,
  // observe, re-attach, fill again, forever. Comparing first makes the steady
  // state a no-op and lets the loop settle.
  const signature = JSON.stringify([bot.floating, bot.open, bot.underwater, bot.symbol]);
  if (row._signature === signature) return;
  row._signature = signature;

  const quote = quoteOf(bot.symbol);

  row._floating.textContent = money(bot.floating);
  row._floating.dataset.tone = tone(bot.floating);

  if (quote) {
    const unit = document.createElement("span");
    unit.className = "ot-bot-figs__unit";
    unit.textContent = quote;
    row._floating.append(unit);
  }

  // The capital at work is the other reading of "how much is floating", and it
  // belongs where it cannot be mistaken for the profit figure beside it.
  row._floating.parentElement.title =
    bot.open > 0
      ? [
          `Unrealised across ${bot.open} open position(s)`,
          bot.costBasis === null ? null : `${money(bot.costBasis, { signed: false })} ${quote} at work`,
          bot.underwater > 0 ? `${bot.underwater} underwater` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "No open positions";

  row._open.textContent = String(bot.open);
  row._open.parentElement.title = bot.underwater > 0 ? `${bot.underwater} of ${bot.open} underwater` : "";

  let sub = row.querySelector(".ot-bot-figs__sub");
  if (bot.underwater > 0) {
    if (!sub) {
      sub = document.createElement("span");
      sub.className = "ot-bot-figs__sub";
      row._open.parentElement.append(sub);
    }
    sub.textContent = `${bot.underwater} underwater`;
  } else if (sub) {
    sub.remove();
  }
}

/**
 * Put a figures row on every card, then fill it.
 *
 * The row is created before the data arrives so the cards do not jump as the
 * request lands, and so a slow or failed fetch leaves a placeholder rather than
 * a card that silently reads as having no positions.
 */
function attachFigures(doc) {
  const wanted = new Map();

  for (const link of doc.querySelectorAll(CARD_LINK)) {
    const botId = botIdFrom(link);
    if (botId === null) continue;

    const card = cardFor(link);
    if (!card) continue;

    let row = card.querySelector(`[${FIGS_MARK}]`);
    if (!row) {
      row = buildFigures();

      // The action buttons belong at the bottom of the card, under the numbers
      // they act on, so the figures go above them when both are present.
      const tools = card.querySelector("[data-opentrader-bot-tools]");
      if (tools) tools.before(row);
      else card.append(row);
    }

    wanted.set(botId, row);
  }

  if (wanted.size === 0) return 0;

  fleet()
    .then((bots) => {
      for (const bot of bots) {
        const row = wanted.get(bot.id);
        if (row?.isConnected) fillFigures(row, bot);
      }
    })
    .catch(() => {
      for (const row of wanted.values()) {
        if (!row.isConnected) continue;

        row._floating.textContent = "—";
        row._open.textContent = "—";
      }
    });

  return wanted.size;
}

// ---------- wiring ----------

export function attachBotOverview(doc = document) {
  ensureStyles();

  // Drop chevrons the app orphaned by rebuilding the bar around them, so a
  // navigated-to-and-back header cannot accumulate a row of them.
  for (const stale of doc.querySelectorAll(`[${NAV_MARK}]`)) {
    const previous = stale.previousElementSibling;
    if (!previous || !isBotsRoute(previous.getAttribute?.("href"))) stale.remove();
  }

  let added = 0;
  for (const link of botsNavLinks(doc)) if (attachToggle(link)) added += 1;

  return added + attachFigures(doc);
}

export function startBotOverview() {
  if (typeof window === "undefined" || window.__openTraderBotOverviewStarted) return;
  window.__openTraderBotOverviewStarted = true;

  let queued = false;
  const sync = () => {
    queued = false;
    attachBotOverview();
  };

  // React rebuilds the header and the card list on navigation, dropping
  // anything injected into them, so both have to be put back each time.
  const observer = new MutationObserver(() => {
    if (queued) return;

    queued = true;
    window.setTimeout(sync, 0);
  });

  observer.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });

  document.addEventListener("click", (event) => {
    if (!openMenu) return;
    if (!openMenu.menu.contains(event.target) && !openMenu.toggle.contains(event.target)) closeMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });

  // A fixed menu does not follow its button, so it is dismissed rather than
  // left pointing at nothing.
  window.addEventListener("scroll", closeMenu, true);
  window.addEventListener("resize", closeMenu);
  window.addEventListener("hashchange", closeMenu);

  // Keep the figures honest while the list stays open. Skipped when the tab is
  // in the background: a hidden page has nobody to be stale for.
  window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!document.querySelector(`[${FIGS_MARK}]`)) return;

    void fleet({ force: true })
      .then(() => attachBotOverview())
      .catch(() => {});
  }, POLL_MS);

  attachBotOverview();
}

if (typeof window !== "undefined") startBotOverview();
