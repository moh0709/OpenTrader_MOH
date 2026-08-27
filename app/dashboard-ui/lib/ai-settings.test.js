import { describe, expect, it } from "vitest";
import { defaultBaseUrl, filterModels, shortContext } from "./ai-settings.js";

const model = (over = {}) => ({
  id: "anthropic/claude-opus-5",
  name: "Claude Opus 5",
  description: "Frontier reasoning model.",
  free: false,
  contextLength: 200_000,
  ...over,
});

const CATALOG = [
  model(),
  model({
    id: "meta-llama/llama-3.1-8b-instruct:free",
    name: "Llama 3.1 8B Instruct (free)",
    description: "Open weights, no cost.",
    free: true,
    contextLength: 131_072,
  }),
  model({ id: "openai/gpt-5", name: "GPT-5", description: "General purpose.", contextLength: 400_000 }),
  model({ id: "google/gemma-2-9b:free", name: "Gemma 2 9B", description: "Small and quick.", free: true, contextLength: 8192 }),
];

describe("filterModels", () => {
  it("returns everything when nothing is asked for", () => {
    expect(filterModels(CATALOG)).toHaveLength(4);
  });

  it("keeps only free models when the filter is on", () => {
    expect(filterModels(CATALOG, { freeOnly: true }).map((m) => m.id)).toEqual([
      "meta-llama/llama-3.1-8b-instruct:free",
      "google/gemma-2-9b:free",
    ]);
  });

  it("searches the id, the name and the description", () => {
    // People look for a model by all three, so all three are matched.
    expect(filterModels(CATALOG, { search: "gpt-5" }).map((m) => m.id)).toEqual(["openai/gpt-5"]);
    expect(filterModels(CATALOG, { search: "Gemma" }).map((m) => m.id)).toEqual(["google/gemma-2-9b:free"]);
    expect(filterModels(CATALOG, { search: "frontier" }).map((m) => m.id)).toEqual(["anthropic/claude-opus-5"]);
  });

  it("ignores case and surrounding whitespace in the search", () => {
    expect(filterModels(CATALOG, { search: "  CLAUDE  " })).toHaveLength(1);
  });

  it("applies the search and the free filter together", () => {
    expect(filterModels(CATALOG, { search: "llama", freeOnly: true }).map((m) => m.id)).toEqual([
      "meta-llama/llama-3.1-8b-instruct:free",
    ]);
    expect(filterModels(CATALOG, { search: "gpt", freeOnly: true })).toEqual([]);
  });

  it("does not mutate the catalogue it was given", () => {
    const before = [...CATALOG];
    filterModels(CATALOG, { search: "gpt", freeOnly: true });

    expect(CATALOG).toEqual(before);
  });
});

describe("shortContext", () => {
  it("abbreviates thousands and millions", () => {
    expect(shortContext(131_072)).toBe("131K");
    expect(shortContext(8192)).toBe("8K");
    expect(shortContext(1_000_000)).toBe("1M");
    expect(shortContext(2_500_000)).toBe("2.5M");
  });

  it("leaves small windows alone", () => {
    expect(shortContext(512)).toBe("512");
  });

  it("says nothing when the provider published nothing", () => {
    // An empty string renders as no element at all, which is the honest answer
    // — better than showing "0K" for a length nobody reported.
    expect(shortContext(null)).toBe("");
    expect(shortContext(undefined)).toBe("");
    expect(shortContext(0)).toBe("");
  });
});

/**
 * These pin the endpoint half of a saved configuration.
 *
 * The bug they guard against: switching provider left the previous provider's
 * base URL in the field, so a configuration could be saved naming one provider
 * and addressing another. It produced a flat refusal on every completion, with
 * a settings panel that looked entirely filled in.
 */
describe("defaultBaseUrl", () => {
  it("gives each provider its own endpoint", () => {
    expect(defaultBaseUrl("openrouter")).toBe("https://openrouter.ai/api/v1");
    expect(defaultBaseUrl("opencode-zen")).toBe("https://opencode.ai/zen/v1");
    expect(defaultBaseUrl("anthropic")).toBe("https://api.anthropic.com");
  });

  it("never hands one provider another's endpoint", () => {
    const ids = ["openrouter", "anthropic", "openai", "gemini", "ollama", "opencode-zen"];
    const urls = ids.map(defaultBaseUrl);

    expect(urls.every(Boolean)).toBe(true);
    expect(new Set(urls).size).toBe(ids.length);
  });

  it("suggests nothing for a custom endpoint or an unknown provider", () => {
    // "custom" means an endpoint we do not know, so there is nothing to reset
    // to and whatever the operator typed has to stand.
    expect(defaultBaseUrl("custom")).toBe("");
    expect(defaultBaseUrl("not-a-provider")).toBe("");
  });
});
