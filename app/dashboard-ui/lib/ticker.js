/**
 * The bottom ticker: one open trade at a time, sliding in like a news channel's
 * lower third.
 *
 * A continuous marquee was the obvious reading of "gliding text", but it is the
 * wrong one for this data. Marquee speed is fixed by pixel width, so a long bot
 * name would linger and a short one would flick past, and a reader who glances
 * down mid-scroll catches half a number. One trade at a time, held for a beat,
 * means every trade gets the same three seconds and is always readable whole.
 *
 * Both the owner dashboard and a shared live feed mount this from the same
 * position rows, so a viewer sees exactly what the owner sees.
 */
import { money, percent } from "./format.js";

/** How long each trade holds the bar before the next slides in. */
export const ITEM_MS = 3000;

/**
 * What the position is doing right now, in the three words the bar shows.
 *
 * These are not decoration - they map onto genuinely different states, and the
 * difference is worth money:
 *
 *   TAKE PROFIT  a live exit order is resting at its target. The healthy case:
 *                the trade will close itself.
 *   OPEN         the entry filled but no exit order was ever placed, so nothing
 *                will close it until one is.
 *   FLOATING     an exit order existed and was cancelled. The position is adrift
 *                with the market and its profit is being forgone - the case
 *                worth noticing, which is why it is called out separately.
 */
export function statusOf(position) {
  if (position.exitState === "live") return "TAKE PROFIT";
  if (position.exitState === "abandoned") return "FLOATING";

  return "OPEN";
}

/**
 * One position as the line of text the bar shows.
 *
 * Returns null when the symbol has no live price: a position we cannot mark to
 * market has no floating value and no percentage, and inventing a zero would
 * read as "flat" when the truth is "unknown".
 */
export function toTickerItem(position, botNames = {}) {
  if (position.markPrice === null || position.markPrice === undefined) return null;
  if (position.floatingPnl === null || position.floatingPnl === undefined) return null;

  const name = position.botName ?? botNames[position.botId] ?? (position.botId === null ? "—" : `Bot ${position.botId}`);
  const change = position.floatingPnlPercent ?? 0;

  return {
    key: position.smartTradeId ?? `${name}-${position.symbol}-${position.entryPrice}`,
    botName: name,
    symbol: position.symbol,
    status: statusOf(position),
    // What the trade was opened with, what it is worth now, and the gap.
    opened: money(position.costBasis),
    value: money(position.marketValue ?? position.costBasis + position.floatingPnl),
    floating: money(position.floatingPnl, { signed: true }),
    change: percent(change),
    // Green and red are near-identical in luminance on yellow, so on their own
    // they are invisible to a red/green colour-blind reader. The arrow carries
    // the same information without colour.
    arrow: change > 0 ? "▲" : change < 0 ? "▼" : "•",
    // Kept raw alongside the formatted string: ordering must not depend on
    // parsing back out of "+0.67%".
    changeValue: change,
    direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
  };
}

/** Every priced position, worst first so losses are never buried at the end. */
export function toTickerItems(positions, botNames = {}) {
  return positions
    .map((position) => toTickerItem(position, botNames))
    .filter((item) => item !== null)
    .sort((a, b) => a.changeValue - b.changeValue);
}

/**
 * Mount the bar and cycle it.
 *
 * `getItems` is called on each refresh rather than the items being passed in,
 * so the bar always reads from whatever the page last polled instead of keeping
 * a second copy that can drift out of date.
 *
 * The cycle is driven by setTimeout rather than a CSS animation loop because it
 * must survive the list changing underneath it: positions close and open while
 * the bar is running, and an index into a stale array would skip or repeat.
 */
export function mountTicker(bar, getItems) {
  const track = bar.querySelector("[data-ticker-item]");
  const label = bar.querySelector("[data-ticker-count]");

  let index = 0;
  let timer = null;
  let stopped = false;

  const show = (item) => {
    // Restart the slide-in by tearing the node out and rebuilding it: simply
    // reassigning the class would not replay an animation already at its end.
    track.replaceChildren();
    track.classList.remove("ticker__item--in");

    const line = document.createElement("span");
    line.className = `ticker__line ticker__line--${item.direction}`;

    const parts = [
      ["ticker__bot", `BOT: ${item.botName}`],
      ["ticker__sym", item.symbol],
      ["ticker__status", item.status],
      ["ticker__opened", `opened ${item.opened}`],
      ["ticker__value", `now ${item.value}`],
      ["ticker__pnl", `${item.arrow} ${item.floating} (${item.change})`],
    ];

    parts.forEach(([cls, text], i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "ticker__sep";
        sep.textContent = "|";
        line.append(sep);
      }
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = text;
      line.append(span);
    });

    track.append(line);
    // Force a reflow so the browser treats the class as a fresh transition.
    void track.offsetWidth;
    track.classList.add("ticker__item--in");
  };

  const tick = () => {
    if (stopped) return;

    const items = getItems();

    if (!items || items.length === 0) {
      track.replaceChildren();
      const idle = document.createElement("span");
      idle.className = "ticker__line ticker__line--flat";
      idle.textContent = "No open trades";
      track.append(idle);
      track.classList.add("ticker__item--in");
      if (label) label.textContent = "";
      timer = window.setTimeout(tick, ITEM_MS);

      return;
    }

    if (index >= items.length) index = 0;
    const item = items[index];
    if (label) label.textContent = `${index + 1}/${items.length}`;
    show(item);
    index += 1;

    timer = window.setTimeout(tick, ITEM_MS);
  };

  // A hidden tab should not burn a timer per 3 seconds redrawing something
  // nobody is looking at; resume from where it left off on return.
  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      if (timer === null && !stopped) tick();
    } else if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  document.addEventListener("visibilitychange", onVisibility);
  bar.hidden = false;
  tick();

  return () => {
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    bar.hidden = true;
  };
}
