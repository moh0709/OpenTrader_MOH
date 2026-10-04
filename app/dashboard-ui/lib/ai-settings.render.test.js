/**
 * Structural render checks for the AI settings panel.
 *
 * The pure helpers in ai-settings.test.js are well covered; the panel that
 * actually builds the provider `<select>` was not, so a change that broke
 * selection would have passed the whole suite. These assert structure only —
 * that the nodes reach the container and that the option list is well formed —
 * never appearance, which is only true in a real browser.
 *
 * The shim is the same one widgets/research.render.test.js uses, extended with
 * listener capture so a "change" can actually be dispatched. That matters:
 * `mount()` is variadic and silently stringifies non-nodes, so a select that
 * rendered as "[object Object]" would still have "passed" a suite that only
 * looked for the word "Provider" somewhere in the text.
 */
import { beforeEach, describe, expect, it } from "vitest";

const NODE = Symbol("node");

function makeNode(tag) {
  const node = {
    [NODE]: true,
    tagName: tag,
    className: "",
    textContent: "",
    value: "",
    children: [],
    attrs: {},
    dataset: {},
    hidden: false,
    listeners: {},
    style: { setProperty() {} },
    append(...kids) {
      for (const kid of kids) {
        node.children.push(
          kid && kid[NODE] ? kid : { [NODE]: true, tagName: "#text", textContent: String(kid), children: [] },
        );
      }
    },
    setAttribute(key, value) {
      node.attrs[key] = value;
    },
    getAttribute(key) {
      return node.attrs[key];
    },
    addEventListener(type, fn) {
      node.listeners[type] = fn;
    },
    /** Fire a handler the way a user interaction would. */
    dispatch(type) {
      return node.listeners[type]?.({ type, preventDefault() {}, stopPropagation() {} });
    },
    removeChild(child) {
      node.children = node.children.filter((c) => c !== child);
    },
    get firstChild() {
      return node.children[0] ?? null;
    },
  };

  return node;
}

/** Depth-first walk. */
function walk(node, out = []) {
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);

  return out;
}

const byTag = (root, tag) => walk(root).filter((n) => n.tagName === tag);

beforeEach(() => {
  globalThis.document = {
    createElement: makeNode,
    createTextNode: (t) => ({ [NODE]: true, tagName: "#text", textContent: String(t), children: [] }),
  };
  globalThis.window = {
    localStorage: { getItem: () => "test-password", setItem() {}, removeItem() {} },
  };
  globalThis.fetch = async (url) => {
    if (String(url).includes("ai-settings")) return { ok: true, status: 200, json: async () => ({ saved: null }) };

    throw new Error(`no fixture for ${url}`);
  };
});

async function renderPanel() {
  const { renderAiSettings } = await import("./ai-settings.js");
  const container = makeNode("div");
  await renderAiSettings(container);

  return container;
}

describe("the provider select is real and populated", () => {
  it("reaches the container as a select with a labelled option per provider", async () => {
    const panel = await renderPanel();
    const selects = byTag(panel, "select");
    const options = byTag(panel, "option");

    expect(selects.length).toBeGreaterThanOrEqual(1);
    // A placeholder plus every provider on offer.
    expect(options.length).toBeGreaterThanOrEqual(7);
  });

  it("gives every option a value and readable text, not a stringified node", async () => {
    const panel = await renderPanel();
    const options = byTag(panel, "option");

    // The first is the placeholder, which is empty on purpose — that is what
    // makes "no provider chosen" a state the form can still be saved from.
    expect(options[0].attrs.value).toBe("");
    expect(String(options[0].textContent).trim().length).toBeGreaterThan(0);

    for (const option of options.slice(1)) {
      expect(option.attrs.value, "an option with no value cannot be selected").toBeTruthy();
      expect(String(option.textContent)).not.toContain("[object");
      expect(String(option.textContent).trim().length).toBeGreaterThan(0);
    }
  });

  it("never renders a node as [object …] anywhere in the panel", async () => {
    // The exact failure `mount` invites: a variadic call handed the array to
    // Node.append, which stringified it, and the panel rendered its own source
    // instead of its content.
    const panel = await renderPanel();

    for (const node of walk(panel)) {
      expect(String(node.textContent ?? "")).not.toContain("[object ");
    }
  });
});

describe("choosing a provider", () => {
  it("adopts the chosen value and resets the endpoint to that provider's own", async () => {
    const panel = await renderPanel();
    const select = byTag(panel, "select")[0];
    const baseUrl = byTag(panel, "input").find((n) => n.attrs["aria-label"] === "Base URL");
    const model = byTag(panel, "input").find((n) => n.attrs["aria-label"] === "Model");

    expect(baseUrl).toBeDefined();
    expect(model).toBeDefined();

    select.value = "openrouter";
    select.dispatch("change");

    expect(baseUrl.value).toBe("https://openrouter.ai/api/v1");
    // The previous provider's model id must not survive the switch, or the saved
    // configuration names one provider and a model it has never heard of.
    expect(model.value).toBe("");

    select.value = "anthropic";
    select.dispatch("change");

    expect(baseUrl.value).toBe("https://api.anthropic.com");
  });

  it("leaves a custom endpoint alone, because there is nothing to reset it to", async () => {
    const panel = await renderPanel();
    const select = byTag(panel, "select")[0];
    const baseUrl = byTag(panel, "input").find((n) => n.attrs["aria-label"] === "Base URL");

    select.value = "custom";
    select.dispatch("change");

    expect(baseUrl.value).toBe("");
  });
});
