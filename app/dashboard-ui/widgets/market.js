/**
 * Market widgets: the grid ladder and the price-versus-grid view.
 *
 * A grid bot is a set of price levels that each buy and sell repeatedly. Its
 * total profit hides which of those levels is doing the work, so the ladder
 * projects every order and closed trade back onto the rung it belongs to. Read
 * top to bottom, it shows which levels are holding stock, which are waiting to
 * buy, which have earned, and where the live price sits among them.
 */
import { badge, el, emptyState, mount, note, select } from "../lib/dom.js";
import { sequentialColor, sequentialLegend } from "../lib/charts.js";
import { count, money, percent, price, quantity } from "../lib/format.js";
import { query } from "../lib/api.js";
import { store } from "../lib/store.js";

function gridBotOptions() {
  const bots = store.visibleBots().filter((bot) => bot.template === "gridBot" || bot.type !== "DCA");

  return bots.map((bot) => ({ value: String(bot.botId), label: `${bot.name} (${bot.symbol})` }));
}

export const gridLadderWidget = {
  id: "gridLadder",
  name: "Grid ladder",
  group: "Grid & market",
  description: "Every grid level: what it holds, what it is waiting for, and what it has earned.",
  defaultSpan: 6,
  defaultRows: 4,
  defaultConfig: { botId: "" },

  tools(instance, ctx) {
    const options = gridBotOptions();
    const current = instance.config.botId || options[0]?.value || "";

    return [
      select(
        options.length ? options : [{ value: "", label: "No grid bots" }],
        current,
        (value) => ctx.setConfig({ botId: value }),
        "Bot",
      ),
    ];
  },

  render(ctx) {
    const load = async () => {
      const options = gridBotOptions();
      const botId = Number(ctx.config.botId || options[0]?.value || 0);

      if (!botId) return mount(ctx.body, emptyState("No grid bots to show."));

      try {
        const [model] = await query("dashboard.grid", { botId });
        draw(model);
      } catch (error) {
        mount(ctx.body, emptyState(`Could not load the grid: ${error.message}`));
      }
    };

    const draw = (model) => {
      if (!model) return mount(ctx.body, emptyState("No grid data."));

      if (!model.isGrid) {
        return mount(ctx.body, emptyState(`${model.name} is not a grid strategy, so it has no price ladder.`));
      }

      const { levels, totals, markPrice } = model;
      ctx.setMeta(`${count(totals.levels)} levels - ${percent(totals.fillRate, { signed: false, decimals: 0 })} have earned`);

      // Magnitude, so a single-hue ramp; the scale legend below explains it.
      const maxProfit = Math.max(...levels.map((level) => level.realizedPnl), 0);
      const rows = [];
      let markerPlaced = false;

      for (const level of levels) {
        // Drop the live price marker in as soon as we pass it, top down.
        if (!markerPlaced && markPrice !== null && level.price <= markPrice) {
          rows.push(priceMarker(markPrice));
          markerPlaced = true;
        }

        rows.push(ladderRow(level, maxProfit));
      }

      if (!markerPlaced && markPrice !== null) rows.push(priceMarker(markPrice));

      mount(
        ctx.body,
        model.outOfRange
          ? note(
              `The price is ${markPrice > model.upperBound ? "above" : "below"} the configured grid (${price(model.lowerBound)} - ${price(model.upperBound)}). No level can trade until it comes back into range.`,
              "warn",
            )
          : null,
        totals.abandoned > 0
          ? note(`${count(totals.abandoned)} levels are holding stock with no exit order resting against them.`, "warn")
          : null,
        el("div", { class: "ladder" }, rows),
        model.offGridTrades > 0
          ? el("p", {
              class: "small muted",
              style: { marginTop: "10px" },
              text: `${count(model.offGridTrades)} closed trades (${money(model.offGridPnl, { signed: true })}) were entered under a previous grid configuration and match no current level.`,
            })
          : null,
        sequentialLegend("no profit yet", `${money(maxProfit, { signed: true })} best level`),
      );
    };

    const ladderRow = (level, maxProfit) => {
      const share = maxProfit > 0 ? level.realizedPnl / maxProfit : 0;
      const states = [];

      if (level.holding > 0) states.push(badge(`${level.holding} holding`, "info"));
      if (level.abandoned > 0) states.push(badge(`${level.abandoned} stranded`, "warn"));
      if (level.pendingBuys > 0) states.push(badge(`${level.pendingBuys} bid`));

      return el(
        "div",
        {
          class: "ladder__row",
          title: `${price(level.price)} - ${count(level.completedTrades)} trades, ${money(level.realizedPnl, { signed: true })} earned, qty ${quantity(level.quantity)}`,
        },
        [
          el("span", { class: "ladder__price", text: price(level.price) }),
          el("div", { class: "ladder__track" }, [
            // The bar stops at 70% so its label can always sit past the fill on
            // plain track, rather than on a colour whose contrast varies by step.
            level.realizedPnl > 0
              ? el("span", {
                  class: "ladder__fill",
                  style: { width: `${Math.max(3, Math.min(share, 0.7) * 100)}%`, background: sequentialColor(share) },
                })
              : null,
            level.completedTrades > 0
              ? el("span", {
                  class: "ladder__value",
                  style: { left: `calc(${Math.max(3, Math.min(share, 0.7) * 100)}% + 6px)` },
                  text: `${level.completedTrades}x  ${money(level.realizedPnl, { signed: true })}`,
                })
              : null,
          ]),
          el("div", { class: "ladder__state" }, states),
        ],
      );
    };

    const priceMarker = (markPrice) =>
      el("div", { class: "ladder__marker" }, [
        el("span", { style: { textAlign: "right" }, text: price(markPrice) }),
        el("span", { class: "ladder__marker-line" }),
        el("span", { style: { textAlign: "right" }, text: "live" }),
      ]);

    void load();

    return { dispose: ctx.store.subscribe((reason) => reason === "snapshot" && void load()) };
  },
};

