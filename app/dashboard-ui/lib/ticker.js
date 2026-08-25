/**
 * The bottom ticker: two lanes, one item at a time each, sliding in like a news
 * channel's lower third.
 *
 * Left is the market — the open trades, worst first, so a loss is never buried
 * at the end. Right is the AI, and only the half of it that moved money: what
 * it opened, closed, capped or was blocked from doing.
 *
 * They are separate lanes rather than one merged stream because they answer
 * different questions and are read at different moments. Interleaved, a burst
 * of AI activity would push every position off the bar exactly when the
 * positions were the thing worth watching.
 *
 * A continuous marquee was the obvious reading of "gliding text", but it is the
 * wrong one for this data. Marquee speed is fixed by pixel width, so a long bot
 * name would linger and a short one would flick past, and a reader who glances
 * down mid-scroll catches half a number. One item at a time, held for a beat,
 * means every one gets the same seconds and is always readable whole.
 *
 * Both the owner dashboard and a shared live feed mount the trade lane from the
 * same position rows, so a viewer sees exactly what the owner sees. The AI lane
 * is the owner's alone: a share recipient cannot reach the action stream.
 */
import { money, percent } from "./format.js";

/** How long each trade holds the bar before the next slides in. */
export const ITEM_MS = 5000;

/**
 * How long a manual left/right press pauses the automatic advance.
 *
 * Long enough to press again and keep reading without the bar snatching the
 * trade away mid-sentence, short enough that a bar left alone goes back to
 * cycling on its own rather than sitting frozen on one trade forever.
 */
export const TAKEOVER_MS = 15_000;

/**
 * What the position is doing right now, in the three words the bar shows.
 *
 * This took two goes to get right, and both failures were the same mistake: a
 * status that is true but constant tells you nothing.
 *
 * Keying it off whether an exit order exists read TAKE PROFIT on all eleven
 * trades, because every healthy grid position has one. Keying it off whether
 * the price had reached the target read FLOATING on all eleven, because the
 * instant it reaches the target the order fills and the position closes - the
 * state is real but you can never catch it.
 *
 * What actually varies, minute to minute, is whether the trade is winning:
 *
 *   TAKE PROFIT  an exit is working and the trade is in profit, so if it closed
 *                on target now it would pay out. The good case.
 *   FLOATING     an exit is working but the trade is flat or under water, so it
 *                is still riding the market to get there.
 *   OPEN         no exit order is working at all. Nothing will close this
 *                position until one is placed, which is why it is called out
 *                rather than folded in with the rest.
 */
export function statusOf(position) {
  if (position.exitState !== "live") return "OPEN";

  return (position.floatingPnl ?? 0) > 0 ? "TAKE PROFIT" : "FLOATING";
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
    // The raw "now" figure, so a later poll can tell whether it went up.
    valueRaw: position.marketValue ?? position.costBasis + position.floatingPnl,
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
 * Which trades have gone up since the last time we saw them.
 *
 * Kept as a separate pass over a caller-owned map rather than module state, so
 * the owner dashboard and a shared feed each track their own values and a test
 * can drive it without reaching into globals.
 */
export function markRising(items, previous) {
  return items.map((item) => {
    const before = previous.get(item.key);
    const rising = before !== undefined && item.valueRaw > before;

    previous.set(item.key, item.valueRaw);

    return rising ? { ...item, rising: true } : item;
  });
}

/**
 * Trade-affecting AI actions, as lines for the AI News lane.
 *
 * Only what the AI *did* to positions and capital. Its readings and its
 * deliberations are on the AI tab where there is room for them; a lower third
 * that scrolled "council says hold" past you every five seconds would train you
 * to stop looking at the half that matters.
 *
 * Input order is preserved, and the feed hands them over newest first — the
 * opposite of the trade lane, which leads with the worst position. Different
 * question: that lane asks "what needs attention", this one asks "what just
 * happened".
 */
const NEWS_CHIPS = ["open", "close", "take-profit", "risk", "cap", "adjust"];

export function toNewsItems(actions) {
  return (actions ?? [])
    .filter((action) => NEWS_CHIPS.includes(action.chip))
    .map((action) => ({
      key: action.id,
      chip: action.chip,
      who: [action.botName, action.symbol].filter(Boolean).join(" · "),
      title: action.title,
      detail: action.detail,
      at: action.at,
      autonomous: Boolean(action.autonomous),
      // Green for a gain, red for anything that cost or blocked, neutral
      // otherwise — same vocabulary as the trade lane beside it.
      direction: action.severity === "success" ? "up" : action.severity === "info" ? "flat" : "down",
    }));
}

/** The trade lane's line: bot, symbol, status, opened, now, and the gap. */
function renderTradeLine(item) {
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
    // Only the "now" figure pulses, and only when it has actually risen since
    // the previous poll. Pulsing everything green would be decoration; this is
    // meant to catch the eye on the one number that moved up.
    if (cls === "ticker__value" && item.rising) span.classList.add("ticker__value--rising");
    span.textContent = text;
    line.append(span);
  });

  return line;
}

