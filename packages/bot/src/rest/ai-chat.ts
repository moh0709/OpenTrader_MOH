/**
 * The chat behind the dashboard's "Ask the AI" widget.
 *
 * Three separable pieces, all pure so they can be tested without a model or a
 * database: what the model is told, what it is allowed to ask for, and how its
 * answer is read back.
 *
 * The load-bearing rule is that **this file never executes anything**. It
 * extracts proposals and validates them against an allowlist; carrying one out
 * is a separate, explicit request that goes through the same guarded control
 * path an operator's own click would take. That separation is what makes the
 * autopilot switch reviewable — arming it changes who presses the button, not
 * what the button is wired to.
 */

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type Proposal = {
  action: string;
  params: Record<string, unknown>;
  why: string;
};

/**
 * Everything the chat may propose.
 *
 * Chosen by what is recoverable. Starting and stopping bots, moving caps,
 * replacing exits and applying or reverting a learning proposal are all things
 * an operator can undo by doing the opposite.
 *
 * Deliberately absent:
 *   bot.purgeTrades  deletes every trade of a bot, irreversibly
 *   freeze           the switch that governs agent control in the first place
 *   share.*          issues and revokes access for other people
 *
 * A model cannot be talked into an action that is not in this map, because the
 * map is consulted on the server after the model has finished speaking.
 */
export const ALLOWED_ACTIONS: Record<string, { path: string; needsBotId: boolean; summary: string }> = {
  "bot.start": { path: "bot.start", needsBotId: true, summary: "Start a bot" },
  "bot.stop": { path: "bot.stop", needsBotId: true, summary: "Stop a bot (cancels its resting exit orders)" },
  "bot.restart": { path: "bot.restart", needsBotId: true, summary: "Stop then start a bot" },
  "bot.setLimits": { path: "bot.setLimits", needsBotId: true, summary: "Change a bot's capital cap or minimum profit" },
  "position.recoverStranded": { path: "position.recoverStranded", needsBotId: false, summary: "Replace missing exit orders" },
  "regime.setPolicy": { path: "regime.setPolicy", needsBotId: true, summary: "Put a bot under regime management" },
  "regime.unmanage": { path: "regime.unmanage", needsBotId: true, summary: "Remove a bot from regime management" },
  "regime.disarm": { path: "regime.disarm", needsBotId: false, summary: "Disarm the governor and restore baselines" },
  "regime.sync": { path: "regime.sync", needsBotId: false, summary: "Reconcile caps against the latest convictions" },
  "regime.runNow": { path: "regime.runNow", needsBotId: false, summary: "Ask the research council to run now" },
  "learning.evaluate": { path: "learning.evaluate", needsBotId: false, summary: "Run the loss-streak sweep now" },
  "learning.apply": { path: "learning.apply", needsBotId: false, summary: "Apply a learning proposal" },
  "learning.revert": { path: "learning.revert", needsBotId: false, summary: "Undo an applied learning proposal" },
  "learning.dismiss": { path: "learning.dismiss", needsBotId: false, summary: "Dismiss a learning proposal" },
  /*
   * The trading head, in one direction only.
   *
   * Disarming and running a pass are both safe: one stops it deciding, the
   * other only makes it decide sooner than it would have. Arming it and
   * changing its limits are not here, and their absence is the point — a model
   * that could widen its own risk budget or switch itself from observe to live
   * would make every other guarantee in this file conditional on its judgement.
   * Those two stay a human's click.
   */
  "autopilot.disarm": { path: "autopilot.disarm", needsBotId: false, summary: "Switch the trading head off (positions are left open)" },
  "autopilot.runNow": { path: "autopilot.runNow", needsBotId: false, summary: "Make the trading head decide now" },
};

