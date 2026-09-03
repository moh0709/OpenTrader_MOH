import Anthropic from "@anthropic-ai/sdk";
import { logger } from "@opentrader/logger";
import { atrPercent, closes, rsi, slopePercent, sma } from "./indicators.js";
import { chatCompletion, resolveProvider } from "./providers.js";
import { clampConfidence, type AgentOpinion, type MarketSnapshot, type Signal } from "./types.js";

export type LlmEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type LlmConfig = {
  enabled: boolean;
  model: string;
  effort: LlmEffort;
  /** Per-request timeout in milliseconds. The SDK measures timeouts in ms. */
  timeoutMs: number;
  maxTokens: number;
  /**
   * SDK retry count. Kept low deliberately: the strategy loop awaits this call,
   * and worst-case wall time is timeoutMs × (maxRetries + 1). A bot that stalls
   * for a minute waiting on an opinion is worse than one that trades without it.
   */
  maxRetries: number;
};

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  enabled: false,
  model: "claude-opus-5",
  effort: "medium",
  timeoutMs: 12_000,
  maxTokens: 16_000,
  maxRetries: 1,
};

/**
 * Build LLM config from the environment.
 *
 * Enabled when credentials are visible (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`)
 * or when `HYBRID_LLM=1` forces it on — the latter covers an `ant auth login`
 * profile, which the SDK resolves without any env var being set.
 */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const forced = env.HYBRID_LLM === "1";
  const hasCredentials = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);

  return {
    enabled: env.HYBRID_LLM === "0" ? false : forced || hasCredentials,
    model: env.HYBRID_LLM_MODEL || DEFAULT_LLM_CONFIG.model,
    effort: (env.HYBRID_LLM_EFFORT as LlmEffort) || DEFAULT_LLM_CONFIG.effort,
    timeoutMs: Number(env.HYBRID_LLM_TIMEOUT_MS) || DEFAULT_LLM_CONFIG.timeoutMs,
    maxTokens: Number(env.HYBRID_LLM_MAX_TOKENS) || DEFAULT_LLM_CONFIG.maxTokens,
    maxRetries: Number(env.HYBRID_LLM_MAX_RETRIES) || DEFAULT_LLM_CONFIG.maxRetries,
  };
}

/**
 * Stable across every request so it can sit behind a cache breakpoint —
 * only the market snapshot below it changes per tick.
 */
const SYSTEM_PROMPT = `You are the senior market strategist on an automated crypto trading desk.

Each turn you receive a compact snapshot of one market: recent candles summarised into
indicators, and — when available — a fully-costed cross-venue arbitrage evaluation.
You return a single trading opinion as structured JSON.

How your opinion is used:
- You are one voice among several. Deterministic trend, mean-reversion, and arbitrage
  agents vote alongside you, and their opinions are weighted against yours.
- A separate risk governor enforces position sizing and loss limits in code after the
  vote. You cannot widen a limit, increase a position, or override a halt. Do not try;
  argue the market, not the risk budget.
- Your rationale is written to the trade log and read by a human afterwards. Make it
  specific enough to audit: name the levels and readings you acted on.

How to judge:
- Weigh trend and mean-reversion evidence against each other rather than picking one.
  When a strong trend and an extreme oscillator disagree, that conflict usually argues
  for a lower confidence, not a coin flip.
- Volatility widens the distribution of outcomes. High ATR should lower your confidence
  in any directional call, not raise it.
- An arbitrage edge that survived depth, fee, and staleness checks is a materially
  stronger reason to act than any directional read, because its profit does not depend
  on predicting direction. Say so when you see one.
- Thin evidence is a real answer. "hold" with low confidence is the correct output when
  the snapshot does not support a call, and it costs the desk nothing.
- Some snapshots carry evidence computed outside this desk: an external technical rating
  across several timeframes, a deep research council's standing view, and a market-wide
  sentiment index. Treat these as genuine corroboration when they agree with the
  indicators, and as a reason to lower confidence when they do not. Timeframes
  disagreeing with each other is a warning, not something to average away. Sentiment at
  an extreme argues for caution in the crowd's direction; it is never a reason to trade
  on its own. Old evidence is weak evidence — every block states its age, so use it.

Calibrate confidence honestly. 0.9 means you would be surprised to be wrong. 0.5 means
the evidence genuinely points one way but not decisively. Below 0.4 you are guessing —
return "hold" instead. Systematic overconfidence is worse than being wrong occasionally,
because position size scales with the number you report.`;

