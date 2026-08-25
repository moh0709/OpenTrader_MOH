/**
 * Overview widgets: the KPI strip, the bot leaderboard and the fleet list.
 *
 * The leaderboard exists in this form because there is no single honest answer
 * to "which bot is best". On a grid fleet the bot with the largest total profit
 * is usually not the one earning most per trade, so the ranking metric is the
 * reader's choice rather than an assertion.
 */
import { badge, el, emptyState, mount, note, select } from "../lib/dom.js";
import { barChart, sparkline } from "../lib/charts.js";
import { count, duration, money, percent, pnlClass, timeAgo } from "../lib/format.js";
import { mutate } from "../lib/api.js";
import { renderWatchers } from "../lib/share.js";
import { toast } from "../lib/toast.js";
import { tick } from "../lib/poller.js";

const METRICS = [
  { value: "netPnl", label: "Total profit" },
  { value: "pnlPercent", label: "Return on capital" },
  { value: "trades", label: "Closed trades" },
  { value: "winRate", label: "Win rate" },
  { value: "averagePnl", label: "Profit per trade" },
  { value: "pnlPerHour", label: "Profit per hour" },
];

/** A stat tile: label, value, optional delta line and 12-point sparkline. */
function stat(label, value, { meta, metaClass, spark, valueClass } = {}) {
  return el("div", { class: "stat" }, [
    el("div", { class: "stat__label", text: label }),
    el("div", { class: `stat__value ${valueClass ?? ""}`.trim(), text: value }),
    meta ? el("div", { class: `stat__meta ${metaClass ?? ""}`.trim(), text: meta }) : null,
    spark && spark.length > 1 ? el("div", { class: "stat__spark" }, [sparkline(spark, { width: 140, height: 22 })]) : null,
  ]);
}

export const kpiWidget = {
  id: "kpi",
  name: "Overview",
  group: "Overview",
  description: "Realised, floating and abandoned profit at a glance, with today and this week.",
  defaultSpan: 12,
  defaultRows: 2,
  singleton: true,
  pinned: true,

  render(ctx) {
    /**
     * Anyone watching a shared feed, shown beside the bot count.
     *
     * Lives in the widget header rather than the body so it survives a redraw
     * of the tiles and sits where you look for what is happening right now.
     */
    const drawWatchers = () => {
      const head = ctx.body.parentElement?.querySelector(".widget__meta");
      if (!head) return;

      let slot = head.parentElement.querySelector(".watchers");
      if (!slot) {
        slot = el("span", { class: "watchers" });
        head.after(slot);
      }

      renderWatchers(slot, ctx.store.data.watchers);
    };

    const draw = () => {
      const snapshot = ctx.store.data.snapshot;
      if (!snapshot) return mount(ctx.body, emptyState("Loading…"));

      const { fleet } = snapshot;
      const realized = fleet.realized;
      const positions = fleet.positions;

      ctx.setMeta(`${count(fleet.enabledBots)}/${count(fleet.bots)} bots running`);
      drawWatchers();

      mount(
        ctx.body,
        el("div", { class: "stat-row" }, [
          stat("Realised profit", money(realized.netPnl, { signed: true }), {
            meta: `${count(realized.trades)} closed trades`,
            valueClass: pnlClass(realized.netPnl),
            spark: fleet.sparkline,
          }),
          stat("Today", money(fleet.today.netPnl, { signed: true }), {
            meta: `${count(fleet.today.trades)} closed - ${count(fleet.week.trades)} this week`,
            valueClass: pnlClass(fleet.today.netPnl),
          }),
          stat("Floating", positions.floatingPnl === null ? "—" : money(positions.floatingPnl, { signed: true }), {
            meta:
              positions.floatingPnl === null
                ? "No live price"
                : `${count(positions.open)} open - ${count(positions.underwater)} underwater`,
            valueClass: pnlClass(positions.floatingPnl),
          }),
          stat("Abandoned profit", money(positions.abandonedProfit, { signed: true }), {
            meta: `${count(positions.abandoned)} positions - ${money(positions.abandonedCostBasis, { compact: true })} stranded`,
            metaClass: positions.abandoned > 0 ? "neg" : "",
          }),
          stat("Capital at work", money(positions.costBasis, { compact: true }), {
            meta: `${money(positions.liveCostBasis, { compact: true })} with a live exit`,
          }),
          stat("Win rate", realized.winRate === null ? "—" : percent(realized.winRate, { signed: false, decimals: 1 }), {
            meta: `${count(realized.wins)}W / ${count(realized.losses)}L`,
          }),
          stat("Avg hold", duration(realized.averageHoldMs), {
            meta: `median ${duration(realized.medianHoldMs)}`,
          }),
        ]),
        realized.losslessSoFar && realized.trades > 0
          ? note(
              `All ${realized.trades} closed trades were wins. That is the expected shape for a grid strategy, whose take profit sits above its entry by construction - so read the floating and abandoned figures, not the win rate, for what is going wrong.`,
            )
          : null,
      );
    };

    draw();

    return {
      dispose: ctx.store.subscribe((reason) => {
        if (reason === "snapshot" || reason === "settings") draw();
        if (reason === "watchers") drawWatchers();
      }),
    };
  },
};

