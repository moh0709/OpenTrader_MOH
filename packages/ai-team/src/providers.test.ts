import { describe, expect, it } from "vitest";
import { chatCompletion, chatCompletionDetailed, getRuntimeProvider, isFreeModel, listModelCatalog, listModels, migrateProviderChoice, resolveProvider, setRuntimeProvider } from "./providers.js";


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

/**
 * The model catalogue behind the settings picker.
 *
 * Four wire shapes reach this function in practice and none of them agree on
 * more than `id`, so each is pinned with a fixture taken from what the provider
 * actually returns.
 */
describe("isFreeModel", () => {
  it("reads the word in an id, a name or a description", () => {
    expect(isFreeModel({ id: "meta-llama/llama-3.1-8b-instruct:free" })).toBe(true);
    expect(isFreeModel({ id: "x/y", name: "Something (free)" })).toBe(true);
    expect(isFreeModel({ id: "x/y", description: "Free while in preview." })).toBe(true);
  });

  it("does not mistake a longer word for the free one", () => {
    // All three are real substrings in real model descriptions.
    expect(isFreeModel({ id: "x/y", description: "Supports freeform completion." })).toBe(false);
    expect(isFreeModel({ id: "x/y", description: "Does not freeze on long inputs." })).toBe(false);
    expect(isFreeModel({ id: "x/y", name: "Freedom 7B" })).toBe(false);
  });

  it("trusts a zero price even when nothing says free", () => {
    expect(isFreeModel({ id: "x/y", pricing: { prompt: "0", completion: "0" } })).toBe(true);
    expect(isFreeModel({ id: "x/y", pricing: { prompt: "0.0000012", completion: "0" } })).toBe(false);
  });

  it("does not call a model free merely because it publishes no price", () => {
    expect(isFreeModel({ id: "gpt-5" })).toBe(false);
  });
});

describe("listModelCatalog", () => {
  const respondWith = (payload: unknown, ok = true) => {
    const seen: { url: string; headers: Record<string, string> }[] = [];

    globalThis.fetch = (async (url: any, init: any) => {
      seen.push({ url, headers: init?.headers ?? {} });
      return { ok, json: async () => payload };
    }) as any;

    return seen;
  };

  const openai = { id: "openai" as const, baseUrl: "https://example.test/v1", model: "", apiKey: "k" };

  it("reads the bare OpenAI shape, falling back to the id for a name", async () => {
    respondWith({ object: "list", data: [{ id: "gpt-5" }] });

    expect(await listModelCatalog(openai)).toEqual([
      { id: "gpt-5", name: "gpt-5", description: "", free: false, contextLength: null },
    ]);
  });

  it("reads OpenRouter's richer rows, including pricing and context", async () => {
    respondWith({
      data: [
        {
          id: "meta-llama/llama-3.1-8b-instruct:free",
          name: "Llama 3.1 8B Instruct (free)",
          description: "A free endpoint.",
          context_length: 131072,
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "anthropic/claude-opus-5",
          name: "Claude Opus 5",
          description: "Frontier model.",
          context_length: 200000,
          pricing: { prompt: "0.000015", completion: "0.000075" },
        },
      ],
    });

    const models = await listModelCatalog({ ...openai, id: "openrouter" });

    expect(models.map((model) => [model.id, model.free, model.contextLength])).toEqual([
      ["anthropic/claude-opus-5", false, 200000],
      ["meta-llama/llama-3.1-8b-instruct:free", true, 131072],
    ]);
  });

  it("reads Anthropic's display_name, from its own path and header", async () => {
    const seen = respondWith({ data: [{ type: "model", id: "claude-opus-5", display_name: "Claude Opus 5" }] });

    const models = await listModelCatalog({ id: "anthropic", baseUrl: "https://api.test", model: "", apiKey: "sk-a" });

    expect(models[0].name).toBe("Claude Opus 5");
    expect(seen[0].url).toBe("https://api.test/v1/models");
    expect(seen[0].headers["x-api-key"]).toBe("sk-a");
    expect(seen[0].headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("reads the `models` key some runtimes use instead of `data`", async () => {
    respondWith({ models: [{ id: "qwen3:14b" }] });

    expect((await listModelCatalog(openai))[0].id).toBe("qwen3:14b");
  });

  it("drops rows with no id rather than showing a blank choice", async () => {
    respondWith({ data: [{ id: "a" }, { name: "no id here" }, { id: "b" }] });

    expect((await listModelCatalog(openai)).map((model) => model.id)).toEqual(["a", "b"]);
  });

  it("returns nothing on a refused request instead of throwing", async () => {
    respondWith({ error: "unauthorized" }, false);

    await expect(listModelCatalog(openai)).resolves.toEqual([]);
  });

  it("refuses to call Anthropic without a key", async () => {
    const seen = respondWith({ data: [] });

    await expect(listModelCatalog({ id: "anthropic", baseUrl: "https://api.test", model: "" })).resolves.toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

describe("listModels", () => {
  it("still returns just the sorted ids, for the liveness probe", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "zeta" }, { id: "alpha" }] }),
    })) as any;

    expect(await listModels({ id: "openai", baseUrl: "https://x/v1", model: "", apiKey: "k" })).toEqual([
      "alpha",
      "zeta",
    ]);
  });
});

