/**
 * The AI activity journal — one stream of everything the AI does.
 *
 * Before this existed, "what is the AI doing right now" had no answer. The
 * hybrid strategy wrote to the log, the regime governor wrote to the log, the
 * learning loop wrote a database row, and dashboard control actions went into a
 * separate audit ring. Four sinks, none of them joinable, none of them live.
 *
 * This is the single place all of them now also report to, so the dashboard can
 * show the council acting as it acts rather than reconstructing it afterwards.
 *
 * Deliberately in-memory. A ring buffer means no migration, no retention policy
 * and no write amplification on a trading loop that runs every candle — the
 * cost is that the feed starts empty after a daemon restart, which the UI says
 * plainly rather than passing off as "nothing happened". Anything that must
 * survive a restart is already durable elsewhere: orders, the learning journal,
 * mirrored convictions.
 *
 * It lives in `@opentrader/ai-team` because that is the one package both the
 * strategy (via `@opentrader/bot-templates`) and the daemon (via
 * `@opentrader/bot`) already depend on, and because the server and the bot
 * manager share a process — so a module singleton is genuinely one buffer.
 */

/**
 * What kind of thing happened, in the vocabulary the UI paints as chips.
 *
 * Kept coarse on purpose. A reader glancing at a bubble has about a second, and
 * eleven categories is already at the edge of what can be told apart at a
 * glance; a finer taxonomy would be more accurate and less useful.
 */
export type AiActionChip =
  | "analysis"
  | "decision"
  | "open"
  | "close"
  | "take-profit"
  | "adjust"
  | "risk"
  | "cap"
  | "learning"
  | "settings"
  | "denied";

/** Chips that changed a position or the money behind one, rather than a view. */
export const TRADE_CHIPS: readonly AiActionChip[] = ["open", "close", "take-profit", "risk", "cap", "adjust"];

export type AiActionSeverity = "info" | "success" | "warning" | "danger";

/**
 * What the dashboard should point at.
 *
 * Resolved most-specific-first by the client: a trade row beats a bot row beats
 * a symbol card beats the widget the action belongs to. Something always
 * resolves, so an action is never silently unexplained.
 */
export type AiActionTarget = {
  botId?: number;
  smartTradeId?: number;
  symbol?: string;
  /** Widget id to fall back to when no row on the board owns this action. */
  widget?: string;
};

export type AiActionRecord = {
  /** Monotonic within a process. This, not `at`, is the cursor. */
  seq: number;
  id: string;
  /** Epoch ms. */
  at: number;
  chip: AiActionChip;
  severity: AiActionSeverity;
  botId: number | null;
  botName: string | null;
  symbol: string | null;
  smartTradeId: number | null;
  /** The bubble headline. Capped at TITLE_MAX. */
  title: string;
  /** One sentence saying why. Capped at DETAIL_MAX. */
  detail: string;
  target: AiActionTarget;
  /** True when autopilot did this unattended rather than a human confirming it. */
  autonomous: boolean;
};

export type AiActionInput = {
  chip: AiActionChip;
  title: string;
  detail?: string;
  severity?: AiActionSeverity;
  botId?: number | null;
  botName?: string | null;
  symbol?: string | null;
  smartTradeId?: number | null;
  target?: AiActionTarget;
  autonomous?: boolean;
};

/**
 * Length caps, enforced at write time rather than in the UI.
 *
 * The bubble is on screen for two to four seconds. A model that writes a
 * paragraph would produce a bubble nobody can finish reading, and truncating in
 * CSS would only hide the problem — the reader would still be given less than
 * they were promised. Cutting here means every consumer, including a future one,
 * gets text that fits the time it has.
 */
export const TITLE_MAX = 48;
export const DETAIL_MAX = 140;

/** How many actions the ring holds before the oldest falls off. */
export const JOURNAL_LIMIT = 500;

/**
 * Trim to `max` characters without splitting a word.
 *
 * Backing up to a word boundary is skipped when the boundary is in the first
 * half of the window: one very long token would otherwise leave a stub like
 * "The…" where a hard cut at least carries some meaning.
 */
export function concise(text: unknown, max: number): string {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (value.length <= max) return value;

  const window = value.slice(0, max - 1);
  const boundary = window.lastIndexOf(" ");
  const body = boundary > max / 2 ? window.slice(0, boundary) : window;

  return `${body.trimEnd()}…`;
}

/** Sensible tone per chip, so callers only override when they mean something. */
const DEFAULT_SEVERITY: Record<AiActionChip, AiActionSeverity> = {
  analysis: "info",
  decision: "info",
  open: "info",
  close: "success",
  "take-profit": "success",
  adjust: "info",
  risk: "warning",
  cap: "warning",
  learning: "info",
  settings: "info",
  denied: "danger",
};