export const leaderboardWidget = {
  id: "leaderboard",
  name: "Bot leaderboard",
  group: "Overview",
  description: "Rank bots by profit, return, trade count, win rate or profit per hour.",
  defaultSpan: 6,
  defaultRows: 3,
  singleton: true,
  defaultConfig: { metric: "netPnl" },

  tools(instance, ctx) {
    return [
      select(
        METRICS,
        instance.config.metric,
        (value) => {
          ctx.setConfig({ metric: value });
          // The server ranks too, so keep the snapshot metric in step.
          ctx.store.updateSettings({ leaderboardMetric: value });
          void tick({ force: true });
        },
        "Ranking metric",
      ),
    ];
  },

  render(ctx) {
    const draw = () => {
      const snapshot = ctx.store.data.snapshot;
      if (!snapshot) return mount(ctx.body, emptyState("Loading…"));

      const metric = ctx.config.metric ?? "netPnl";
      const visible = ctx.store.visibleBotIds();
      const bots = snapshot.bots.filter((bot) => visible.has(bot.botId));

      if (bots.length === 0) return mount(ctx.body, emptyState("No bots to rank."));

      const value = (bot) => {
        switch (metric) {
          case "pnlPercent": return bot.pnlPercent;
          case "trades": return bot.realized.trades;
          case "winRate": return bot.realized.winRate;
          case "averagePnl": return bot.realized.averagePnl;
          case "pnlPerHour": return bot.pnlPerHour;
          default: return bot.realized.netPnl;
        }
      };

      const format = (raw) => {
        if (raw === null || raw === undefined) return "—";
        switch (metric) {
          case "pnlPercent": return percent(raw, { decimals: 3 });
          case "winRate": return percent(raw, { signed: false, decimals: 0 });
          case "trades": return count(raw);
          case "pnlPerHour": return `${money(raw, { signed: true })}/h`;
          default: return money(raw, { signed: true });
        }
      };

      // Bots with no closed trades sort last rather than outranking a losing bot.
      const ranked = [...bots].sort((a, b) => {
        const av = value(a);
        const bv = value(b);
        if (av === null && bv === null) return a.name.localeCompare(b.name);
        if (av === null) return 1;
        if (bv === null) return -1;

        return bv - av || a.name.localeCompare(b.name);
      });

      const top = ranked[0];
      const metricLabel = METRICS.find((m) => m.value === metric)?.label ?? "Total profit";
      ctx.setMeta(`by ${metricLabel.toLowerCase()}`);

      // One series, so a single hue for every bar; the leader is emphasised.
      const items = ranked.map((bot, index) => ({
        label: bot.name,
        value: value(bot) ?? 0,
        color: index === 0 ? "var(--series-1)" : "var(--seq-250)",
        metaLabel: metricLabel,
        meta: { label: "Closed trades", value: count(bot.realized.trades) },
      }));

      mount(
        ctx.body,
        top
          ? el("div", { class: "stat-row", style: { marginBottom: "10px" } }, [
              stat(`Top by ${metricLabel.toLowerCase()}`, top.name, {
                meta: `${top.symbol} - accumulated ${money(top.realized.netPnl, { signed: true })} over ${count(top.realized.trades)} trades`,
                spark: top.sparkline,
              }),
            ])
          : null,
        barChart(items, {
          width: 620,
          rowHeight: 26,
          labelWidth: 132,
          valueWidth: 96,
          formatValue: format,
          diverging: items.some((item) => item.value < 0),
        }),
      );
    };

    draw();

    return { dispose: ctx.store.subscribe((reason) => (reason === "snapshot" || reason === "settings") && draw()) };
  },
};