describe("chatCompletionDetailed", () => {
  const provider = { id: "openai" as const, baseUrl: "https://example.test/v1", model: "m1", apiKey: "k" };
  const ask = { system: "s", user: "u", maxTokens: 10, timeoutMs: 1000 };

  const reply = (payload: unknown) => {
    // `status` matters even on the success path: a 200 carrying no message
    // content is reported as a failure *at* 200, which is what distinguishes
    // "the model said nothing" from "the provider refused us".
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => payload })) as any;
  };

  /** A non-2xx, the way a real gateway sends one: status plus an error body. */
  const refuse = (status: number, body = "") => {
    globalThis.fetch = (async () => ({ ok: false, status, text: async () => body })) as any;
  };

  it("reports the total the backend billed", async () => {
    reply({ choices: [{ message: { content: "hi" } }], usage: { total_tokens: 812 } });

    await expect(chatCompletionDetailed(provider, ask)).resolves.toEqual({ ok: true, text: "hi", tokens: 812 });
  });

  it("adds prompt and completion when no total is given", async () => {
    reply({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 700, completion_tokens: 112 } });

    const outcome = await chatCompletionDetailed(provider, ask);
    expect(outcome.ok && outcome.tokens).toBe(812);
  });

  it("reports zero when the backend says nothing about usage", async () => {
    // Zero means "not reported". A meter must not read that as free.
    reply({ choices: [{ message: { content: "hi" } }] });

    const outcome = await chatCompletionDetailed(provider, ask);
    expect(outcome.ok && outcome.tokens).toBe(0);
  });

  /**
   * The regression these exist for: every one of these used to arrive as the
   * same `null`, and the dashboard turned that into one sentence blaming the
   * key and the model id. Three faults, three fixes, one misleading message.
   */
  describe("says which fault it was", () => {
    it("distinguishes a rejected key from an unfunded account", async () => {
      refuse(401, "invalid api key");
      const rejected = await chatCompletionDetailed(provider, ask);
      expect(rejected.ok).toBe(false);
      expect(!rejected.ok && rejected.status).toBe(401);
      expect(!rejected.ok && rejected.reason).toMatch(/key was rejected/i);

      refuse(402, "Insufficient credits. This account never purchased credits.");
      const unfunded = await chatCompletionDetailed(provider, ask);
      expect(!unfunded.ok && unfunded.reason).toMatch(/no credit/i);
      // The provider's own words survive, because they name the account.
      expect(!unfunded.ok && unfunded.reason).toMatch(/never purchased credits/);
    });

    it("names a rate limit and an unknown model id", async () => {
      refuse(429, "temporarily rate-limited upstream");
      const limited = await chatCompletionDetailed(provider, ask);
      expect(!limited.ok && limited.reason).toMatch(/rate-limited/i);

      refuse(404);
      const missing = await chatCompletionDetailed(provider, ask);
      expect(!missing.ok && missing.reason).toMatch(/model id is not served/i);
    });

    it("redacts anything key-shaped out of a quoted error body", async () => {
      refuse(401, "rejected token sk-or-v1-abcdef0123456789 for this account");

      const outcome = await chatCompletionDetailed(provider, ask);
      expect(!outcome.ok && outcome.reason).toContain("[redacted]");
      expect(!outcome.ok && outcome.reason).not.toContain("abcdef0123456789");
    });

    it("separates a 200 with no content from a refusal", async () => {
      reply({ choices: [] });

      const outcome = await chatCompletionDetailed(provider, ask);
      expect(!outcome.ok && outcome.status).toBe(200);
      expect(!outcome.ok && outcome.reason).toMatch(/no message content/i);
    });

    it("reports a timeout as a timeout", async () => {
      globalThis.fetch = (async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }) as any;

      const outcome = await chatCompletionDetailed(provider, ask);
      expect(!outcome.ok && outcome.status).toBeNull();
      expect(!outcome.ok && outcome.reason).toMatch(/no answer within 1000ms/);
    });
  });
});


/**
 * A gateway's status line is the weaker evidence. OpenCode reports a missing
 * payment method as `401 CreditsError`, which read as a rejected key and sent
 * the operator to re-check a credential that was never the problem.
 */
