/**
 * Adds an "Analytics" item to the OpenTrader navigation.
 *
 * The bundled frontend is a prebuilt React application with no source in this
 * repository, so it cannot gain a route. The same overlay approach already used
 * by `rsi-monitor.js` applies here: find the existing nav and append a link,
 * re-attaching whenever React re-renders the header away.
 *
 * The app renders the navigation twice - a horizontal bar for wide screens and a
 * vertical list inside the burger drawer for narrow ones - and only one of them
 * is ever visible. Both get the link, otherwise it disappears on a phone.
 *
 * Rather than hard-code class names, which are minified and change on every
 * upstream build, each link is cloned from a real nav item and rewritten. The
 * clone inherits whatever markup and styling that nav uses, so the item looks
 * native in both the bar and the drawer without knowing anything about either.
 */
const MARK = "data-opentrader-analytics-link";
const TARGET = "/analytics/";
const LABEL = "Analytics";
const NAV_ITEMS = ["Bots", "Strategies", "Exchange Accounts", "Settings"];

/**
 * Every container that holds at least two nav items.
 *
 * Identified by structure rather than by class: the labels are stable across
 * builds, the class names are not. Returns the nearest such ancestor for each
 * distinct nav, so the wide-screen bar and the drawer list are both found.
 */
export function findNavContainers(doc = document) {
  const items = [...doc.querySelectorAll("a, button")].filter((node) =>
    NAV_ITEMS.includes(node.textContent?.trim() ?? ""),
  );
  if (items.length < 2) return [];

  const containers = new Set();

  for (const item of items) {
    let candidate = item.parentElement;

    while (candidate && candidate !== doc.body) {
      if (items.filter((other) => candidate.contains(other)).length >= 2) {
        containers.add(candidate);
        break;
      }
      candidate = candidate.parentElement;
    }
  }

  return [...containers];
}

/** The nav item to copy: the last one, so the clone lands in the same style. */
function templateItem(container) {
  const items = [...container.children].filter((child) => !child.hasAttribute(MARK));

  return items[items.length - 1] ?? null;
}

/**
 * Replace the label wherever it actually lives.
 *
 * A drawer item wraps its text in one or more spans, a bar item does not, so
 * the text is written to the deepest element that holds it rather than to the
 * anchor itself - which would otherwise wipe out the wrapper markup.
 */
function setLabel(node, label) {
  const holder =
    [...node.querySelectorAll("*")].reverse().find((child) => child.children.length === 0 && child.textContent?.trim()) ??
    node;

  holder.textContent = label;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Swap the cloned item's icon for a chart.
 *
 * The clone inherits the icon of whatever it was copied from - usually the
 * Settings cog, which makes the entry read as a second Settings. The svg
 * element itself is reused so its sizing and classes stay untouched; only the
 * glyph inside changes.
 */
function setIcon(link) {
  const icon = link.querySelector("svg");
  if (!icon) return;

  while (icon.firstChild) icon.removeChild(icon.firstChild);
  icon.setAttribute("viewBox", "0 0 24 24");

  // Three ascending bars, drawn as strokes so it inherits the nav's colour.
  for (const [x, y] of [
    [6, 14],
    [12, 10],
    [18, 5],
  ]) {
    const bar = document.createElementNS(SVG_NS, "line");
    bar.setAttribute("x1", String(x));
    bar.setAttribute("x2", String(x));
    bar.setAttribute("y1", String(y));
    bar.setAttribute("y2", "19");
    bar.setAttribute("stroke", "currentColor");
    bar.setAttribute("stroke-width", "2.2");
    bar.setAttribute("stroke-linecap", "round");
    bar.setAttribute("fill", "none");
    icon.append(bar);
  }
}

function buildLink(container) {
  const template = templateItem(container);
  if (!template) return null;

  const link = template.cloneNode(true);

  link.setAttribute(MARK, "");
  // A clone of the current page would otherwise claim to be active too.
  link.removeAttribute("aria-current");
  link.removeAttribute("data-status");
  link.classList.remove("active");
  link.removeAttribute("id");
  for (const child of link.querySelectorAll("[id]")) child.removeAttribute("id");

  // The dashboard is a separate document, so this is a real navigation, not a
  // hash route the React router would try to handle.
  if (link.tagName === "A") link.setAttribute("href", TARGET);
  else link.addEventListener("click", () => (window.location.href = TARGET));

  setLabel(link, LABEL);
  setIcon(link);

  return link;
}

export function attachLinks(doc = document) {
  let added = 0;

  for (const container of findNavContainers(doc)) {
    if (container.querySelector(`[${MARK}]`)) continue;

    const link = buildLink(container);
    if (!link) continue;

    container.append(link);
    added += 1;
  }

  return added;
}

export function startAnalyticsLink() {
  if (typeof window === "undefined" || window.__openTraderAnalyticsLinkStarted) return;
  window.__openTraderAnalyticsLinkStarted = true;

  let queued = false;

  const sync = () => {
    queued = false;
    attachLinks();
  };

  // The drawer is mounted only when opened, and React re-renders the header on
  // navigation, so both need watching rather than a single pass at load.
  const observer = new MutationObserver(() => {
    if (queued) return;

    queued = true;
    window.setTimeout(sync, 0);
  });

  observer.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });

  attachLinks();
}

if (typeof window !== "undefined") startAnalyticsLink();