/**
 * Where to point when the caller did not say.
 *
 * A trade is the most specific thing on the board, then the bot that owns it,
 * then the symbol. With none of those the action is about the AI itself, so the
 * action window is the honest place to draw attention to.
 */
function deriveTarget(input: AiActionInput): AiActionTarget {
  if (input.target && Object.keys(input.target).length > 0) return input.target;

  if (typeof input.smartTradeId === "number") return { smartTradeId: input.smartTradeId };
  if (typeof input.botId === "number") return { botId: input.botId };
  if (input.symbol) return { symbol: input.symbol };

  return { widget: "aiActions" };
}

export class AiActivityJournal {
  private entries: AiActionRecord[] = [];
  private seq = 0;
  private listeners = new Set<(entry: AiActionRecord) => void>();

  /**
   * Identifies this process's buffer.
   *
   * `seq` restarts at zero when the daemon restarts, so a client holding a high
   * cursor from the previous run would sit silent forever waiting for a number
   * that will not come again. The client compares this instead and resets.
   */
  readonly session: string;

  constructor(
    private limit: number = JOURNAL_LIMIT,
    private now: () => number = Date.now,
    session?: string,
  ) {
    this.session = session ?? `s${this.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  record(input: AiActionInput): AiActionRecord {
    this.seq += 1;

    const at = this.now();
    const entry: AiActionRecord = {
      seq: this.seq,
      id: `ai-${this.seq}`,
      at,
      chip: input.chip,
      severity: input.severity ?? DEFAULT_SEVERITY[input.chip],
      botId: input.botId ?? null,
      botName: input.botName ?? null,
      symbol: input.symbol ?? null,
      smartTradeId: input.smartTradeId ?? null,
      title: concise(input.title, TITLE_MAX),
      detail: concise(input.detail ?? "", DETAIL_MAX),
      target: deriveTarget(input),
      autonomous: input.autonomous ?? false,
    };

    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();

    // A listener that throws must not take the trading loop with it, and must
    // not stop the entry being recorded — it is already in the ring by now.
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Persisting is best-effort. The ring is the source of truth.
      }
    }

    return entry;
  }

  /**
   * Be told about each new entry.
   *
   * This is how the daemon persists the feed without this package learning
   * about a database: `@opentrader/ai-team` depends on nothing that could reach
   * one, and putting Prisma behind this line would drag the whole client into
   * the strategy bundle.
   */
  subscribe(listener: (entry: AiActionRecord) => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  /**
   * Put previously-recorded entries back, oldest first.
   *
   * Used at boot to restore the feed from durable storage. The entries keep
   * their original timestamps and text but are re-sequenced, because the cursor
   * is only meaningful within one process.
   */
  hydrate(entries: Omit<AiActionRecord, "seq" | "id">[]) {
    for (const entry of entries) {
      this.seq += 1;
      this.entries.push({ ...entry, seq: this.seq, id: `ai-${this.seq}` });
    }

    if (this.entries.length > this.limit) this.entries = this.entries.slice(-this.limit);
  }

  /**
   * Everything after `cursor`, oldest first.
   *
   * Oldest first because the client appends: the action window, the bubbles and
   * the news lane all want them in the order they happened, and a client that
   * reverses for display can do so cheaply while one that has to re-sort a
   * merge cannot.
   */
  since(cursor = 0, limit = this.limit): AiActionRecord[] {
    const fresh = this.entries.filter((entry) => entry.seq > cursor);

    return fresh.length > limit ? fresh.slice(fresh.length - limit) : fresh;
  }

  /** The newest sequence number issued, which is what a caller polls against. */
  cursor(): number {
    return this.seq;
  }

  /** Test seam. Never called in production — the ring is the retention policy. */
  clear() {
    this.entries = [];
    this.seq = 0;
  }
}

/**
 * The process-wide journal.
 *
 * Pinned to `globalThis` outside production for the same reason `agentAccess`
 * is: a dev reload that re-evaluates this module must not hand half the writers
 * a second, invisible buffer.
 */
const globalForAiActivity = globalThis as unknown as { aiActivity?: AiActivityJournal };

export const aiActivity = globalForAiActivity.aiActivity ?? new AiActivityJournal();

if (process.env.NODE_ENV !== "production") globalForAiActivity.aiActivity = aiActivity;

/**
 * Record one AI action.
 *
 * Never throws. This is called from inside a trading loop, and a journal that
 * could break a strategy would be worse than no journal at all.
 */
export function recordAiAction(input: AiActionInput): AiActionRecord | null {
  try {
    return aiActivity.record(input);
  } catch {
    return null;
  }
}