export const fleetWidget = {
  id: "fleet",
  name: "Bot fleet",
  group: "Overview",
  description: "Every bot with its status, realised and floating profit, and open positions.",
  defaultSpan: 6,
  defaultRows: 3,
  singleton: true,

  render(ctx) {
    const draw = () => {
      const snapshot = ctx.store.data.snapshot;
      if (!snapshot) return mount(ctx.body, emptyState("Loading…"));

      const bots = ctx.store.visibleBots();
      if (bots.length === 0) return mount(ctx.body, emptyState("No bots."));

      ctx.setMeta(`${count(bots.length)} bots`);

      const controls = ctx.store.settings.controlsEnabled;

      const rows = bots.map((bot) =>
        // `data-bot-id` is how the AI action bubbles find this row. Attribute
        // only — nothing about the row's behaviour or appearance depends on it.
        el("tr", { dataset: { botId: String(bot.botId) } }, [
          el("td", { class: "table__name" }, [
            el("div", {}, [
              el("span", { text: bot.name }),
              " ",
              badge(bot.enabled ? "Running" : "Stopped", bot.enabled ? "win" : undefined),
            ]),
            el("div", { class: "small muted", text: `${bot.symbol} - ${bot.template}${bot.timeframe ? ` - ${bot.timeframe}` : ""}` }),
          ]),
          el("td", { class: pnlClass(bot.realized.netPnl), text: money(bot.realized.netPnl, { signed: true }) }),
          el("td", {
            class: pnlClass(bot.positions.floatingPnl),
            text: bot.positions.floatingPnl === null ? "—" : money(bot.positions.floatingPnl, { signed: true }),
          }),
          el("td", { text: count(bot.realized.trades) }),
          el("td", {}, [
            el("span", { text: count(bot.positions.open) }),
            bot.positions.abandoned > 0
              ? el("span", { class: "small neg", text: ` (${count(bot.positions.abandoned)} stranded)` })
              : null,
          ]),
          el("td", { class: "muted small", text: bot.lastFillAt ? timeAgo(bot.lastFillAt) : "never" }),
          controls
            ? el("td", {}, [
                el("button", {
                  class: "btn btn--sm",
                  type: "button",
                  text: bot.enabled ? "Stop" : "Start",
                  onclick: () => controlBot(bot),
                }),
              ])
            : null,
        ]),
      );

      mount(
        ctx.body,
        el("table", { class: "table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "Bot" }),
              el("th", { text: "Realised" }),
              el("th", { text: "Floating" }),
              el("th", { text: "Trades" }),
              el("th", { text: "Open" }),
              el("th", { text: "Last fill" }),
              controls ? el("th", { text: "" }) : null,
            ]),
          ]),
          el("tbody", {}, rows),
        ]),
      );
    };

    draw();

    return { dispose: ctx.store.subscribe((reason) => (reason === "snapshot" || reason === "settings") && draw()) };
  },
};

/**
 * Start or stop a bot.
 *
 * Stopping is not a neutral act: OpenTrader cancels the resting take profit,
 * which leaves any open position with nothing to sell it. The confirmation says
 * so, because that is how the fleet ended up with stranded capital.
 */
async function controlBot(bot) {
  const stopping = bot.enabled;
  const warning = stopping
    ? `\n\nStopping cancels this bot resting exit orders. Any position it is holding (${bot.positions.open} open) will be left without a sell order.`
    : "";

  if (!window.confirm(`${stopping ? "Stop" : "Start"} "${bot.name}" (${bot.symbol})?${warning}`)) return;

  try {
    await mutate(stopping ? "bot.stop" : "bot.start", { botId: bot.botId });
    toast({
      title: stopping ? "Bot stopped" : "Bot started",
      message: bot.name,
      severity: stopping ? "warning" : "info",
    });
    await tick({ force: true });
  } catch (error) {
    toast({ title: "Action failed", message: error.message, severity: "danger" });
  }
}

export const overviewWidgets = [kpiWidget, leaderboardWidget, fleetWidget];
