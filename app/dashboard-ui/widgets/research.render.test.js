/**
 * Structural render checks for the Research widgets.
 *
 * The suite is otherwise node-only because layout and animation are only true
 * in a real browser. This file is a deliberate exception: it asserts nothing
 * about appearance, only that the nodes a widget builds actually reach the
 * container.
 *
 * It exists because they once did not. `mount(container, ...children)` is
 * variadic, so `mount(body, [a, b])` handed the array itself to `Node.append()`,
 * which stringifies anything that is not a Node — and every Research widget
 * rendered "[object HTMLDivElement],[object HTMLDivElement]" instead of its
 * content. The shim below reproduces exactly that one behaviour, so the whole
 * class of mistake is caught rather than this single instance.
 */
import { beforeEach, describe, expect, it } from "vitest";

const NODE = Symbol("node");

function makeNode(tag) {
  const node = {
    [NODE]: true,
    tagName: tag,
    className: "",
    textContent: "",
    children: [],
    attrs: {},
    dataset: {},
    style: { setProperty() {} },
    append(...kids) {
      for (const kid of kids) {
        node.children.push(
          kid && kid[NODE]
            ? kid
            : { [NODE]: true, tagName: "#text", textContent: String(kid), children: [] },
        );
      }
    },
    setAttribute(key, value) {
      node.attrs[key] = value;
    },
    addEventListener() {},
    removeChild(child) {
      node.children = node.children.filter((c) => c !== child);
    },
    get firstChild() {
      return node.children[0] ?? null;
    },
  };

  return node;
}

/** Every visible string in a rendered tree. */
function texts(node, out = []) {
  if (node.textContent) out.push(node.textContent);
  for (const child of node.children ?? []) texts(child, out);

  return out;
}

const NOW = Date.now();

const FIXTURES = {
  regime: {
    convictions: [
      {
        symbol: "BTC/USDT",
        stance: "strong_sell",
        confidence: 0.9,
        asOf: NOW,
        ageMs: 5000,
        summary: "Momentum deteriorating across every timeframe.",
      },
    ],
    bots: [
      {
        botId: 1,
        name: "OKX Bronze",
        symbol: "BTC/USDT",
        enabled: true,
        managed: true,
        armed: true,
        baselineMaxCapital: 1000,
        currentMaxCapital: 100,
        minProfit: 3,
        factor: 0.1,
        reduced: true,
        notes: ["strong_sell @ 0.90 confidence", "cap 1000.00 → 100.00"],
      },
    ],
  },
  "regime/runs?limit=40": {
    runs: [
      {
        id: 1,
        symbol: "BTC/USDT",
        trigger: "scheduled",
        status: "ok",
        error: null,
        costUsd: 0.42,
        durationS: 184,
        startedAt: NOW - 60_000,
        endedAt: NOW,
      },
    ],
  },
  "regime/transcript?symbol=BTC%2FUSDT": {
    symbol: "BTC/USDT",
    stance: "strong_sell",
    confidence: 0.9,
    asOf: NOW,
    ratingPm: "Sell",
    ratingRm: "Sell",
    model: "claude-sonnet-5",
    llmCalls: 22,
    analysts: ["market", "news", "social"],
    reports: {
      finalDecision: "**Rating**: Sell\n\n**Executive Summary**: Reduce exposure.\n- Trend broken",
      bullHistory: "The dip is a buying opportunity.",
      bearHistory: "Distribution is obvious here.",
    },
  },
};

beforeEach(() => {
  globalThis.document = {
    createElement: makeNode,
    createTextNode: (t) => ({ [NODE]: true, tagName: "#text", textContent: String(t), children: [] }),
  };
  globalThis.window = {
    localStorage: { getItem: () => "test-password", setItem() {}, removeItem() {} },
  };
  globalThis.fetch = async (url) => {
    const body = FIXTURES[url.replace("/api/dash/", "")];
    if (!body) throw new Error(`no fixture for ${url}`);

    return { ok: true, status: 200, json: async () => body };
  };
});

/** Render one widget to completion and return every string it produced. */
async function renderWidget(widget, config) {
  const body = makeNode("div");
  const handle = widget.render({
    body,
    config: config ?? { ...widget.defaultConfig },
    setConfig() {},
    store: { subscribe: () => () => {} },
  });

  // Widgets load asynchronously and paint on resolution.
  await new Promise((resolve) => setTimeout(resolve, 10));
  handle?.dispose?.();

  return texts(body);
}

describe("Research widgets reach the container", () => {
  it("renders every widget without stringifying its nodes", async () => {
    const { researchWidgets } = await import("./research.js");

    for (const widget of researchWidgets) {
      const rendered = await renderWidget(widget);

      expect(rendered.length, `${widget.id} rendered nothing`).toBeGreaterThan(0);
      expect(
        rendered.filter((t) => t.includes("[object")),
        `${widget.id} stringified its nodes instead of appending them`,
      ).toEqual([]);
    }
  });

  it("renders each conviction as a stance-meter card, not a bare number", async () => {
    const { researchWidgets } = await import("./research.js");
    const board = researchWidgets.find((w) => w.id === "convictionBoard");

    const rendered = await renderWidget(board);

    // The fixture is strong_sell at 90% confidence: both must be visible.
    expect(rendered.some((t) => t.includes("Strong sell"))).toBe(true);
    expect(rendered.some((t) => t.includes("90%"))).toBe(true);
  });

  it("shows both sides of the debate in the Research Room split view", async () => {
    const { researchWidgets } = await import("./research.js");
    const room = researchWidgets.find((w) => w.id === "researchRoom");

    const rendered = await renderWidget(room, { symbol: "BTC/USDT", section: "debate" });

    expect(rendered.filter((t) => t.includes("[object"))).toEqual([]);
    expect(rendered.some((t) => t.includes("Bull case"))).toBe(true);
    expect(rendered.some((t) => t.includes("Bear case"))).toBe(true);
  });

  it("surfaces the two stage ratings that produced the confidence score", async () => {
    const { researchWidgets } = await import("./research.js");
    const room = researchWidgets.find((w) => w.id === "researchRoom");

    const rendered = await renderWidget(room, { symbol: "BTC/USDT", section: "finalDecision" });

    // Both stages rated Sell in the fixture, so the panel should say they agree
    // rather than leaving the confidence figure unexplained.
    expect(rendered.some((t) => t.includes("They agree"))).toBe(true);
  });

  it("falls back to an empty state when the research service is unreachable", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });

    const { researchWidgets } = await import("./research.js");
    const rendered = await renderWidget(researchWidgets.find((w) => w.id === "researchLog"));

    expect(rendered.join(" ")).toContain("research service is not responding");
  });
});
