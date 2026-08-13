/**
 * Analytical widgets: equity curve, win/loss, distributions, hold times,
 * activity heatmap and fee impact.
 *
 * The win/loss widget deliberately refuses to show a win rate on its own. A grid
 * bot takes profit above its entry by construction, so realised losses barely
 * happen and the rate reads 100% forever. Setting realised profit beside
 * floating and abandoned profit is the only way that number means anything.
 */
import { el, emptyState, mount, note, select } from "../lib/dom.js";
import { barChart, columnChart, donut, heatmap, legend, lineChart, sequentialLegend } from "../lib/charts.js";
import { count, dateTime, duration, money, pnlClass } from "../lib/format.js";
import { query } from "../lib/api.js";
import { store } from "../lib/store.js";

const BUCKETS = [
  { value: "5m", label: "5 minutes" },
  { value: "15m", label: "15 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "4h", label: "4 hours" },
  { value: "1d", label: "1 day" },
];

function botOptions() {
  return [
    { value: "", label: "All bots" },
    ...store.visibleBots().map((bot) => ({ value: String(bot.botId), label: bot.name })),
  ];
}

/** Shared loader: every widget here reads the same history endpoint. */
function historyWidget({ id, name, description, defaultSpan, defaultRows, buckets = false, draw }) {
  return {
    id,
    name,
    group: "Analytics",
    description,
    defaultSpan,
    defaultRows,
    singleton: true,
    defaultConfig: { botId: "", bucket: "1h" },

    tools(instance, ctx) {
      return [
        select(botOptions(), instance.config.botId, (value) => ctx.setConfig({ botId: value }), "Bot"),
        buckets
          ? select(BUCKETS, instance.config.bucket, (value) => ctx.setConfig({ bucket: value }), "Bucket size")
          : null,
      ].filter(Boolean);
    },

    render(ctx) {
      const load = async () => {
        try {
          const view = await query("dashboard.history", {
            botId: ctx.config.botId ? Number(ctx.config.botId) : undefined,
            bucket: ctx.config.bucket ?? "1h",
          });

          draw(ctx, view);
        } catch (error) {
          mount(ctx.body, emptyState(`Could not load history: ${error.message}`));
        }
      };

      void load();

      return { dispose: ctx.store.subscribe((reason) => reason === "snapshot" && void load()) };
    },
  };
}

export const equityWidget = historyWidget({
  id: "equity",
  name: "Equity curve",
  description: "Cumulative realised profit over time.",
  defaultSpan: 8,
  defaultRows: 3,
  buckets: true,
  draw(ctx, view) {
    const curve = view.equityCurve;
    if (curve.length < 2) return mount(ctx.body, emptyState("Not enough closed trades to plot a curve yet."));

    ctx.setMeta(`${money(view.stats.netPnl, { signed: true })} over ${count(view.stats.trades)} trades`);

    mount(
      ctx.body,
      // One series, so no legend box: the widget title already names it.
      lineChart(
        [{ label: "Cumulative profit", points: curve.map((point) => ({ x: point.t, y: point.cumulative })) }],
        {
          width: 720,
          height: 220,
          area: true,
          zeroLine: true,
          formatY: (value) => money(value, { signed: false }),
          formatX: (value) => dateTime(value),
        },
      ),
    );
  },
});

export const winLossWidget = historyWidget({
  id: "winLoss",
  name: "Win / loss",
  description: "Realised outcomes set against floating and abandoned profit, so a 100% win rate cannot mislead.",
  defaultSpan: 4,
  defaultRows: 3,
  draw(ctx, view) {
    const stats = view.stats;
    if (stats.trades === 0) return mount(ctx.body, emptyState("No closed trades yet."));

    const positions = ctx.store.data.snapshot?.fleet?.positions;
    ctx.setMeta(`${count(stats.trades)} closed`);

    // Three P&L buckets: identity, so categorical slots 1-3 in fixed order.
    const bars = [
      { label: "Realised", value: stats.netPnl, color: "var(--series-1)" },
      { label: "Floating", value: positions?.floatingPnl ?? 0, color: "var(--series-2)" },
      { label: "Abandoned", value: positions?.abandonedProfit ?? 0, color: "var(--series-3)" },
    ];

    mount(
      ctx.body,
      el("div", { style: { display: "flex", gap: "14px", alignItems: "center", flexWrap: "wrap" } }, [
        donut(
          [
            { label: "Wins", value: stats.wins, color: "var(--good)" },
            { label: "Losses", value: stats.losses, color: "var(--critical)" },
            { label: "Breakeven", value: stats.breakeven, color: "var(--text-muted)" },
          ],
          {
            size: 124,
            centerValue: stats.winRate === null ? "—" : `${stats.winRate.toFixed(0)}%`,
            centerLabel: "win rate",
          },
        ),
        el("div", { style: { flex: "1 1 150px", minWidth: "150px" } }, [
          row("Profit factor", stats.profitFactor === null ? "no losses yet" : stats.profitFactor.toFixed(2)),
          row("Average win", money(stats.averageWin, { signed: true }), "pos"),
          row("Average loss", stats.losses === 0 ? "—" : money(-stats.averageLoss, { signed: true }), "neg"),
          row("Expectancy", money(stats.expectancy, { signed: true }), pnlClass(stats.expectancy)),
          row("Best trade", money(stats.bestTrade, { signed: true }), "pos"),
          row("Worst trade", money(stats.worstTrade, { signed: true }), pnlClass(stats.worstTrade)),
          row("Longest win streak", count(stats.maxConsecutiveWins)),
        ]),
      ]),
      el("div", {
        class: "legend",
        style: { marginTop: "4px" },
      }, [
        el("span", { class: "legend__item" }, [
          el("span", { class: "legend__swatch", style: { background: "var(--good)" } }),
          el("span", { text: "Wins" }),
        ]),
        el("span", { class: "legend__item" }, [
          el("span", { class: "legend__swatch", style: { background: "var(--critical)" } }),
          el("span", { text: "Losses" }),
        ]),
      ]),
      el("div", { class: "section-title", text: "Where the money is" }),
      barChart(bars, {
        width: 420,
        rowHeight: 26,
        labelWidth: 78,
        valueWidth: 92,
        formatValue: (value) => money(value, { signed: true }),
        diverging: bars.some((bar) => bar.value < 0),
      }),
      legend(bars.map((bar) => ({ label: bar.label, color: bar.color }))),
      stats.losslessSoFar
        ? note("Nothing has ever closed at a loss, so the win rate carries no information. Judge this fleet on the floating and abandoned bars instead.")
        : null,
    );
  },
});

function row(label, value, valueClass) {
  return el(
    "div",
    { style: { display: "flex", justifyContent: "space-between", gap: "10px", padding: "3px 0", fontSize: "12.5px" } },
    [
      el("span", { class: "muted", text: label }),
      el("span", { class: valueClass ?? "", style: { fontVariantNumeric: "tabular-nums" }, text: value }),
    ],
  );
}

export const distributionWidget = historyWidget({
  id: "pnlDistribution",
  name: "Profit distribution",
  description: "How per-trade profit is spread, so one outlier is not mistaken for the norm.",
  defaultSpan: 6,
  defaultRows: 2,
  draw(ctx, view) {
    const bins = view.pnlDistribution;
    if (bins.length === 0) return mount(ctx.body, emptyState("No closed trades yet."));

    ctx.setMeta(`${count(view.stats.trades)} trades`);

    mount(
      ctx.body,
      columnChart(
        bins.map((bin) => ({
          label: money(bin.from, { signed: true }),
          value: bin.count,
          metaLabel: "Trades",
          meta: { label: "Range", value: `${money(bin.from, { signed: true })} to ${money(bin.to, { signed: true })}` },
        })),
        {
          width: 640,
          height: 180,
          formatValue: (value) => count(Math.round(value)),
          // Losses are a different state, not a different series.
          colorFor: (item, index) => (bins[index].from < 0 ? "var(--critical)" : "var(--series-1)"),
        },
      ),
      el("p", { class: "small muted", style: { marginTop: "6px" }, text: "Each column counts the trades whose net profit fell in that range." }),
    );
  },
});

export const holdTimeWidget = historyWidget({
  id: "holdTime",
  name: "Hold time",
  description: "How long trades are held, and whether holding longer actually pays.",
  defaultSpan: 6,
  defaultRows: 2,
  draw(ctx, view) {
    const buckets = view.holdTimes.filter((bucket) => bucket.count > 0);
    if (buckets.length === 0) return mount(ctx.body, emptyState("No closed trades yet."));

    ctx.setMeta(`avg ${duration(view.stats.averageHoldMs)}`);

    mount(
      ctx.body,
      columnChart(
        buckets.map((bucket) => ({
          label: bucket.label,
          value: bucket.count,
          metaLabel: "Trades",
          meta: { label: "Average profit", value: money(bucket.averagePnl, { signed: true }) },
        })),
        { width: 620, height: 170, formatValue: (value) => count(Math.round(value)) },
      ),
      el("p", {
        class: "small muted",
        style: { marginTop: "6px" },
        text: `Median hold ${duration(view.stats.medianHoldMs)}. Hover a column for the average profit of trades held that long.`,
      }),
    );
  },
});

export const heatmapWidget = historyWidget({
  id: "heatmap",
  name: "Activity heatmap",
  description: "When trades close, by hour and weekday (UTC).",
  defaultSpan: 8,
  defaultRows: 2,
  draw(ctx, view) {
    const cells = view.heatmap;
    const total = cells.reduce((sum, cell) => sum + cell.count, 0);
    if (total === 0) return mount(ctx.body, emptyState("No closed trades yet."));

    ctx.setMeta(`${count(total)} closes`);

    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const max = Math.max(...cells.map((cell) => cell.count));

    mount(
      ctx.body,
      heatmap(
        cells.map((cell) => ({
          row: cell.day,
          column: cell.hour,
          value: cell.count,
          label: `${days[cell.day]} ${String(cell.hour).padStart(2, "0")}:00 UTC`,
          pnl: cell.pnl,
        })),
        {
          columns: 24,
          rows: 7,
          rowLabels: days,
          columnLabels: Array.from({ length: 24 }, (_, hour) => (hour % 6 === 0 ? String(hour) : "")),
          tooltipFor: (cell) => [
            { label: "Trades closed", value: count(cell.value) },
            { label: "Profit", value: money(cell.pnl, { signed: true }) },
          ],
        },
      ),
      sequentialLegend("0", `${max} trades`),
    );
  },
});

export const feesWidget = historyWidget({
  id: "fees",
  name: "Fee impact",
  description: "Gross profit against what the exchange took.",
  defaultSpan: 4,
  defaultRows: 2,
  draw(ctx, view) {
    const fees = view.fees;
    if (view.stats.trades === 0) return mount(ctx.body, emptyState("No closed trades yet."));

    ctx.setMeta(fees.feeRatio === null ? "—" : `${fees.feeRatio.toFixed(1)}% of gross`);

    mount(
      ctx.body,
      barChart(
        [
          { label: "Gross", value: fees.gross, color: "var(--series-1)" },
          { label: "Fees", value: fees.fees, color: "var(--series-2)" },
          { label: "Net", value: fees.net, color: "var(--series-3)" },
        ],
        {
          width: 400,
          rowHeight: 30,
          labelWidth: 56,
          valueWidth: 96,
          formatValue: (value) => money(value, { signed: true }),
        },
      ),
      fees.fees === 0
        ? note("No fees have been charged. This account trades on the paper exchange, which does not model them - live results would be lower.")
        : null,
    );
  },
});

export const analyticsWidgets = [equityWidget, winLossWidget, distributionWidget, holdTimeWidget, heatmapWidget, feesWidget];
