/**
 * Operations widgets: health checks, the live event feed and bot logs.
 *
 * The health panel is the reason this dashboard can be trusted. Everything else
 * reports what the bots did; these checks report whether the machinery that
 * produces those numbers is still working - including whether this very build
 * still carries the paper-exchange fill fix, without which no limit order fills
 * and every other panel would quietly show a fleet that has simply stopped.
 */
import { el, emptyState, mount, select } from "../lib/dom.js";
import { bytes, count, dateTime, timeAgo } from "../lib/format.js";
import { query } from "../lib/api.js";
import { store } from "../lib/store.js";

const STATUS_LABEL = { ok: "OK", warn: "Warning", crit: "Critical", unknown: "Unknown" };

export const healthWidget = {
  id: "health",
  name: "Health",
  group: "Operations",
  description: "Daemon, database, host, exchange, bot liveness and order flow checks.",
  defaultSpan: 6,
  defaultRows: 4,
  singleton: true,
  defaultConfig: { showOk: true },

  tools(instance, ctx) {
    return [
      select(
        [
          { value: "true", label: "All checks" },
          { value: "false", label: "Problems only" },
        ],
        String(instance.config.showOk ?? true),
        (value) => ctx.setConfig({ showOk: value === "true" }),
        "Filter",
      ),
    ];
  },

  render(ctx) {
    const draw = () => {
      const health = ctx.store.data.health;
      if (!health) return mount(ctx.body, emptyState("Running health checks…"));

      const showOk = ctx.config.showOk ?? true;
      const checks = showOk ? health.checks : health.checks.filter((check) => check.status !== "ok");

      ctx.setMeta(
        `${STATUS_LABEL[health.status]} - ${count(health.counts.crit)} critical, ${count(health.counts.warn)} warnings`,
      );

      if (checks.length === 0) {
        return mount(ctx.body, emptyState("Every check is passing."));
      }

      const groups = new Map();
      for (const check of checks) {
        if (!groups.has(check.group)) groups.set(check.group, []);
        groups.get(check.group).push(check);
      }

      const nodes = [];
      for (const [group, items] of groups) {
        nodes.push(el("div", { class: "check__group", text: group }));

        for (const check of items) {
          nodes.push(
            el("div", { class: "check" }, [
              // Status is a dot AND a written value, never colour alone.
              el("span", { class: "check__dot", dataset: { status: check.status } }),
              el("div", {}, [
                el("div", { class: "check__label", text: check.label }),
                check.detail ? el("div", { class: "check__detail", text: check.detail }) : null,
              ]),
              el("span", {
                class: "check__value",
                text: check.value ?? STATUS_LABEL[check.status],
                title: STATUS_LABEL[check.status],
              }),
            ]),
          );
        }
      }

      const db = health.database;

      mount(
        ctx.body,
        ...nodes,
        db?.measuredAt
          ? el("p", {
              class: "small muted",
              style: { marginTop: "12px" },
              text: `Database ${bytes(db.sizeBytes)} - ${count(db.tableCounts.SmartTrade ?? 0)} trades, ${count(db.tableCounts.Order ?? 0)} orders, ${count(db.tableCounts.BotLog ?? 0)} log rows. Measured ${timeAgo(db.measuredAt)}.`,
            })
          : el("p", { class: "small muted", style: { marginTop: "12px" }, text: "Database statistics are still being measured." }),
      );
    };

    draw();

    return { dispose: ctx.store.subscribe((reason) => (reason === "health" || reason === "settings") && draw()) };
  },
};

export const eventsWidget = {
  id: "events",
  name: "Live events",
  group: "Operations",
  description: "Closed deals, bot starts and stops, errors and agent actions as they happen.",
  defaultSpan: 6,
  defaultRows: 3,
  singleton: true,

  render(ctx) {
    // The feed keeps its own rolling buffer: the poller hands over each delta.
    const feed = [];

    const draw = () => {
      if (feed.length === 0) {
        return mount(ctx.body, emptyState("Nothing yet. Events appear here as trades close and bots change state."));
      }

      ctx.setMeta(`${count(feed.length)} recent`);
      const now = Date.now();

      mount(
        ctx.body,
        el(
          "div",
          { class: "feed" },
          feed.map((event) =>
            el("div", { class: "feed__item", dataset: { severity: event.severity }, title: dateTime(event.at) }, [
              el("span", { class: "feed__bar" }),
              el("div", {}, [
                el("div", { class: "feed__title", text: event.title }),
                el("div", { class: "feed__msg", text: event.message }),
              ]),
              el("span", { class: "feed__time", text: timeAgo(event.at, now) }),
            ]),
          ),
        ),
      );
    };

    const onEvents = (events) => {
      feed.unshift(...[...events].reverse());
      feed.length = Math.min(feed.length, 100);
      draw();
    };

    ctx.store.eventListeners = ctx.store.eventListeners ?? new Set();
    ctx.store.eventListeners.add(onEvents);

    draw();

    return {
      dispose: () => {
        ctx.store.eventListeners?.delete(onEvents);
      },
    };
  },
};

export const botLogsWidget = {
  id: "botLogs",
  name: "Bot logs",
  group: "Operations",
  description: "Recent strategy executions, with errors surfaced.",
  defaultSpan: 6,
  defaultRows: 3,
  singleton: true,
  defaultConfig: { botId: "", errorsOnly: false },

  tools(instance, ctx) {
    return [
      select(
        [{ value: "", label: "All bots" }, ...store.visibleBots().map((bot) => ({ value: String(bot.botId), label: bot.name }))],
        instance.config.botId,
        (value) => ctx.setConfig({ botId: value }),
        "Bot",
      ),
      select(
        [
          { value: "false", label: "All entries" },
          { value: "true", label: "Errors only" },
        ],
        String(instance.config.errorsOnly ?? false),
        (value) => ctx.setConfig({ errorsOnly: value === "true" }),
        "Filter",
      ),
    ];
  },

  render(ctx) {
    const load = async () => {
      try {
        const view = await query("dashboard.logs", {
          botId: ctx.config.botId ? Number(ctx.config.botId) : undefined,
          limit: 100,
        });

        const logs = ctx.config.errorsOnly ? view.logs.filter((log) => log.error) : view.logs;
        ctx.setMeta(`${count(logs.length)} entries`);

        if (logs.length === 0) return mount(ctx.body, emptyState("No log entries."));

        const now = Date.now();

        mount(
          ctx.body,
          el("table", { class: "table" }, [
            el("thead", {}, [
              el("tr", {}, [
                el("th", { text: "Bot" }),
                el("th", { text: "Action" }),
                el("th", { text: "Trigger" }),
                el("th", { text: "When" }),
              ]),
            ]),
            el(
              "tbody",
              {},
              logs.map((log) =>
                el("tr", {}, [
                  el("td", { class: "table__name" }, [
                    el("div", { text: log.botName }),
                    log.error ? el("div", { class: "small neg", text: log.error }) : null,
                  ]),
                  el("td", { text: log.action }),
                  el("td", { class: "muted", text: log.triggerEventType ?? "—" }),
                  el("td", { class: "muted", title: dateTime(log.createdAt), text: timeAgo(log.createdAt, now) }),
                ]),
              ),
            ),
          ]),
        );
      } catch (error) {
        mount(ctx.body, emptyState(`Could not load logs: ${error.message}`));
      }
    };

    void load();

    return { dispose: ctx.store.subscribe((reason) => reason === "snapshot" && void load()) };
  },
};

export const opsWidgets = [healthWidget, eventsWidget, botLogsWidget];