export const gridSummaryWidget = {
  id: "gridSummary",
  name: "Grid coverage",
  group: "Grid & market",
  description: "How much of each grid is working, and how far the price has drifted from its range.",
  defaultSpan: 6,
  defaultRows: 2,
  singleton: true,

  render(ctx) {
    const load = async () => {
      try {
        const models = await query("dashboard.grid", {});
        const visible = ctx.store.visibleBotIds();
        draw(models.filter((model) => model.isGrid && visible.has(model.botId)));
      } catch (error) {
        mount(ctx.body, emptyState(`Could not load grids: ${error.message}`));
      }
    };

    const draw = (models) => {
      if (models.length === 0) return mount(ctx.body, emptyState("No grid bots."));

      ctx.setMeta(`${count(models.length)} grids`);

      mount(
        ctx.body,
        el("table", { class: "table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "Bot" }),
              el("th", { text: "Range" }),
              el("th", { text: "Price" }),
              el("th", { text: "Levels used" }),
              el("th", { text: "Holding" }),
              el("th", { text: "Earned" }),
            ]),
          ]),
          el(
            "tbody",
            {},
            models.map((model) =>
              el("tr", {}, [
                el("td", { class: "table__name" }, [
                  el("span", { text: model.name }),
                  model.outOfRange ? el("span", { class: "small neg", text: " out of range" }) : null,
                ]),
                el("td", { class: "muted small", text: `${price(model.lowerBound)} – ${price(model.upperBound)}` }),
                el("td", { text: price(model.markPrice) }),
                el("td", {
                  text: `${count(model.totals.levelsWithFills)}/${count(model.totals.levels)}`,
                }),
                el("td", {}, [
                  el("span", { text: count(model.totals.holding) }),
                  model.totals.abandoned > 0
                    ? el("span", { class: "small neg", text: ` (${count(model.totals.abandoned)} stranded)` })
                    : null,
                ]),
                el("td", { class: model.totals.realizedPnl > 0 ? "pos" : "flat", text: money(model.totals.realizedPnl, { signed: true }) }),
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

export const tickerWidget = {
  id: "tickers",
  name: "Market prices",
  group: "Grid & market",
  description: "Live price per traded symbol, with how fresh each reading is.",
  defaultSpan: 3,
  defaultRows: 2,
  singleton: true,

  render(ctx) {
    const draw = () => {
      const tickers = ctx.store.data.snapshot?.tickers ?? [];
      if (tickers.length === 0) return mount(ctx.body, emptyState("No symbols priced."));

      ctx.setMeta(`${count(tickers.length)} symbols`);

      mount(
        ctx.body,
        el("table", { class: "table" }, [
          el("thead", {}, [el("tr", {}, [el("th", { text: "Symbol" }), el("th", { text: "Price" }), el("th", { text: "Age" })])]),
          el(
            "tbody",
            {},
            tickers.map((ticker) =>
              el("tr", {}, [
                el("td", { text: ticker.symbol }),
                el("td", { text: ticker.last === null ? "—" : price(ticker.last) }),
                el("td", {
                  class: ticker.stale ? "neg" : "muted",
                  text: ticker.error ? "failed" : `${Math.round(ticker.ageMs / 1000)}s`,
                  title: ticker.error ?? "",
                }),
              ]),
            ),
          ),
        ]),
      );
    };

    draw();

    return { dispose: ctx.store.subscribe((reason) => reason === "snapshot" && draw()) };
  },
};

export const marketWidgets = [gridLadderWidget, gridSummaryWidget, tickerWidget];
