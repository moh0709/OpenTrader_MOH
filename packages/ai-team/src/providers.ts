/**
 * Provider-agnostic LLM access.
 *
 * The council used to speak only to Anthropic. This layer lets it reach any
 * backend that matters through two adapters:
 *
 *   anthropic            native SDK (already in llm.ts)
 *   everything else      the OpenAI wire format via fetch — which OpenAI,
 *                        OpenRouter, Google's Gemini endpoint, Ollama and the
 *                        OpenCode gateways all speak
 *
 * Resolution is environment-driven so the daemon needs no UI to reconfigure,
 * and every failure path returns null rather than throwing: a missing key or a
 * dead Ollama must degrade the council to its deterministic members, never
 * block trading.
 */

export type ProviderId =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "gemini"
  | "ollama"
  | "opencode-zen"
  | "opencode-go"
  | "custom";

export type ProviderConfig = {
  id: ProviderId;
  /** Base URL of the OpenAI-compatible API, no trailing slash. */
  baseUrl: string;
  model: string;
  /** Bearer token. Ollama typically runs without one. */
  apiKey?: string;
};

const DEFAULTS: Record<Exclude<ProviderId, "custom">, { baseUrl: string; keyEnv: string[] }> = {
  anthropic: { baseUrl: "https://api.anthropic.com", keyEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] },
  openai: { baseUrl: "https://api.openai.com/v1", keyEnv: ["OPENAI_API_KEY"] },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: ["OPENROUTER_API_KEY"] },
  // Gemini speaks the OpenAI wire format on this compatibility path.
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  // Local runtimes usually need no key at all.
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", keyEnv: [] },
  "opencode-zen": { baseUrl: "https://opencode.ai/zen/v1", keyEnv: ["OPENCODE_ZEN_API_KEY"] },
  "opencode-go": { baseUrl: "https://opencode.ai/go/v1", keyEnv: ["OPENCODE_GO_API_KEY"] },
};

/** Suggested models, used when AI_MODEL does not name one for the provider. */
const FALLBACK_MODELS: Partial<Record<ProviderId, string>> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5",
  openrouter: "openrouter/auto",
  gemini: "gemini-2.5-pro",
  ollama: "qwen3:14b",
};

function firstEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Operator override set from the dashboard. Three states matter:
 *   undefined  — nothing chosen yet; fall through to the environment
 *   null       — the operator explicitly disabled the LLM layer
 *   config     — the operator's saved choice
 */
let runtimeOverride: ProviderConfig | null | undefined = undefined;

/** Apply (or clear, with null) the dashboard's provider choice. Live at once. */
export function setRuntimeProvider(config: ProviderConfig | null) {
  runtimeOverride = config;
}

/** What the operator saved, if anything. Undefined means "not set". */
export function getRuntimeProvider(): ProviderConfig | null | undefined {
  return runtimeOverride;
}


/**
 * Resolve which provider to use.
 *
 * Priority:
 *   1. AI_PROVIDER names one explicitly — it must have credentials (or need none).
 *   2. Otherwise auto-detect: whichever known key is present.
 *   3. AI_BASE_URL (+ optional AI_API_KEY) alone selects `custom`.
 *
 * Returns null when nothing usable is configured — the caller treats that as
 * "run deterministic-only".
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): ProviderConfig | null {
  // The dashboard's AI settings panel wins over the environment: it is the
  // operator's most recent, most explicit choice and applies without a restart.
  if (runtimeOverride !== undefined) return runtimeOverride ? { ...runtimeOverride } : null;

  const forced = env.AI_PROVIDER?.trim() as ProviderId | undefined;
  const genericKey = firstEnv(env, ["AI_API_KEY"]);
  const customBase = env.AI_BASE_URL?.trim();
  const model = env.AI_MODEL?.trim();

  if (forced === "custom") {
    if (!customBase) return null;
    return { id: "custom", baseUrl: customBase.replace(/\/$/, ""), model: model || "", ...(genericKey ? { apiKey: genericKey } : {}) };
  }

  if (forced) {
    const defaults = DEFAULTS[forced];
    if (!defaults) return null;

    const apiKey = genericKey ?? firstEnv(env, defaults.keyEnv);
    if (!apiKey && defaults.keyEnv.length > 0) return null;

    return {
      id: forced,
      baseUrl: customBase ? customBase.replace(/\/$/, "") : defaults.baseUrl,
      model: model || FALLBACK_MODELS[forced] || "",
      ...(apiKey ? { apiKey } : {}),
    };
  }

  // Auto-detect: the first configured provider wins. Ollama's entry has no key
  // requirement, so a local runtime counts as configured only when its base
  // URL was pointed at explicitly — otherwise nothing here would ever pick it.
  for (const id of Object.keys(DEFAULTS) as Exclude<ProviderId, "custom">[]) {
    const defaults = DEFAULTS[id];
    const apiKey = firstEnv(env, defaults.keyEnv);
    const localNoKey = id === "ollama" && Boolean(env.OLLAMA_BASE_URL);

    if (apiKey || localNoKey) {
      return {
        id,
        baseUrl: id === "ollama" && env.OLLAMA_BASE_URL ? env.OLLAMA_BASE_URL.replace(/\/$/, "") : defaults.baseUrl,
        model: model || FALLBACK_MODELS[id] || "",
        ...(apiKey ? { apiKey } : {}),
      };
    }
  }

  return null;
}

export type ChatRequest = {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  /** Ask for JSON output where the backend supports structured responses. */
  json?: boolean;
};

