/**
 * Research widgets — what the council thinks, and what it is doing about it.
 *
 * These sit next to the bots deliberately. A conviction that lives on its own
 * page is a research artefact; a conviction next to the capital cap it is
 * holding down is an operating instrument, and the second is what an operator
 * actually needs at the moment they are looking at the fleet.
 *
 * Reads the REST surface at /api/dash/regime rather than tRPC: those handlers
 * already assemble exactly this view for agents, and duplicating them as tRPC
 * procedures would give the screen a second way to disagree with the API.
 */
import { badge, el, emptyState, mount, note } from "../lib/dom.js";
import { getPassword } from "../lib/api.js";
import { timeAgo } from "../lib/format.js";

/** Older than this and the reading is no longer describing today's market. */
const STALE_MS = 26 * 60 * 60 * 1000;

async function dash(path, options = {}) {
  const password = getPassword();
  const response = await fetch(`/api/dash/${path}`, {
    ...options,
    headers: { authorization: password ?? "", ...options.headers },
  });

  if (!response.ok) throw new Error(`regime request failed with HTTP ${response.status}`);

  return response.json();
}

const STANCE_LABEL = {
  strong_buy: "Strong buy",
  buy: "Buy",
  hold: "Hold",
  sell: "Sell",
  strong_sell: "Strong sell",
};

/**
 * Green for bullish, red for bearish — but only where the colour is honest.
 *
 * A bullish stance never moves anything (the governor cannot raise a cap), so
 * it is deliberately not painted as an action. Only the bearish half earns a
 * colour, because only the bearish half does something.
 */
function stanceTone(stance) {
  if (stance === "sell" || stance === "strong_sell") return "neg";
  return "";
}

export const convictionBoardWidget = {
  id: "convictionBoard",
  name: "Council convictions",
  group: "Research",
  description:
    "The research council's current read per symbol, how confident it is, and how long ago it looked.",
  defaultSpan: 6,
  defaultRows: 4,
  defaultConfig: {},

  render(ctx) {
    const load = async () => {
      let payload;
      try {
        payload = await dash("regime");
      } catch (error) {
        mount(ctx.body, emptyState(`Could not reach the regime API — ${error.message}`));
        return;
      }

      const convictions = payload.convictions ?? [];
      if (convictions.length === 0) {
        mount(
          ctx.body,
          emptyState("No convictions yet. The council has not produced a reading for any symbol."),
        );
        return;
      }

      const rows = convictions
        .slice()
        .sort((a, b) => a.symbol.localeCompare(b.symbol))
        .map((c) => {
          const stale = c.ageMs > STALE_MS;

          return el("tr", {}, [
            el("td", { class: "mono", text: c.symbol }),
            el("td", {}, [
              el("span", { class: stanceTone(c.stance), text: STANCE_LABEL[c.stance] ?? c.stance }),
            ]),
            // Confidence is the depth of any reduction, so it belongs beside the
            // stance rather than buried in the summary.
            el("td", { class: "num", text: `${Math.round((c.confidence ?? 0) * 100)}%` }),
            el("td", {}, [
              stale
                ? badge(`${timeAgo(c.asOf)} — stale`, "warn")
                : el("span", { class: "muted", text: timeAgo(c.asOf) }),
            ]),
            el("td", { class: "wrap muted", text: c.summary || "—" }),
          ]);
        });

      mount(ctx.body, [
        note(
          "A bullish or neutral reading changes nothing: the governor is only able to reduce risk, never add it.",
        ),
        el("table", { class: "table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "Symbol" }),
              el("th", { text: "Stance" }),
              el("th", { class: "num", text: "Confidence" }),
              el("th", { text: "As of" }),
              el("th", { text: "Summary" }),
            ]),
          ]),
          el("tbody", {}, rows),
        ]),
      ]);
    };

    void load();

    return { dispose: ctx.store.subscribe((reason) => reason === "snapshot" && void load()) };
  },
};

export const regimeImpactWidget = {
  id: "regimeImpact",
  name: "Regime impact",
  group: "Research",
  description:
    "What the governor is holding each bot's capital cap at, against the baseline you set, and why.",
  defaultSpan: 6,
  defaultRows: 4,
  defaultConfig: {},

  render(ctx) {
    const load = async () => {
      let payload;
      try {
        payload = await dash("regime");
      } catch (error) {
        mount(ctx.body, emptyState(`Could not reach the regime API — ${error.message}`));
        return;
      }

      const bots = (payload.bots ?? []).filter((b) => b.managed);
      if (bots.length === 0) {
        mount(
          ctx.body,
          emptyState("No bots are under regime management. Set a policy to bring one under it."),
        );
        return;
      }

      const throttled = bots.filter((b) => b.reduced).length;

      const rows = bots.map((bot) => {
        const baseline = bot.baselineMaxCapital;
        const current = bot.currentMaxCapital;

        return el("tr", {}, [
          el("td", { text: bot.name }),
          el("td", { class: "mono muted", text: bot.symbol }),
          el("td", { class: "num muted", text: baseline === null ? "—" : baseline.toFixed(0) }),
          el("td", {}, [
            bot.reduced
              ? badge(`${current === null ? "—" : current.toFixed(0)}`, "warn")
              : el("span", { class: "num", text: current === null ? "—" : current.toFixed(0) }),
          ]),
          el("td", {}, [
            !bot.armed
              ? badge("disarmed", "warn")
              : bot.reduced
                ? el("span", { class: "neg", text: `${Math.round(bot.factor * 100)}% of baseline` })
                : el("span", { class: "muted", text: "at baseline" }),
          ]),
          // The governor records why it clamped; showing it here is what makes a
          // cap change auditable without going to the logs.
          el("td", { class: "wrap muted", text: (bot.notes ?? []).join("; ") || "—" }),
        ]);
      });

      mount(ctx.body, [
        note(
          throttled > 0
            ? `${throttled} of ${bots.length} managed bots are throttled below baseline. Open positions keep their exits and close normally.`
            : `${bots.length} managed bots, all at baseline. The governor is not reducing anything right now.`,
          throttled > 0 ? "warn" : undefined,
        ),
        el("table", { class: "table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "Bot" }),
              el("th", { text: "Symbol" }),
              el("th", { class: "num", text: "Baseline" }),
              el("th", { text: "Cap now" }),
              el("th", { text: "State" }),
              el("th", { text: "Reason" }),
            ]),
          ]),
          el("tbody", {}, rows),
        ]),
      ]);
    };

    void load();

    return { dispose: ctx.store.subscribe((reason) => reason === "snapshot" && void load()) };
  },
};

export const researchWidgets = [convictionBoardWidget, regimeImpactWidget];