/** The AI lane's line: what it did, to what, and why, in that order. */
function renderNewsLine(item) {
  const line = document.createElement("span");
  line.className = `ticker__line ticker__line--${item.direction}`;

  const chip = document.createElement("span");
  chip.className = "ticker__chip";
  chip.dataset.chip = item.chip;
  chip.textContent = item.chip.replace(/-/g, " ");
  line.append(chip);

  if (item.autonomous) {
    const auto = document.createElement("span");
    auto.className = "ticker__chip ticker__chip--auto";
    auto.textContent = "auto";
    line.append(auto);
  }

  const parts = [
    ["ticker__bot", item.who || item.title],
    ["ticker__status", item.who ? item.title : ""],
    ["ticker__opened", item.detail ?? ""],
  ].filter(([, text]) => text);

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

  return line;
}

/**
 * Mount one lane and cycle it.
 *
 * `getItems` is called on each turn rather than the items being passed in, so
 * the bar always reads from whatever the page last polled instead of keeping a
 * second copy that can drift out of date.
 *
 * The cycle is driven by setTimeout rather than a CSS animation loop because it
 * must survive the list changing underneath it: positions close and open while
 * the bar is running, and an index into a stale array would skip or repeat.
 *
 * Both lanes share this. They differ only in how a line is drawn and what they
 * say when there is nothing to show, which is what `render` and `emptyText`
 * are for.
 */
export function mountLane(
  bar,
  getItems,
  { itemMs = ITEM_MS, takeoverMs = TAKEOVER_MS, render: renderLine = renderTradeLine, emptyText = "No open trades" } = {},
) {
  const track = bar.querySelector("[data-lane-item]");
  const label = bar.querySelector("[data-lane-count]");
  const prevButton = bar.querySelector("[data-lane-prev]");
  const nextButton = bar.querySelector("[data-lane-next]");

  let index = 0;
  let timer = null;
  let stopped = false;
  let manualUntil = 0;

  const held = () => Date.now() < manualUntil;

  const render = (item) => {
    // Restart the slide-in by rebuilding the node: reassigning the class alone
    // would not replay an animation already sitting at its end.
    track.replaceChildren();
    track.classList.remove("ticker__item--in");

    track.append(renderLine(item));
    void track.offsetWidth;
    track.classList.add("ticker__item--in");
  };

  const idle = () => {
    track.replaceChildren();
    const line = document.createElement("span");
    line.className = "ticker__line ticker__line--flat";
    line.textContent = typeof emptyText === "function" ? emptyText() : emptyText;
    track.append(line);
    track.classList.add("ticker__item--in");
    if (label) label.textContent = "";
  };

  /** Draw whatever `index` currently points at, without touching the timer. */
  const paint = () => {
    const items = getItems();

    if (!items || items.length === 0) {
      idle();

      return;
    }

    if (index >= items.length) index = 0;
    if (index < 0) index = items.length - 1;

    if (label) label.textContent = `${index + 1}/${items.length}${held() ? " · held" : ""}`;
    render(items[index]);
  };

  const arm = (delay) => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(tick, delay);
  };

  function tick() {
    if (stopped) return;

    // A manual press owns the bar until it lapses; keep checking back so the
    // automatic advance resumes on its own the moment the hold expires.
    if (held()) {
      arm(Math.max(250, manualUntil - Date.now()));

      return;
    }

    paint();
    index += 1;
    arm(itemMs);
  }

  /**
   * Move `delta` trades from the one currently on screen and hold there.
   *
   * `index` always points at what comes *next*, so the trade being read is the
   * one before it - hence the -1. Stated this way the callers can say what they
   * mean, which is +1 for forward and -1 for back.
   */
  const step = (delta) => {
    const items = getItems();
    if (!items || items.length === 0) return;

    manualUntil = Date.now() + takeoverMs;

    const showing = index - 1;
    index = ((showing + delta) % items.length + items.length) % items.length;
    paint();
    // Leave it pointing past what we just drew, so when the hold lapses the bar
    // carries on rather than repeating the trade the reader just looked at.
    index += 1;
    arm(takeoverMs);
  };

  prevButton?.addEventListener("click", () => step(-1));
  nextButton?.addEventListener("click", () => step(1));

  // A hidden tab should not burn a timer redrawing something nobody is looking
  // at; resume from where it left off on return.
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

/**
 * The trade lane, and the bar that holds it.
 *
 * Kept as its own function because a shared live feed mounts exactly this and
 * nothing else: a recipient has no access to the AI action stream, so the right
 * lane is not theirs to see.
 */
export function mountTicker(container, getItems, options = {}) {
  const lane = container.querySelector("[data-lane-trades]") ?? container;
  const stop = mountLane(lane, getItems, options);

  container.hidden = false;

  return () => {
    stop();
    container.hidden = true;
  };
}

/** The AI News lane. Only mounted where the AI action stream is readable. */
export function mountNewsLane(container, getItems, options = {}) {
  const lane = container.querySelector("[data-lane-ai]");
  if (!lane) return () => {};

  return mountLane(lane, getItems, {
    render: renderNewsLine,
    emptyText: "No AI activity yet",
    ...options,
  });
}
