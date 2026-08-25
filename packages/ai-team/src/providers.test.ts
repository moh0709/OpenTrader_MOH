import { describe, expect, it } from "vitest";
import { chatCompletion, resolveProvider } from "./providers.js";


/**
 * Provider resolution. Pure: no network, no ambient state beyond the env passed in.
 */
describe("resolveProvider", () => {
  it("returns null when nothing is configured", () => {
    expect(resolveProvider({})).toBeNull();
  });

  it("honours an explicit provider with its key", () => {
    const provider = resolveProvider({ AI_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-x" });
    expect(provider?.id).toBe("openrouter");
    expect(provider?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(provider?.apiKey).toBe("sk-or-x");
  });

  it("refuses an explicit provider without credentials", () => {
    expect(resolveProvider({ AI_PROVIDER: "openai" })).toBeNull();
  });

  it("allows a keyless local ollama", () => {
    const provider = resolveProvider({ AI_PROVIDER: "ollama", AI_MODEL: "llama3" });
    expect(provider?.id).toBe("ollama");
    expect(provider?.model).toBe("llama3");
    expect(provider?.apiKey).toBeUndefined();
  });

  it("requires a base url for the custom provider", () => {
    expect(resolveProvider({ AI_PROVIDER: "custom", AI_API_KEY: "k" })).toBeNull();
    expect(resolveProvider({ AI_PROVIDER: "custom", AI_API_KEY: "k", AI_BASE_URL: "http://x/v1/" })?.baseUrl).toBe(
      "http://x/v1",
    );
  });

  it("auto-detects gemini through either google key name", () => {
    expect(resolveProvider({ GOOGLE_API_KEY: "g" })?.id).toBe("gemini");
    expect(resolveProvider({ GEMINI_API_KEY: "g" })?.id).toBe("gemini");
  });
});

/**
 * Request shaping against a stubbed fetch. The wire format is the contract
 * every non-Anthropic backend is held to, so it is worth pinning down.
 */
describe("chatCompletion", () => {
  const provider = { id: "openai" as const, baseUrl: "https://example.test/v1", model: "m1", apiKey: "secret" };

  it("posts system+user messages and returns the reply text", async () => {
    let captured: { url: string; headers: Record<string, string>; body: any } | null = null;
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "{\"signal\":\"hold\"}" } }] }),
      };
    }) as any;

    const text = await chatCompletion(provider, { system: "s", user: "u", maxTokens: 10, timeoutMs: 1000 });
    expect(text).toBe('{"signal":"hold"}');
    expect(captured!.url).toBe("https://example.test/v1/chat/completions");
    expect(captured!.headers.authorization).toBe("Bearer secret");
    expect(captured!.body.model).toBe("m1");
    expect(captured!.body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]);
  });

  it("retries once without response_format when the first attempt fails", async () => {
    let calls: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) return { ok: false, status: 400 };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    }) as any;

    const text = await chatCompletion(provider, { system: "s", user: "u", maxTokens: 5, timeoutMs: 1000, json: true });
    expect(text).toBe("ok");
    expect("response_format" in calls[0]).toBe(true);
    expect("response_format" in calls[1]).toBe(false);
  });

  it("returns null on an unreachable backend instead of throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as any;

    await expect(chatCompletion(provider, { system: "s", user: "u", maxTokens: 5, timeoutMs: 100 })).resolves.toBeNull();
  });
});