/** A completion and what it cost, where the backend reported a cost. */
export type ChatResult = {
  text: string;
  /**
   * Total tokens billed, or 0 when the backend reported none.
   *
   * Zero means "not reported", not "free" — a caller metering spend should treat
   * an unmetered call as unknown rather than as costless.
   */
  tokens: number;
};

/**
 * Why a completion did not happen.
 *
 * This type exists because the shape it replaces — a bare `null` — cost a
 * production morning. A key sent to the wrong endpoint, an unfunded account and
 * a saturated free tier are three different faults with three different fixes,
 * and all three reached the operator as one sentence guessing at a fourth
 * ("check the key and the model id"). The provider states which it is on every
 * one of those responses; we were reading `response.ok` and discarding the rest.
 */
export type ChatFailure = {
  /** HTTP status, or null when the call never reached the provider. */
  status: number | null;
  /** One operator-facing line, carrying the provider's own words where it gave any. */
  reason: string;
};

export type ChatOutcome = ({ ok: true } & ChatResult) | ({ ok: false } & ChatFailure);

/** How much of the provider's error body to quote back. */
const REASON_BODY_MAX = 240;

/**
 * Anything key-shaped, so a quoted error body cannot become a key disclosure.
 *
 * The body is the provider's reply rather than our request, so it should never
 * contain the bearer token — but "should never" is not a property we can check,
 * and this text is bound for the daemon log and the dashboard.
 */
const KEY_SHAPED = /\b(sk|pk|api|key|tok)[-_][A-Za-z0-9._-]{8,}/gi;

/**
 * Turn a failed HTTP response into something an operator can act on.
 *
 * The mapping is deliberately about *what to do*, not about what the number is
 * called: 402 is not "Payment Required" here, it is "the account has no credit",
 * because that is the sentence that gets someone to the right settings page.
 */
function describeHttpFailure(status: number, body: string): ChatFailure {
  const detail = body.replace(KEY_SHAPED, "[redacted]").trim().slice(0, REASON_BODY_MAX);

  const known =
    status === 401 || status === 403
      ? "the API key was rejected — check it belongs to this provider and base URL"
      : status === 402
        ? "the account has no credit"
        : status === 404
          ? "the model id is not served at this base URL"
          : status === 429
            ? "rate-limited, by your account or by the model's shared free tier"
            : status >= 500
              ? "the provider is failing"
              : "the request was refused";

  return { status, reason: detail ? `HTTP ${status} — ${known}: ${detail}` : `HTTP ${status} — ${known}` };
}

/**
 * One OpenAI-compatible chat completion, with usage where the backend reports
 * it — or the reason it did not happen. A structured-response request that the
 * backend rejects is retried once without it, since support varies even between
 * versions of the same runtime.
 */
