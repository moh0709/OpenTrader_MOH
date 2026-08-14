/**
 * Widget group names as URL fragments.
 *
 * Kept apart from the board itself so it stays importable without the widget
 * catalogue, which reaches for `document` the moment it loads. The slug is the
 * whole contract behind a deep link such as /analytics/#arbitrage, so it is
 * worth being able to test on its own.
 */

/** "Grid & market" -> "grid-market". */
export function groupSlug(group) {
  return String(group ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
