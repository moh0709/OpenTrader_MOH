/**
 * Trade widgets: closed trades, open positions and the abandoned book.
 *
 * The abandoned widget is the one that pays for the whole dashboard. When a bot
 * is stopped, OpenTrader cancels its resting take profit orders - but any
 * position already bought stays bought. The capital is still committed and the
 * profit that exit would have earned is simply gone. Nothing in the stock UI
 * shows this, and on a real fleet it can dwarf everything realised.
 */
import { downloadCsv, el, emptyState, mount, note, select } from "../lib/dom.js";
import { count, dateTime, duration, money, percent, price, pnlClass, quantity, timeAgo } from "../lib/format.js";
import { query } from "../lib/api.js";
import { store } from "../lib/store.js";

const PERIODS = [
  { value: "0", label: "All time" },
  { value: "86400000", label: "Last 24h" },
  { value: "604800000", label: "Last 7 days" },
  { value: "2592000000", label: "Last 30 days" },
];

const OUTCOMES = [
  { value: "", label: "All outcomes" },
  { value: "win", label: "Wins" },
  { value: "loss", label: "Losses" },
];

/** A bot picker built from whatever bots are currently in the snapshot. */
function botOptions(all = "All bots") {
  const bots = store.visibleBots();

  return [{ value: "", label: all }, ...bots.map((bot) => ({ value: String(bot.botId), label: bot.name }))];
}

export const closedTradesWidget = {
  id: "closedTrades",
  name: "Closed trades",
  group: "Trades",
  description: "Every completed round trip: buy price, close price, profit, win percent and how long ago it closed.",
  defaultSpan: 12,
  defaultRows: 3,
  singleton: true,
  defaultConfig: { botId: "", outcome: "", period: "0", sort: "exitAt", direction: "desc", limit: 50 },

  tools(instance, ctx) {
    return [
      select(botOptions(), instance.config.botId, (value) => ctx.setConfig({ botId: value }), "Bot"),
      select(OUTCOMES, instance.config.outcome, (value) => ctx.setConfig({ outcome: value }), "Outcome"),
      select(PERIODS, instance.config.period, (value) => ctx.setConfig({ period: value }), "Period"),
      el("button", {
        class: "widget__tool",
        type: "button",
        title: "Export as CSV",
        text: "CSV",
        onclick: () => exportTrades(instance),
      }),
    ];
  },

  render(ctx) {
    const load = async () => {
      const config = ctx.config;
      const period = Number(config.period ?? 0);

      try {
        const view = await query("dashboard.trades", {
          botId: config.botId ? Number(config.botId) : undefined,
          outcome: config.outcome || undefined,
          from: period > 0 ? Date.now() - period : undefined,
          sort: config.sort ?? "exitAt",
          direction: config.direction ?? "desc",
          limit: config.limit ?? 50,
        });

        // Stashed on the instance so the CSV tool can export what is on screen.
        ctx.instance.__trades = view;
        draw(view);
      } catch (error) {
        mount(ctx.body, emptyState(`Could not load trades: ${error.message}`));
      }
    };

    const setSort = (column) => {
      const direction = ctx.config.sort === column && ctx.config.direction === "desc" ? "asc" : "desc";
      ctx.setConfig({ sort: column, direction });
    };

    const header = (label, column) =>
      el("th", {
        text: ctx.config.sort === column ? `${label} ${ctx.config.direction === "desc" ? "▾" : "▴"}` : label,
        dataset: { sort: column },
        onclick: () => setSort(column),
      });

    const draw = (view) => {
      if (!view) return;

      const { trades, totals, total, botNames } = view;
      ctx.setMeta(
        `${count(total)} trades - ${money(totals.netPnl, { signed: true })}${totals.winRate === null ? "" : ` - ${percent(totals.winRate, { signed: false, decimals: 0 })} win`}`,
      );

      if (trades.length === 0) {
        return mount(ctx.body, emptyState("No closed trades match these filters."));
      }

      const now = Date.now();

      mount(
        ctx.body,
        el("table", { class: "table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "Bot" }),
              el("th", { text: "Symbol" }),
              el("th", { text: "Buy" }),
              el("th", { text: "Close" }),
              el("th", { text: "Qty" }),
              header("Profit", "netPnl"),
              header("Win %", "pnlPercent"),
              header("Held", "holdMs"),
              header("Closed", "exitAt"),
            ]),
          ]),
          el(
            "tbody",
            {},
            trades.map((trade) =>
              el("tr", { title: `Closed ${dateTime(trade.exitAt)}` }, [
                el("td", { class: "table__name", text: botNames[trade.botId] ?? `Bot ${trade.botId}` }),
                el("td", { text: trade.symbol }),
                el("td", { text: price(trade.entryPrice) }),
                el("td", { text: price(trade.exitPrice) }),
                el("td", { text: quantity(trade.quantity) }),
                el("td", { class: pnlClass(trade.netPnl), text: money(trade.netPnl, { signed: true }) }),
                el("td", { class: pnlClass(trade.pnlPercent), text: percent(trade.pnlPercent) }),
                el("td", { text: duration(trade.holdMs) }),
                el("td", { class: "muted", text: timeAgo(trade.exitAt, now) }),
              ]),
            ),
          ),
          el("tfoot", {}, [
            el("tr", {}, [
              el("td", { colspan: 5, class: "muted small", text: `Totals across all ${count(total)} matching trades` }),
              el("td", { class: pnlClass(totals.netPnl), text: money(totals.netPnl, { signed: true }) }),
              el("td", { class: "muted", text: percent(totals.averagePnlPercent) }),
              el("td", { class: "muted", text: duration(totals.averageHoldMs) }),
              el("td", {}),
            ]),
          ]),
        ]),
      );
    };

    void load();
    const unsubscribe = ctx.store.subscribe((reason) => reason === "snapshot" && void load());

    return { dispose: unsubscribe };
  },
};