const OPINION_SCHEMA = {
  type: "object",
  properties: {
    signal: {
      type: "string",
      enum: ["buy", "sell", "hold"],
      description: "The direction to act on, or hold when evidence is thin.",
    },
    confidence: {
      type: "number",
      description: "How strongly the evidence supports the signal, from 0.0 to 1.0.",
    },
    regime: {
      type: "string",
      enum: ["trending_up", "trending_down", "ranging", "volatile"],
      description: "Your read of the current market regime.",
    },
    rationale: {
      type: "string",
      description: "One or two sentences naming the specific readings behind the call.",
    },
  },
  required: ["signal", "confidence", "regime", "rationale"],
  additionalProperties: false,
} as const;

/**
 * Compress the snapshot into the few numbers that matter.
 *
 * Sending raw candles would burn tokens and bury the signal; the analyst reasons
 * over the same indicator readings the deterministic agents use, so the council
 * is arguing about interpretation rather than about different data.
 */
export function buildSnapshotPrompt(snapshot: MarketSnapshot, now = Date.now()): string {
  const price = closes(snapshot.candles);
  const lines = [
    `Symbol: ${snapshot.symbol}`,
    `Last price: ${snapshot.price}`,
    `Candles available: ${snapshot.candles.length}`,
    `SMA10: ${sma(price, 10)?.toFixed(4) ?? "n/a"}`,
    `SMA30: ${sma(price, 30)?.toFixed(4) ?? "n/a"}`,
    `RSI14: ${rsi(price, 14)?.toFixed(2) ?? "n/a"}`,
    `ATR%: ${atrPercent(snapshot.candles)?.toFixed(3) ?? "n/a"}`,
    `Slope%/candle: ${slopePercent(price, 10)?.toFixed(4) ?? "n/a"}`,
  ];

  if (snapshot.arb) {
    const a = snapshot.arb;
    lines.push(
      `Cross-venue: buy ${a.buyVenue} / sell ${a.sellVenue}`,
      `  top-of-book spread: ${a.topOfBookSpreadBps.toFixed(2)} bps`,
      `  net spread after fees, depth and slippage: ${a.netSpreadBps.toFixed(2)} bps`,
      `  executable: ${a.executable}${a.executable ? "" : ` (rejected: ${a.rejections.join(", ")})`}`,
    );
  } else {
    lines.push("Cross-venue: no scan this tick");
  }

  /*
   * Evidence from outside our own candles.
   *
   * Named as coming from somewhere else, deliberately. The strategist should
   * weigh an independent read differently from the indicators above it — those
   * are the same numbers it can already see, recomputed; these are not.
   *
   * Each block is omitted entirely when the source had nothing, rather than
   * printed as "n/a". A model shown an empty field tends to reason about the
   * emptiness; a model shown nothing reasons about what it has.
   */
  const tv = snapshot.technical;
  if (tv) {
    const perTimeframe = Object.entries(tv.byTimeframe)
      .map(([timeframe, value]) => `${timeframe}:${value.toFixed(2)}`)
      .join(" ");

    lines.push(
      `External technical rating (${tv.source}, -1..1): ${tv.rating.toFixed(2)} (${tv.label.replace(/_/g, " ")})`,
      `  per timeframe: ${perTimeframe}`,
      `  ${Math.round(tv.alignment * 100)}% of ${tv.timeframes} timeframes agree`,
      `  their RSI: ${tv.rsi?.toFixed(1) ?? "n/a"}, ADX: ${tv.adx?.toFixed(1) ?? "n/a"}`,
      `  age: ${((now - tv.asOf) / 60_000).toFixed(0)} min`,
    );
  }

  const conviction = snapshot.conviction;
  if (conviction) {
    lines.push(
      `Research council: ${conviction.stance.replace(/_/g, " ")} at ${(conviction.confidence * 100).toFixed(0)}% confidence, ` +
        `${((now - conviction.asOf) / 3_600_000).toFixed(1)}h old`,
      conviction.summary ? `  "${conviction.summary.slice(0, 400)}"` : "  (no summary)",
    );
  }

  if (snapshot.sentiment) {
    lines.push(`Market sentiment (fear/greed, 0-100): ${snapshot.sentiment.value} — ${snapshot.sentiment.label}`);
  }

  return lines.join("\n");
}