describe("failure reasons", () => {
  const fetchFailing = (status: number, body: string) =>
    async () => new Response(body, { status });

  const reasonFor = async (status: number, body: string) => {
    const original = globalThis.fetch;
    globalThis.fetch = fetchFailing(status, body) as never;
    try {
      const outcome = await chatCompletionDetailed(
        { id: "opencode-zen", baseUrl: "https://api.test", model: "hy3-free", apiKey: "sk-x" },
        { system: "s", user: "u", maxTokens: 8, timeoutMs: 5_000 },
      );
      return outcome.ok ? "" : outcome.reason;
    } finally {
      globalThis.fetch = original;
    }
  };

  it("believes the body over the status when they disagree", async () => {
    const reason = await reasonFor(401, '{"error":{"type":"CreditsError","message":"No payment method."}}');
    expect(reason).toContain("the account has no credit");
    expect(reason).not.toContain("API key was rejected");
  });

  it("still blames the key when the body agrees it is the key", async () => {
    expect(await reasonFor(401, '{"error":{"type":"AuthError","message":"Invalid API key."}}')).toContain(
      "API key was rejected",
    );
  });

  it("names a bad model id rather than the credential", async () => {
    const reason = await reasonFor(401, '{"error":{"type":"ModelError","message":"Model google is not supported"}}');
    expect(reason).toContain("not served at this base URL");
  });

  it("falls back to the status when the body says nothing useful", async () => {
    expect(await reasonFor(401, "nope")).toContain("API key was rejected");
    expect(await reasonFor(503, "")).toContain("the provider is failing");
  });
});

/**
 * OpenCode is one provider now.
 *
 * Zen and Go were the same account and the same key. Zen is the survivor on
 * measured evidence: against an account with no payment method, every Go model
 * returns `CreditsError` while Zen's `-free` models answer normally.
 */
describe("opencode", () => {
  it("resolves to the Zen gateway with a model that answers unfunded", () => {
    const provider = resolveProvider({ AI_PROVIDER: "opencode-zen", OPENCODE_ZEN_API_KEY: "sk-zen" });
    expect(provider?.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(provider?.model).toBe("nemotron-3-ultra-free");
  });

  it("accepts a Go key, since one credential covers both tiers", () => {
    expect(resolveProvider({ AI_PROVIDER: "opencode-zen", OPENCODE_GO_API_KEY: "sk-go" })?.apiKey).toBe("sk-go");
  });

  it("no longer offers go as its own provider", () => {
    expect(resolveProvider({ AI_PROVIDER: "opencode-go", OPENCODE_GO_API_KEY: "sk-go" })).toBeNull();
  });

  it("rewrites the base URL that was never a gateway", () => {
    expect(migrateProviderChoice("opencode-zen", "https://opencode.ai/go/v1")).toMatchObject({
      id: "opencode-zen",
      baseUrl: "https://opencode.ai/zen/v1",
      changed: true,
    });
  });

  it("carries a retired go configuration over to zen, endpoint and all", () => {
    expect(migrateProviderChoice("opencode-go", "https://opencode.ai/zen/go/v1")).toEqual({
      id: "opencode-zen",
      baseUrl: "https://opencode.ai/zen/v1",
      changed: true,
    });
  });

  it("migrates the exact row production was left holding", () => {
    // provider=opencode-go, baseUrl=https://opencode.ai/go/v1 — a retired tier
    // pointed at a URL that never existed.
    expect(migrateProviderChoice("opencode-go", "https://opencode.ai/go/v1")).toEqual({
      id: "opencode-zen",
      baseUrl: "https://opencode.ai/zen/v1",
      changed: true,
    });
  });

  it("never leaves a retired id pointing at its old endpoint", () => {
    expect(migrateProviderChoice("opencode-go", "https://example.test/v1").baseUrl).toBe("https://opencode.ai/zen/v1");
  });

  it("leaves a live provider and a deliberate override alone", () => {
    expect(migrateProviderChoice("opencode-zen", "https://proxy.internal/v1")).toEqual({
      id: "opencode-zen",
      baseUrl: "https://proxy.internal/v1",
      changed: false,
    });
    expect(migrateProviderChoice("openrouter", "https://opencode.ai/go/v1").changed).toBe(false);
  });

  // Keep last in the file: there is no way to return the runtime override to
  // "unset", so this leaves the module in the operator-disabled state.
  it("migrates a restored runtime override so the daemon comes up on a live endpoint", () => {
    setRuntimeProvider({ id: "opencode-go" as never, baseUrl: "https://opencode.ai/go/v1", model: "hy3-free", apiKey: "sk" });
    expect(getRuntimeProvider()).toMatchObject({ id: "opencode-zen", baseUrl: "https://opencode.ai/zen/v1" });
    expect(resolveProvider({})?.baseUrl).toBe("https://opencode.ai/zen/v1");
    setRuntimeProvider(null);
  });
});