function exportTrades(instance) {
  const view = instance.__trades;
  if (!view?.trades?.length) return;

  downloadCsv(
    `opentrader-closed-trades-${new Date().toISOString().slice(0, 10)}.csv`,
    ["Bot", "Symbol", "Buy price", "Close price", "Quantity", "Gross", "Fees", "Net profit", "Profit %", "Held (min)", "Closed at"],
    view.trades.map((trade) => [
      view.botNames[trade.botId] ?? trade.botId,
      trade.symbol,
      trade.entryPrice,
      trade.exitPrice,
      trade.quantity,
      trade.grossPnl.toFixed(6),
      trade.fees.toFixed(6),
      trade.netPnl.toFixed(6),
      trade.pnlPercent.toFixed(4),
      (trade.holdMs / 60000).toFixed(2),
      new Date(trade.exitAt).toISOString(),
    ]),
  );
}

export const openPositionsWidget = {
  id: "openPositions",
  name: "Open positions",
  group: "Trades",
  description: "Positions holding stock, marked to the live price, with distance to their target.",
  defaultSpan: 6,
  defaultRows: 3,
  singleton: true,
  defaultConfig: { botId: "" },

  tools(instance, ctx) {
    return [select(botOptions(), instance.config.botId, (value) => ctx.setConfig({ botId: value }), "Bot")];
  },

  render(ctx) {
    const load = async () => {
      try {
        const view = await query("dashboard.positions", {
          botId: ctx.config.botId ? Number(ctx.config.botId) : undefined,
          state: "live",
          includePending: false,
        });

        draw(view);
      } catch (error) {
        mount(ctx.body, emptyState(`Could not load positions: ${error.message}`));
      }
    };

    const draw = (view) => {
      const positions = view.positions;
      ctx.setMeta(`${count(positions.length)} holding`);

      if (positions.length === 0) {
        return mount(ctx.body, emptyState("No open positions with a live exit order."));
      }

      const floating = positions.reduce((sum, position) => sum + (position.floatingPnl ?? 0), 0);
      const underwater = positions.filter((position) => position.underwater).length;

      mount(
        ctx.body,
        el("div", { class: "toolbar small muted" }, [
          el("span", { class: pnlClass(floating), text: `Floating ${money(floating, { signed: true })}` }),
          el("span", { text: `${count(underwater)} underwater` }),
          el("span", {
            class: "toolbar__spacer muted",
            text: `${money(positions.reduce((sum, p) => sum + p.costBasis, 0), { compact: true })} committed`,
          }),
        ]),
        el("table", { class: "table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "Bot" }),
              el("th", { text: "Entry" }),
              el("th", { text: "Now" }),
              el("th", { text: "Floating" }),
              el("th", { text: "Target" }),
              el("th", { text: "To go" }),
              el("th", { text: "Age" }),
            ]),
          ]),
          el(
            "tbody",
            {},
            positions.map((position) =>
              el("tr", {}, [
                el("td", { class: "table__name", text: view.botNames[position.botId] ?? `Bot ${position.botId}` }),
                el("td", { text: price(position.entryPrice) }),
                el("td", { text: price(position.markPrice) }),
                el("td", {
                  class: pnlClass(position.floatingPnl),
                  text: position.floatingPnl === null ? "—" : money(position.floatingPnl, { signed: true }),
                }),
                el("td", { text: price(position.targetPrice) }),
                el("td", {
                  class: "muted",
                  text: position.distanceToTargetPercent === null ? "—" : percent(position.distanceToTargetPercent),
                }),
                el("td", { class: "muted", text: duration(position.ageMs) }),
              ]),
            ),
          ),
        ]),
      );
    };

    void load();

    return { dispose: ctx.store.subscribe((reason) => reason === "snapshot" && void load()) };
  },
};

