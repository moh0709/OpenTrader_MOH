/**
 * Research widgets — what the council thinks, what it is doing about it, and
 * the argument it had on the way there.
 *
 * These sit next to the bots deliberately. A conviction that lives on its own
 * page is a research artefact; a conviction next to the capital cap it is
 * holding down is an operating instrument, and the second is what an operator
 * actually needs at the moment they are looking at the fleet.
 *
 * Reads the REST surface at /api/dash/regime* rather than tRPC: those handlers
 * already assemble exactly this view for agents, and duplicating them as tRPC
 * procedures would give the screen a second way to disagree with the API.
 */
import { badge, el, emptyState, mount, note, select } from "../lib/dom.js";
import { getPassword } from "../lib/api.js";
import { duration, timeAgo } from "../lib/format.js";

/** Older than this and the reading is no longer describing today's market. */
const STALE_MS = 26 * 60 * 60 * 1000;

/** Matches the service's RESEARCH_SYMBOLS. */
const SYMBOLS = ["BTC/USDT", "ETH/USDT", "PAXG/USDT"];

async function dash(path) {
  const password = getPassword();
  const response = await fetch(`/api/dash/${path}`, { headers: { authorization: password ?? "" } });

  if (!response.ok) {
    // The transcript and run endpoints proxy the research service, so a 503
    // here means the council is down rather than the dashboard being broken.
    const reason = response.status === 503 ? "the research service is not responding" : `HTTP ${response.status}`;
    throw new Error(reason);
  }

  return response.json();
}

/**
 * Render a list of nodes into a widget body.
 *
 * `mount(container, ...children)` is variadic, so `mount(body, [a, b])` passes
 * the array itself as one child — and `Node.append()` stringifies anything that
 * is not a Node, which puts "[object HTMLDivElement]" on screen instead of the
 * content. Every multi-part render here goes through a single container.
 */
function panel(body, children) {
  return mount(body, el("div", { class: "rsrch-stack" }, children));
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
  return stance === "sell" || stance === "strong_sell" ? "neg" : "";
}

/**
 * Render council prose without a markdown parser.
 *
 * The agents write `**Section**: body` headers and `- ` bullets. Lifting those
 * two shapes out keeps the structure of a long report legible; everything else
 * stays a paragraph. Text goes through `el`, so it is set as textContent and
 * model output can never reach the page as markup.
 */
