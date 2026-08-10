/**
 * Adds an "Analytics" item to the OpenTrader navigation.
 *
 * The bundled frontend is a prebuilt React application with no source in this
 * repository, so it cannot gain a route. The same overlay approach already used
 * by `rsi-monitor.js` applies here: find the existing nav by its known items and
 * append a plain link, re-attaching whenever React re-renders the header away.
 */
const LINK_ID = "opentrader-analytics-link";
const TARGET = "/analytics/";
const NAV_ITEMS = ["Bots", "Strategies", "Exchange Accounts", "Settings"];

/**
 * Locate the navigation bar.
 *
 * Identified by structure rather than by class name: the bundle is minified, so
 * its class names change on every rebuild, but the set of nav labels does not.
 */
export function findNav(doc = document) {
  const anchors = [...doc.querySelectorAll("a, button")].filter((node) =>
    NAV_ITEMS.includes(node.textContent?.trim() ?? ""),
  );
  if (anchors.length < 2) return null;

  // The nav is the nearest ancestor that contains at least two of the items.
  let candidate = anchors[0].parentElement;
  while (candidate && candidate !== doc.body) {
    const contained = anchors.filter((anchor) => candidate.contains(anchor)).length;
    if (contained >= 2) return candidate;

    candidate = candidate.parentElement;
  }

  return null;
}

function buildLink(reference) {
  const link = document.createElement("a");
  link.id = LINK_ID;
  link.href = TARGET;
  link.textContent = "Analytics";

  // Copy the siblings computed look, so the item matches whatever theme is live
  // without hard-coding class names from a minified bundle.
  if (reference) {
    const style = window.getComputedStyle(reference);
    link.style.font = style.font;
    link.style.padding = style.padding;
    link.style.color = style.color;
    link.style.borderRadius = style.borderRadius;
  }

  link.style.textDecoration = "none";
  link.style.cursor = "pointer";
  link.style.whiteSpace = "nowrap";
  link.style.opacity = "0.85";
  link.addEventListener("mouseenter", () => (link.style.opacity = "1"));
  link.addEventListener("mouseleave", () => (link.style.opacity = "0.85"));

  return link;
}

export function attachLink() {
  if (document.getElementById(LINK_ID)) return true;

  const nav = findNav();
  if (!nav) return false;

  nav.append(buildLink(nav.lastElementChild));

  return true;
}

export function startAnalyticsLink() {
  if (typeof window === "undefined" || window.__openTraderAnalyticsLinkStarted) return;
  window.__openTraderAnalyticsLinkStarted = true;

  let queued = false;

  const observer = new MutationObserver(() => {
    if (queued || document.getElementById(LINK_ID)) return;

    queued = true;
    window.setTimeout(() => {
      queued = false;
      attachLink();
    }, 0);
  });

  observer.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });

  attachLink();
}

if (typeof window !== "undefined") startAnalyticsLink();