export async function chatCompletionDetailed(provider: ProviderConfig, request: ChatRequest): Promise<ChatOutcome> {
  const send = async (payload: Record<string, unknown>): Promise<ChatOutcome> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { ok: false, ...describeHttpFailure(response.status, body) };
      }

      const json = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const text = json.choices?.[0]?.message?.content;
      if (!text) {
        // A 200 with nothing in it is its own diagnosis, and a common one on
        // reasoning models: the whole allowance went on hidden reasoning tokens
        // and the visible message came back empty.
        return {
          ok: false,
          status: response.status,
          reason: `answered ${response.status} with no message content — the model may have spent its ${request.maxTokens}-token allowance on reasoning`,
        };
      }

      const usage = json.usage ?? {};
      const total = usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);

      return { ok: true, text, tokens: Number.isFinite(total) ? total : 0 };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";

      return {
        ok: false,
        status: null,
        reason: aborted
          ? `no answer within ${request.timeoutMs}ms`
          : `could not reach ${provider.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: request.maxTokens,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
  };
  if (request.json) body.response_format = { type: "json_object" };

  const first = await send(body);
  if (first.ok) return first;

  // A failure right after adding response_format may mean the backend does not
  // know that field. Retry plain once before giving up, and report the retry's
  // reason rather than the first one: it describes the request we would
  // actually have sent.
  if (request.json) {
    delete body.response_format;
    return send(body);
  }

  return first;
}

/**
 * The text of one completion, with the reason for failure discarded.
 *
 * The council's LLM strategist and the reflector both want the answer and have
 * nowhere to put a reason — a council member that cannot speak simply abstains,
 * which is the designed behaviour. Anything with an operator in front of it
 * should call `chatCompletionDetailed` and say what went wrong.
 */
export async function chatCompletion(provider: ProviderConfig, request: ChatRequest): Promise<string | null> {
  const outcome = await chatCompletionDetailed(provider, request);
  return outcome.ok ? outcome.text : null;
}

/**
 * Will this configuration actually answer?
 *
 * Deliberately a real completion, not a model listing. Several gateways serve
 * `/models` without authentication — OpenRouter returns its full catalogue of
 * several hundred models to a key that is pure invention — so a listing proves
 * the URL exists and nothing whatever about the credential, the credit balance
 * or the model id. That false green is what let a broken provider sit behind a
 * "Connection OK" message. The only evidence that a provider will answer is
 * asking it to.
 */
export async function probeProvider(provider: ProviderConfig): Promise<ChatOutcome> {
  return chatCompletionDetailed(provider, {
    system: "Reply with the single word OK.",
    user: "ping",
    // Generous enough that a model which emits a few reasoning tokens still
    // produces visible content, small enough to be free in practice.
    maxTokens: 64,
    timeoutMs: 15_000,
  });
}

/** Whether the provider will answer. See `probeProvider` for why this is not a listing. */
export async function checkProvider(provider: ProviderConfig): Promise<boolean> {
  return (await probeProvider(provider)).ok;
}

/** One model as the settings picker needs it: what to send, and what to show. */
export type ModelInfo = {
  /** The id to configure. The only field the daemon actually uses. */
  id: string;
  /** Human name where the provider gives one, otherwise the id. */
  name: string;
  description: string;
  /** True when the provider offers this model at no cost. */
  free: boolean;
  contextLength: number | null;
};

/** One row as it arrives, across every wire shape we have to read. */
type RawModel = {
  id?: string;
  name?: string;
  display_name?: string;
  description?: string;
  context_length?: number;
  context_window?: number;
  pricing?: { prompt?: string | number; completion?: string | number };
};

/**
 * Does this model cost nothing?
 *
 * Two independent signals, because neither is sufficient alone. The word is
 * what an operator scans for and what OpenRouter encodes in the id itself
 * (`…:free`), but plenty of genuinely free models never say so; a zero price is
 * authoritative but only OpenRouter publishes one.
 *
 * The word test is bounded so that "freeform", "freeze" and "Freedom" — all
 * real substrings in real model descriptions — do not read as free.
 */
const FREE_WORD = /(^|[^a-z])free([^a-z]|$)/i;

export function isFreeModel(model: RawModel): boolean {
  const text = [model.id, model.name, model.display_name, model.description].filter(Boolean).join(" ");
  if (FREE_WORD.test(text)) return true;

  const { prompt, completion } = model.pricing ?? {};
  if (prompt === undefined && completion === undefined) return false;

  return Number(prompt ?? 0) === 0 && Number(completion ?? 0) === 0;
}

/**
 * Every model the provider offers, with enough about each to choose between
 * them. Anthropic's API differs in both auth header and payload shape, so it
 * gets its own branch; everything else speaks the OpenAI wire format.
 *
 * Returns an empty list on every failure path rather than throwing — the caller
 * turns that into "the endpoint returned no models", which is what the operator
 * needs to hear whether the key was wrong, the host was down or the response
 * was malformed.
 */
export async function listModelCatalog(provider: ProviderConfig): Promise<ModelInfo[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    let url = `${provider.baseUrl}/models`;
    const headers: Record<string, string> = {};

    if (provider.id === "anthropic") {
      url = `${provider.baseUrl}/v1/models`;
      if (!provider.apiKey) return [];
      headers["x-api-key"] = provider.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (provider.apiKey) {
      headers.authorization = `Bearer ${provider.apiKey}`;
    }

    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return [];

    const json = (await response.json()) as { data?: RawModel[]; models?: RawModel[] };
    const rows = json.data ?? json.models ?? [];

    return rows
      .filter((model): model is RawModel & { id: string } => Boolean(model?.id))
      .map((model) => ({
        id: model.id,
        name: model.name ?? model.display_name ?? model.id,
        description: model.description ?? "",
        free: isFreeModel(model),
        contextLength: model.context_length ?? model.context_window ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Model ids only.
 *
 * Kept because `checkProvider` and the connection test only ever needed to know
 * whether the endpoint answers with anything at all, and neither should have to
 * care what the picker wants to display.
 */
export async function listModels(provider: ProviderConfig): Promise<string[]> {
  return (await listModelCatalog(provider)).map((model) => model.id);
}


