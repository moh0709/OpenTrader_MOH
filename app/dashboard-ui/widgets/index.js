/** The widget catalogue. Order here is the order the Add widget drawer shows. */
import { overviewWidgets } from "./overview.js";
import { tradeWidgets } from "./trades.js";
import { marketWidgets } from "./market.js";
import { analyticsWidgets } from "./analytics.js";
import { opsWidgets } from "./ops.js";
import { arbitrageWidgets } from "./arbitrage.js";

const WIDGETS = [
  ...overviewWidgets,
  ...tradeWidgets,
  ...marketWidgets,
  ...arbitrageWidgets,
  ...analyticsWidgets,
  ...opsWidgets,
];

const BY_ID = new Map(WIDGETS.map((widget) => [widget.id, widget]));

export function widgetCatalog() {
  return WIDGETS;
}

export function getWidget(id) {
  return BY_ID.get(id);
}

/** Catalogue entries grouped for the drawer, preserving definition order. */
export function groupedCatalog() {
  const groups = new Map();

  for (const widget of WIDGETS) {
    if (!groups.has(widget.group)) groups.set(widget.group, []);
    groups.get(widget.group).push(widget);
  }

  return groups;
}