function prose(text) {
  if (!text || !String(text).trim()) return [el("p", { class: "muted", text: "Nothing recorded for this section." })];

  const nodes = [];

  for (const raw of String(text).split(/\n{2,}|\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const header = line.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
    if (header) {
      nodes.push(el("div", { class: "rsrch-h", text: header[1] }));
      if (header[2]) nodes.push(el("p", { text: header[2] }));
      continue;
    }

    if (/^[-*•]\s+/.test(line)) {
      nodes.push(el("li", { text: line.replace(/^[-*•]\s+/, "") }));
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      nodes.push(el("div", { class: "rsrch-h", text: line.replace(/^#{1,6}\s+/, "") }));
      continue;
    }

    nodes.push(el("p", { text: line }));
  }

  return nodes;
}

// --- Conviction board -------------------------------------------------------

export const convictionBoardWidget = {
  id: "convictionBoard",
  name: "Council convictions",
  group: "Research",
  description: "The research council's current read per symbol, how confident it is, and how long ago it looked.",
  defaultSpan: 6,
  defaultRows: 4,
  defaultConfig: {},

  render(ctx) {
    const load = async () => {
      let payload;
      try {
        payload = await dash("regime");
      } catch (error) {
        return mount(ctx.body, emptyState(`Could not load convictions — ${error.message}`));
      }

      const convictions = payload.convictions ?? [];
      if (convictions.length === 0) {
        return mount(ctx.body, emptyState("No convictions yet. The council has not produced a reading for any symbol."));
      }

      const rows = convictions
        .slice()
        .sort((a, b) => a.symbol.localeCompare(b.symbol))
        .map((c) => {
          const stale = c.ageMs > STALE_MS;

          return el("tr", {}, [
            el("td", { class: "rsrch-mono", text: c.symbol }),
            el("td", {}, [el("span", { class: stanceTone(c.stance), text: STANCE_LABEL[c.stance] ?? c.stance })]),
            // Confidence is the depth of any reduction, so it belongs beside
            // the stance rather than buried in the summary.
            el("td", { class: "rsrch-num", text: `${Math.round((c.confidence ?? 0) * 100)}%` }),
            el("td", {}, [
              stale ? badge(`${timeAgo(c.asOf)} — stale`, "warn") : el("span", { class: "muted", text: timeAgo(c.asOf) }),
            ]),
            el("td", { class: "rsrch-wrap muted", text: c.summary || "—" }),
          ]);
        });

      panel(ctx.body, [
        note("A bullish or neutral reading changes nothing: the governor is only able to reduce risk, never add it."),
        el("table", { class: "table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "Symbol" }),
              el("th", { text: "Stance" }),
              el("th", { text: "Confidence" }),
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

// --- Regime impact ----------------------------------------------------------

export const regimeImpactWidget = {
  id: "regimeImpact",
  name: "Regime impact",
  group: "Research",
  description: "What the governor is holding each bot's capital cap at, against the baseline you set, and why.",
  defaultSpan: 6,
  defaultRows: 4,
  defaultConfig: {},

  render(ctx) {
    const load = async () => {
      let payload;
      try {
        payload = await dash("regime");
      } catch (error) {
        return mount(ctx.body, emptyState(`Could not load regime state — ${error.message}`));
      }

      const bots = (payload.bots ?? []).filter((b) => b.managed);
      if (bots.length === 0) {
        return mount(ctx.body, emptyState("No bots are under regime management. Set a policy to bring one under it."));
      }

      const throttled = bots.filter((b) => b.reduced).length;

      const rows = bots.map((bot) => {
        const baseline = bot.baselineMaxCapital;
        const current = bot.currentMaxCapital;

        return el("tr", {}, [
          el("td", { text: bot.name }),
          el("td", { class: "rsrch-mono muted", text: bot.symbol }),
          el("td", { class: "rsrch-num muted", text: baseline === null ? "—" : baseline.toFixed(0) }),
          el("td", {}, [
            bot.reduced
              ? badge(current === null ? "—" : current.toFixed(0), "warn")
              : el("span", { class: "rsrch-num", text: current === null ? "—" : current.toFixed(0) }),
          ]),
          el("td", {}, [
            !bot.armed
              ? badge("disarmed", "warn")
              : bot.reduced
                ? el("span", { class: "neg", text: `${Math.round(bot.factor * 100)}% of baseline` })
                : el("span", { class: "muted", text: "at baseline" }),
          ]),
          // The governor records why it clamped; showing it here is what makes
          // a cap change auditable without going to the logs.
          el("td", { class: "rsrch-wrap muted", text: (bot.notes ?? []).join("; ") || "—" }),
        ]);
      });

      panel(ctx.body, [
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
              el("th", { text: "Baseline" }),
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

// --- Research Room ----------------------------------------------------------

/** Transcript sections, in the order the council actually produces them. */
const SECTIONS = [
  { value: "finalDecision", label: "Final decision" },
  { value: "debate", label: "Bull vs bear" },
  { value: "investmentPlan", label: "Research plan" },
  { value: "traderPlan", label: "Trader plan" },
  { value: "riskJudge", label: "Risk judgement" },
  { value: "market", label: "Market analyst" },
  { value: "news", label: "News analyst" },
  { value: "sentiment", label: "Sentiment analyst" },
  { value: "fundamentals", label: "Fundamentals analyst" },
];

export const researchRoomWidget = {
  id: "researchRoom",
  name: "Research Room",
  group: "Research",
  description: "The full analyst reports and the bull/bear debate behind a symbol's latest conviction.",
  defaultSpan: 12,
  defaultRows: 8,
  defaultConfig: { symbol: "BTC/USDT", section: "finalDecision" },

  tools(instance, ctx) {
    return [
      select(
        SYMBOLS.map((s) => ({ value: s, label: s })),
        instance.config.symbol || "BTC/USDT",
        (value) => ctx.setConfig({ symbol: value }),
        "Symbol",
      ),
      select(
        SECTIONS,
        instance.config.section || "finalDecision",
        (value) => ctx.setConfig({ section: value }),
        "Section",
      ),
    ];
  },

  render(ctx) {
    const load = async () => {
      const symbol = ctx.config.symbol || "BTC/USDT";
      const section = ctx.config.section || "finalDecision";

      let payload;
      try {
        payload = await dash(`regime/transcript?symbol=${encodeURIComponent(symbol)}`);
      } catch (error) {
        return mount(ctx.body, emptyState(`No transcript for ${symbol} — ${error.message}`));
      }

      const reports = payload.reports ?? {};

      const header = note(
        `${STANCE_LABEL[payload.stance] ?? payload.stance} @ ${Math.round((payload.confidence ?? 0) * 100)}% · ` +
          `${payload.analysts?.length ?? 0} analysts · ${payload.llmCalls ?? 0} model calls · ` +
          `${payload.model ?? "unknown model"} · ${timeAgo(payload.asOf)}`,
      );

      // The two ratings are the whole confidence model: agreement between the
      // research manager and the portfolio manager is the evidence, so showing
      // them makes the number checkable rather than something to take on faith.
      const ratings = note(
        payload.ratingRm && payload.ratingPm
          ? `Research manager rated ${payload.ratingRm}; portfolio manager rated ${payload.ratingPm}. ` +
            (payload.ratingRm === payload.ratingPm
              ? "They agree, which is what produced the confidence above."
              : "They disagree, which is why confidence is below full.")
          : "Only one stage produced a readable rating, so confidence is capped at 50%.",
      );

      if (section === "debate") {
        return panel(ctx.body, [
          header,
          ratings,
          el("div", { class: "rsrch-split" }, [
            el("div", {}, [
              el("div", { class: "rsrch-side__head rsrch-side__head--bull", text: "Bull case" }),
              el("div", { class: "rsrch-doc" }, prose(reports.bullHistory)),
            ]),
            el("div", {}, [
              el("div", { class: "rsrch-side__head rsrch-side__head--bear", text: "Bear case" }),
              el("div", { class: "rsrch-doc" }, prose(reports.bearHistory)),
            ]),
          ]),
        ]);
      }

      panel(ctx.body, [header, ratings, el("div", { class: "rsrch-doc" }, prose(reports[section]))]);
    };

    void load();

    return { dispose: ctx.store.subscribe((reason) => reason === "snapshot" && void load()) };
  },
};

// --- Research log -----------------------------------------------------------

export const researchLogWidget = {
  id: "researchLog",
  name: "Research log",
  group: "Research",
  description: "Recent council runs: what ran, how long it took, what it cost and whether it succeeded.",
  defaultSpan: 6,
  defaultRows: 4,
  defaultConfig: {},

  render(ctx) {
    const load = async () => {
      let payload;
      try {
        payload = await dash("regime/runs?limit=40");
      } catch (error) {
        return mount(ctx.body, emptyState(`Could not load runs — ${error.message}`));
      }

      const runs = payload.runs ?? [];
      if (runs.length === 0) {
        return mount(ctx.body, emptyState("No council runs recorded yet."));
      }

      const spend = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      const failures = runs.filter((r) => r.status === "error").length;

      const rows = runs.map((run) =>
        el("tr", {}, [
          el("td", { class: "muted", text: timeAgo(run.startedAt) }),
          el("td", { class: "rsrch-mono", text: run.symbol }),
          el("td", { class: "muted", text: run.trigger }),
          el("td", {}, [
            run.status === "ok"
              ? badge("ok", "win")
              : run.status === "error"
                ? badge("failed", "loss")
                : badge(run.status, "info"),
          ]),
          el("td", { class: "rsrch-num muted", text: run.durationS ? duration(run.durationS * 1000) : "—" }),
          // Cost is priced from a table that only knows Anthropic models, so a
          // run on another backend reports nothing rather than a made-up figure.
          el("td", { class: "rsrch-num muted", text: run.costUsd ? `$${run.costUsd.toFixed(3)}` : "—" }),
          el("td", { class: "rsrch-wrap muted", text: run.error || "" }),
        ]),
      );

      panel(ctx.body, [
        note(
          failures > 0
            ? `${runs.length} runs shown, ${failures} failed. Spend across them: $${spend.toFixed(2)}.`
            : `${runs.length} runs shown, all succeeded. Spend across them: $${spend.toFixed(2)}.`,
          failures > 0 ? "warn" : undefined,
        ),
        el("table", { class: "table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "When" }),
              el("th", { text: "Symbol" }),
              el("th", { text: "Trigger" }),
              el("th", { text: "Status" }),
              el("th", { text: "Took" }),
              el("th", { text: "Cost" }),
              el("th", { text: "Error" }),
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

export const researchWidgets = [
  convictionBoardWidget,
  regimeImpactWidget,
  researchRoomWidget,
  researchLogWidget,
];
