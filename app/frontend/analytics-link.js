/**
 * Adds "Analytics" and "Arbitrage" buttons beside the logo in the top bar.
 *
 * They used to be cloned into the navigation list, which put them alongside
 * Bots/Strategies/Settings on wide screens but inside the burger drawer on a
 * phone - two different places, and invisible until you opened the menu.
 * Anchoring to the logo instead puts them in one spot that is always on screen,
 * because the logo is the only element of that bar rendered in both layouts.
 *
 * The anchor is the logo's href, not its class: the app is a prebuilt bundle
 * whose class names ("joy-1o905kn") are regenerated on every upstream build,
 * so matching on them would break at the next release. The route "/#/" is part
 * of the app's own URL scheme and survives rebuilds.
 */

/** The links to install, in the order they appear after the logo. */
const LINKS = [
  {
    mark: "data-opentrader-analytics-link",
    target: "/analytics/",
    label: "Analytics",
    // Three ascending bars.
    icon: (svg) => bars(svg, [[6, 14], [12, 10], [18, 5]]),
  },
  {
    mark: "data-opentrader-arbitrage-link",
    target: "/analytics/#arbitrage",
    label: "Arbitrage",
    // Two opposed arrows: value moving between venues.
    icon: (svg) => exchangeArrows(svg),
  },
];


const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Swap the cloned item's icon for a chart.
 *
 * The clone inherits the icon of whatever it was copied from - usually the
 * Settings cog, which makes the entry read as a second Settings. The svg
 * element itself is reused so its sizing and classes stay untouched; only the
 * glyph inside changes.
 */
function stroke(svg, attrs) {
  const line = document.createElementNS(SVG_NS, "line");
  for (const [key, value] of Object.entries(attrs)) line.setAttribute(key, String(value));
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "2.2");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("fill", "none");
  svg.append(line);
}

/** Vertical bars rising to a baseline. */
function bars(svg, points) {
  for (const [x, y] of points) stroke(svg, { x1: x, x2: x, y1: y, y2: 19 });
}

/** Two arrows pointing opposite ways, one above the other. */
function exchangeArrows(svg) {
  stroke(svg, { x1: 4, x2: 19, y1: 9, y2: 9 });
  stroke(svg, { x1: 15, x2: 19, y1: 5, y2: 9 });
  stroke(svg, { x1: 20, x2: 5, y1: 15, y2: 15 });
  stroke(svg, { x1: 9, x2: 5, y1: 19, y2: 15 });
}


/**
 * The logo link in the top bar.
 *
 * Matched on the app's own root route and confirmed to sit at the top of the
 * page, so a stray "/#/" link further down the document cannot be mistaken for
 * it.
 */
function logoLink(doc) {
  for (const anchor of doc.querySelectorAll('a[href="/#/"]')) {
    const box = anchor.getBoundingClientRect();
    if (box.top < 90 && box.width > 0) return anchor;
  }

  return null;
}

/** One button, built from scratch rather than cloned. */
function buildLink(spec) {
  const link = document.createElement("a");
  link.setAttribute(spec.mark, "");
  link.href = spec.target;
  link.className = `ot-toplink ot-toplink--${spec.label.toLowerCase()}`;
  // The label is also the accessible name, so hiding the text on a narrow
  // screen does not leave a button that only reads as "link".
  link.setAttribute("aria-label", spec.label);
  link.title = spec.label;

  const icon = document.createElementNS(SVG_NS, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "18");
  icon.setAttribute("height", "18");
  icon.setAttribute("aria-hidden", "true");
  spec.icon(icon);

  const text = document.createElement("span");
  text.className = "ot-toplink__label";
  text.textContent = spec.label;

  link.append(icon, text);

  return link;
}

/**
 * Styling.
 *
 * Written against Joy's palette variables with plain fallbacks, so the buttons
 * follow the app's light and dark themes instead of pinning colours that would
 * be unreadable in one of them.
 */
function installStyle(doc) {
  if (doc.getElementById("ot-toplink-style")) return;

  const style = doc.createElement("style");
  style.id = "ot-toplink-style";
  style.textContent = `
    .ot-toplink {
      display: inline-flex; align-items: center; gap: 6px;
      margin-left: 8px; padding: 6px 10px;
      border-radius: 8px; text-decoration: none; white-space: nowrap;
      font-size: 14px; font-weight: 500; line-height: 1;
      color: var(--joy-palette-text-secondary, #52514e);
      border: 1px solid var(--joy-palette-divider, rgba(128,128,128,.28));
    }
    .ot-toplink:hover {
      color: var(--joy-palette-text-primary, #0b0b0b);
      background: var(--joy-palette-neutral-plainHoverBg, rgba(128,128,128,.12));
    }
    /* On a narrow bar something has to give, but not the Analytics label -
       an unlabelled chart glyph beside an unlabelled arrows glyph is a puzzle,
       and Analytics is the one people are looking for. Arbitrage keeps its
       icon and its accessible name, which is what the space actually allows. */
    @media (max-width: 460px) {
      .ot-toplink { padding: 6px 8px; margin-left: 6px; font-size: 13px; }
      .ot-toplink--arbitrage { padding: 6px; }
      .ot-toplink--arbitrage .ot-toplink__label { display: none; }
    }
  `;
  doc.head.append(style);
}

function attachLinks(doc = document) {
  const logo = logoLink(doc);
  if (!logo) return 0;

  installStyle(doc);

  let added = 0;
  let after = logo;

  for (const spec of LINKS) {
    // Re-check each pass: React re-renders the bar on navigation and drops them.
    if (doc.querySelector(`[${spec.mark}]`)) {
      after = doc.querySelector(`[${spec.mark}]`);
      continue;
    }

    const link = buildLink(spec);
    after.after(link);
    after = link;
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

  // React re-renders the header on navigation, so a single pass at load is not
  // enough - the buttons have to be put back each time the bar is rebuilt.
  const observer = new MutationObserver(() => {
    if (queued) return;

    queued = true;
    window.setTimeout(sync, 0);
  });

  observer.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });

  attachLinks();
}

if (typeof window !== "undefined") startAnalyticsLink();