export const abandonedWidget = {
  id: "abandoned",
  name: "Abandoned positions",
  group: "Trades",
  description: "Positions that bought but whose exit order was cancelled - stranded capital and forgone profit.",
  defaultSpan: 6,
  defaultRows: 3,
  singleton: true,
  defaultConfig: { botId: "" },

  tools(instance, ctx) {
    return [select(botOptions(), instance.config.botId, (value) => ctx.setConfig({ botId: value }), "Bot")];
  },

  render(ctx) {
    const load = async () => {
      try {
        const view = await query("dashboard.positions", {
          botId: ctx.config.botId ? Number(ctx.config.botId) : undefined,
          includePending: false,
        });

        // Everything whose exit is not resting on the exchange any more.
        draw({ ...view, positions: view.positions.filter((position) => position.exitState !== "live") });
      } catch (error) {
        mount(ctx.body, emptyState(`Could not load positions: ${error.message}`));
      }
    };

    const draw = (view) => {
      const positions = view.positions;

      if (positions.length === 0) {
        ctx.setMeta("none");
        return mount(ctx.body, emptyState("Every open position has a live exit order."));
      }

      const stranded = positions.reduce((sum, position) => sum + position.costBasis, 0);
      const forgone = positions.reduce((sum, position) => sum + (position.potentialPnl ?? 0), 0);
      const realised = ctx.store.data.snapshot?.fleet?.realized?.netPnl ?? 0;

      ctx.setMeta(`${count(positions.length)} - ${money(forgone, { signed: true })} forgone`);

      const byBot = new Map();
      for (const position of positions) {
        const entry = byBot.get(position.botId) ?? { count: 0, cost: 0, profit: 0 };
        entry.count += 1;
        entry.cost += position.costBasis;
        entry.profit += position.potentialPnl ?? 0;
        byBot.set(position.botId, entry);
      }

      mount(
        ctx.body,
        note(
          `These positions bought and were never sold: the bot was stopped, which cancelled the take profit order resting against them. The capital stays committed until a bot covers that price level again.${
            realised > 0 && forgone > realised
              ? ` Forgone profit here is ${(forgone / realised).toFixed(1)}x everything the fleet has actually realised.`
              : ""
          }`,
          "warn",
        ),
        el("div", { class: "stat-row", style: { marginBottom: "10px" } }, [
          el("div", { class: "stat" }, [
            el("div", { class: "stat__label", text: "Capital stranded" }),
            el("div", { class: "stat__value", text: money(stranded, { compact: true }) }),
            el("div", { class: "stat__meta", text: `${count(positions.length)} positions` }),
          ]),
          el("div", { class: "stat" }, [
            el("div", { class: "stat__label", text: "Profit forgone" }),
            el("div", { class: "stat__value neg", text: money(forgone, { signed: true }) }),
            el("div", { class: "stat__meta", text: "had those exits filled" }),
          ]),
        ]),
        el("table", { class: "table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "Bot" }),
              el("th", { text: "Positions" }),
              el("th", { text: "Capital" }),
              el("th", { text: "Forgone profit" }),
            ]),
          ]),
          el(
            "tbody",
            {},
            [...byBot.entries()]
              .sort((a, b) => b[1].profit - a[1].profit)
              .map(([botId, entry]) =>
                el("tr", {}, [
                  el("td", { class: "table__name", text: view.botNames[botId] ?? `Bot ${botId}` }),
                  el("td", { text: count(entry.count) }),
                  el("td", { text: money(entry.cost, { compact: true }) }),
                  el("td", { class: "neg", text: money(entry.profit, { signed: true }) }),
                ]),
              ),
          ),
        ]),
      );
    };

    void load();

    return { dispose: ctx.store.subscribe((reason) => reason === "snapshot" && void load()) };
  },
};