export const SYSTEM_PROMPT = [
  "You are the operations assistant on an automated crypto trading desk. You are talking to the desk's owner,",
  "who is looking at a live dashboard of their own bots.",
  "",
  "Answer from the SNAPSHOT below. It is the same data on their screen. If the snapshot does not contain",
  "something, say so plainly rather than guessing — a confident wrong number about real money is worse than",
  "an admission that you cannot see it.",
  "",
  "Be brief. Two or three sentences unless asked for more. Use the bot names and symbols as given.",
  "",
  "When the owner asks you to change something, or when you want to recommend a change, end your reply with a",
  "fenced json block exactly like this and nothing after it:",
  "",
  "```json",
  '{"proposals":[{"action":"bot.stop","params":{"botId":3},"why":"It has lost four cycles in a row."}]}',
  "```",
  "",
  "Rules for proposals:",
  `  - action must be one of: ${Object.keys(ALLOWED_ACTIONS).join(", ")}`,
  "  - never propose anything else; there is nothing else you can do",
  "  - one proposal per change; do not batch unrelated changes into one",
  "  - `why` is shown to the owner as your reason. One sentence, specific, no hedging",
  "  - propose nothing if the answer is just information. Most answers are just information",
  "",
  "You cannot carry any of this out. The owner sees each proposal as a button and decides.",
].join("\n");

/**
 * Split a reply into the prose a person reads and the proposals the UI renders.
 *
 * A model that ignores the contract, emits malformed JSON, or simply answers in
 * plain English degrades to a chat message with no proposals — never an error.
 * Being unable to parse the optional half of a reply is not a reason to throw
 * away the half that was fine.
 */
export function extractProposals(reply: string): { prose: string; proposals: Proposal[] } {
  const text = String(reply ?? "");
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);

  if (!fence) return { prose: text.trim(), proposals: [] };

  const prose = text.replace(fence[0], "").trim();

  try {
    const parsed = JSON.parse(fence[1]) as { proposals?: unknown };
    if (!Array.isArray(parsed.proposals)) return { prose, proposals: [] };

    const proposals = parsed.proposals
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({
        action: String(entry.action ?? ""),
        params: (entry.params ?? {}) as Record<string, unknown>,
        why: String(entry.why ?? ""),
      }))
      .filter((proposal) => proposal.action);

    return { prose, proposals };
  } catch {
    return { prose, proposals: [] };
  }
}

export type ValidationResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; reason: string };

/**
 * Is this proposal one the desk is willing to carry out?
 *
 * Checked on the server, after the model has spoken, against the map above.
 * The model's own belief about what it may do is not consulted.
 */
export function validateProposal(proposal: Proposal): ValidationResult {
  const entry = ALLOWED_ACTIONS[proposal.action];
  if (!entry) return { ok: false, reason: `"${proposal.action}" is not an action the assistant may take` };

  const params = proposal.params ?? {};

  if (entry.needsBotId) {
    const botId = Number(params.botId);
    if (!Number.isInteger(botId) || botId <= 0) return { ok: false, reason: `${proposal.action} needs a bot id` };
  }

  if (proposal.action === "learning.apply" || proposal.action === "learning.revert" || proposal.action === "learning.dismiss") {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: `${proposal.action} needs a journal entry id` };
  }

  return { ok: true, proposal: { ...proposal, params } };
}

export type ChatContext = {
  bots: {
    botId: number;
    name: string;
    symbol: string;
    enabled: boolean;
    netPnl: number;
    floatingPnl: number | null;
    trades: number;
    openPositions: number;
    strandedPositions: number;
    maxCapital?: number | null;
  }[];
  fleet: { realisedPnl: number; floatingPnl: number | null; openPositions: number };
  health: { status: string; warnings: number; criticals: number } | null;
  convictions: { symbol: string; stance: string; confidence: number; ageHours: number }[];
  openProposals: { id: number; botName: string; lossStreak: number }[];
  /**
   * The trading head, when it is configured.
   *
   * Optional because an install that has not run the migration has no head at
   * all, and a snapshot that says "autopilot: unknown" would invite the model
   * to speculate about a component that does not exist here.
   */
  autopilot?: {
    enabled: boolean;
    mode: string;
    symbols: string[];
    openPositions: number;
    openExposureQuote: number;
    lastDecisions: { symbol: string; action: string; executed: boolean; reason: string; ageMinutes: number }[];
  } | null;
};