type RawOpinion = {
  signal: Signal;
  confidence: number;
  regime: string;
  rationale: string;
};

function parseOpinion(text: string): RawOpinion | null {
  try {
    const parsed = JSON.parse(text) as RawOpinion;
    if (parsed.signal !== "buy" && parsed.signal !== "sell" && parsed.signal !== "hold") return null;
    if (typeof parsed.rationale !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The LLM-backed strategist.
 *
 * Returns null on every failure path — missing credentials, timeout, rate limit,
 * safety refusal, malformed output. A null is not an error the caller must handle;
 * it simply means the council runs with its deterministic members only. Trading
 * must never block on an external API.
 */
export function createLlmAnalyst(config: LlmConfig = llmConfigFromEnv()) {
  if (!config.enabled) {
    return async function disabledAnalyst(): Promise<AgentOpinion | null> {
      return null;
    };
  }

  // A configured non-Anthropic backend takes the OpenAI-compatible path.
  // Anthropic keeps its native SDK below.
  const provider = resolveProvider();
  if (provider && provider.id !== "anthropic") {
    logger.info(`[ai-team] Strategist using ${provider.id} (${provider.model})`);
    return async function llmAnalystOpenAi(snapshot: MarketSnapshot): Promise<AgentOpinion | null> {
      const text = await chatCompletion(provider, {
        system: SYSTEM_PROMPT,
        user: buildSnapshotPrompt(snapshot),
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
        json: true,
      });

      if (!text) {
        logger.warn("[ai-team] LLM call failed; using deterministic council");
        return null;
      }

      const parsed = parseOpinion(text);
      if (!parsed) {
        logger.warn("[ai-team] LLM output failed validation; using deterministic council");
        return null;
      }

      return {
        agent: "llm-strategist",
        signal: parsed.signal,
        confidence: clampConfidence(parsed.confidence),
        rationale: parsed.rationale,
        source: "llm",
        evidence: { regime: parsed.regime, model: `${provider.id}:${provider.model}`, effort: config.effort },
      };
    };
  }

  // Resolves credentials from the environment or an `ant auth login` profile.
  const client = new Anthropic({ maxRetries: config.maxRetries });

  return async function llmAnalyst(snapshot: MarketSnapshot): Promise<AgentOpinion | null> {
    try {
      const response = await client.messages.create(
        {
          model: config.model,
          max_tokens: config.maxTokens,
          system: [
            {
              type: "text",
              text: SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          output_config: {
            effort: config.effort,
            format: { type: "json_schema", schema: OPINION_SCHEMA },
          },
          messages: [{ role: "user", content: buildSnapshotPrompt(snapshot) }],
        },
        { timeout: config.timeoutMs },
      );

      // Safety classifiers can decline; content is empty or partial when they do.
      if (response.stop_reason === "refusal") {
        // `stop_details` is not in this SDK version's typings yet, so read it structurally.
        const category = (response as { stop_details?: { category?: string } }).stop_details?.category;
        logger.warn(`[ai-team] LLM declined the request (${category ?? "unknown"}); using deterministic council`);
        return null;
      }

      const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === "text");
      if (!textBlock) {
        logger.warn("[ai-team] LLM returned no text block; using deterministic council");
        return null;
      }

      const parsed = parseOpinion(textBlock.text);
      if (!parsed) {
        logger.warn("[ai-team] LLM output failed validation; using deterministic council");
        return null;
      }

      return {
        agent: "llm-strategist",
        signal: parsed.signal,
        confidence: clampConfidence(parsed.confidence),
        rationale: parsed.rationale,
        source: "llm",
        evidence: { regime: parsed.regime, model: config.model, effort: config.effort },
      };
    } catch (error) {
      // Every failure degrades to the deterministic council rather than propagating.
      if (error instanceof Anthropic.RateLimitError) {
        logger.warn("[ai-team] LLM rate limited; using deterministic council");
      } else if (error instanceof Anthropic.APIConnectionError) {
        logger.warn("[ai-team] LLM unreachable or timed out; using deterministic council");
      } else if (error instanceof Anthropic.APIError) {
        logger.warn(`[ai-team] LLM API error ${error.status}; using deterministic council`);
      } else {
        logger.warn(`[ai-team] LLM call failed (${String(error)}); using deterministic council`);
      }
      return null;
    }
  };
}

/**
 * The post-mortem writer.
 *
 * Given a plain-language prompt (loss streak, the numbers, the market context),
 * returns a short narrative analysis — or null on any failure, exactly like the
 * strategist above. It never proposes parameter values itself: proposals are
 * computed deterministically from the loss record and clamped into guardrails
 * at apply time, so the model explains and suggests direction but cannot set
 * numbers that reach the bot.
 */
export function createReflector(config: LlmConfig = llmConfigFromEnv()) {
  if (!config.enabled) return null;

  const REFLECTOR_PROMPT = `You are the risk post-mortem writer on an automated trading desk.

A bot has just closed its Nth losing trade in a row. You receive the deterministic
record: each recent trade's entry/exit and profit, plus a one-line market summary.
Write a tight post-mortem for the human operator:

- What pattern connects the losses (same direction into one move? exits too tight
  for the volatility? entries stretched against trend?)
- What to watch next before trusting this bot again

Rules:
- At most 150 words, plain prose, no headings.
- Reference the actual numbers given to you; do not invent prices or dates.
- Do not recommend specific parameter values — the desk computes those.`;

  const provider = resolveProvider();
  if (provider && provider.id !== "anthropic") {
    return async function reflectOpenAi(prompt: string): Promise<string | null> {
      return chatCompletion(provider, {
        system: REFLECTOR_PROMPT,
        user: prompt,
        maxTokens: 1_000,
        timeoutMs: config.timeoutMs,
      });
    };
  }

  const client = new Anthropic({ maxRetries: config.maxRetries });

  const REFLECTOR_PROMPT_TEXT = `You are the risk post-mortem writer on an automated trading desk.

A bot has just closed its Nth losing trade in a row. You receive the deterministic
record: each recent trade's entry/exit and profit, plus a one-line market summary.
Write a tight post-mortem for the human operator:

- What pattern connects the losses (same direction into one move? exits too tight
  for the volatility? entries stretched against trend?)
- What to watch next before trusting this bot again

Rules:
- At most 150 words, plain prose, no headings.
- Reference the actual numbers given to you; do not invent prices or dates.
- Do not recommend specific parameter values — the desk computes those.`;

  return async function reflect(prompt: string): Promise<string | null> {
    try {
      const response = await client.messages.create(
        {
          model: config.model,
          max_tokens: 1_000,
          system: REFLECTOR_PROMPT_TEXT,
          messages: [{ role: "user", content: prompt }],
        },
        { timeout: config.timeoutMs },
      );

      if (response.stop_reason === "refusal") return null;

      const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === "text");
      return textBlock?.text ?? null;
    } catch (error) {
      logger.warn(`[ai-team] Reflector failed (${String(error)}); using heuristic analysis`);
      return null;
    }
  };
}