export const pendingOrdersWidget = {
  id: "pendingOrders",
  name: "Resting buy orders",
  group: "Trades",
  description: "Entry orders waiting on the book, and how far the price must move to fill them.",
  defaultSpan: 6,
  defaultRows: 3,
  defaultConfig: { botId: "" },

  tools(instance, ctx) {
    return [select(botOptions(), instance.config.botId, (value) => ctx.setConfig({ botId: value }), "Bot")];
  },

  render(ctx) {
    const load = async () => {
      try {
        const view = await query("dashboard.positions", {
          botId: ctx.config.botId ? Number(ctx.config.botId) : undefined,
        });

        const pending = view.pendingEntries;
        ctx.setMeta(`${count(pending.length)} resting`);

        if (pending.length === 0) return mount(ctx.body, emptyState("No entry orders on the book."));

        mount(
          ctx.body,
          el("table", { class: "table" }, [
            el("thead", {}, [
              el("tr", {}, [
                el("th", { text: "Bot" }),
                el("th", { text: "Symbol" }),
                el("th", { text: "Side" }),
                el("th", { text: "Price" }),
                el("th", { text: "Qty" }),
                el("th", { text: "To fill" }),
                el("th", { text: "Age" }),
              ]),
            ]),
            el(
              "tbody",
              {},
              pending.map((entry) =>
                el("tr", {}, [
                  el("td", { class: "table__name", text: view.botNames[entry.botId] ?? `Bot ${entry.botId}` }),
                  el("td", { text: entry.symbol }),
                  el("td", { text: entry.side }),
                  el("td", { text: price(entry.price) }),
                  el("td", { text: quantity(entry.quantity) }),
                  el("td", {
                    class: "muted",
                    text: entry.distanceToFillPercent === null ? "—" : percent(entry.distanceToFillPercent),
                  }),
                  el("td", { class: "muted", text: duration(entry.ageMs) }),
                ]),
              ),
            ),
          ]),
        );
      } catch (error) {
        mount(ctx.body, emptyState(`Could not load orders: ${error.message}`));
      }
    };

    void load();

    return { dispose: ctx.store.subscribe((reason) => reason === "snapshot" && void load()) };
  },
};

export const tradeWidgets = [closedTradesWidget, openPositionsWidget, abandonedWidget, pendingOrdersWidget];