/**
 * The snapshot the model reasons over.
 *
 * Compact on purpose: this is sent on every turn, and a model given three
 * hundred rows of orders answers worse than one given twelve lines of fleet
 * state. It carries no credentials, no share links and no host details — the
 * assistant has no business with any of them and cannot leak what it never saw.
 */
export function buildContextBlock(context: ChatContext): string {
  const money = (value: number | null | undefined) =>
    value === null || value === undefined ? "n/a" : value.toFixed(2);

  const lines = [
    "SNAPSHOT",
    `Fleet: realised ${money(context.fleet.realisedPnl)}, floating ${money(context.fleet.floatingPnl)}, ${context.fleet.openPositions} open positions.`,
    context.health
      ? `Health: ${context.health.status} (${context.health.criticals} critical, ${context.health.warnings} warning).`
      : "Health: unknown.",
    "",
    "Bots:",
    ...context.bots.map((bot) =>
      [
        `  #${bot.botId} ${bot.name} (${bot.symbol})`,
        bot.enabled ? "running" : "stopped",
        `realised ${money(bot.netPnl)}`,
        `floating ${money(bot.floatingPnl)}`,
        `${bot.trades} closed`,
        `${bot.openPositions} open`,
        bot.strandedPositions > 0 ? `${bot.strandedPositions} STRANDED (holding with no exit order)` : null,
        bot.maxCapital ? `cap ${money(bot.maxCapital)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  ];

  if (context.convictions.length > 0) {
    lines.push("", "Research convictions:");
    for (const conviction of context.convictions) {
      lines.push(
        `  ${conviction.symbol}: ${conviction.stance} at ${Math.round(conviction.confidence * 100)}% confidence, ${conviction.ageHours.toFixed(1)}h old`,
      );
    }
  }

  if (context.openProposals.length > 0) {
    lines.push("", "Learning proposals waiting:");
    for (const proposal of context.openProposals) {
      lines.push(`  #${proposal.id} ${proposal.botName}, after ${proposal.lossStreak} losses in a row`);
    }
  }

  const head = context.autopilot;
  if (head) {
    lines.push(
      "",
      head.enabled
        ? `Trading head: ${head.mode} on ${head.symbols.join(", ") || "no symbols"}, holding ${head.openPositions} position${head.openPositions === 1 ? "" : "s"} worth ${money(head.openExposureQuote)}.`
        : "Trading head: disarmed. It is not deciding anything.",
    );

    if (head.mode === "observe" && head.enabled) {
      lines.push("  (observe mode: it decides and writes it down, but places no orders)");
    }

    for (const decision of head.lastDecisions) {
      lines.push(
        `  ${decision.ageMinutes.toFixed(0)}m ago ${decision.symbol}: ${decision.action}` +
          `${decision.executed ? "" : " (not placed)"} — ${decision.reason}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * The conversation as one user turn.
 *
 * The council's provider layer speaks a single system+user pair rather than a
 * message array, so the history is folded into the user turn with the snapshot
 * at the top. Older turns are dropped rather than summarised: this is an
 * operations chat, and the thing that matters most is always the current state
 * of the fleet, not what was said ten questions ago.
 */
export function buildUserTurn(context: ChatContext, messages: ChatMessage[], maxTurns = 12): string {
  const recent = messages.slice(-maxTurns);

  return [
    buildContextBlock(context),
    "",
    "CONVERSATION",
    ...recent.map((message) => `${message.role === "user" ? "Owner" : "You"}: ${message.content}`),
    "",
    "Reply to the last message from the owner.",
  ].join("\n");
}
