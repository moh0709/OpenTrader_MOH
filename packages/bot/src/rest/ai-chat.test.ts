import { describe, expect, it } from "vitest";
import {
  ALLOWED_ACTIONS,
  SYSTEM_PROMPT,
  buildContextBlock,
  buildUserTurn,
  extractProposals,
  validateProposal,
  type ChatContext,
} from "./ai-chat.js";

const context = (over: Partial<ChatContext> = {}): ChatContext => ({
  fleet: { realisedPnl: 128.4, floatingPnl: -12.1, openPositions: 3 },
  health: { status: "warn", warnings: 2, criticals: 0 },
  bots: [
    {
      botId: 3,
      name: "Grid-ETH",
      symbol: "ETH/USDT",
      enabled: true,
      netPnl: -40.5,
      floatingPnl: -8,
      trades: 12,
      openPositions: 2,
      strandedPositions: 1,
    },
  ],
  convictions: [{ symbol: "ETH/USDT", stance: "sell", confidence: 0.72, ageHours: 3.5 }],
  openProposals: [{ id: 9, botName: "Grid-ETH", lossStreak: 4 }],
  ...over,
});

describe("extractProposals", () => {
  it("splits the prose from the fenced block", () => {
    const { prose, proposals } = extractProposals(
      'Grid-ETH has lost four in a row.\n\n```json\n{"proposals":[{"action":"bot.stop","params":{"botId":3},"why":"Four losses."}]}\n```',
    );

    expect(prose).toBe("Grid-ETH has lost four in a row.");
    expect(proposals).toEqual([{ action: "bot.stop", params: { botId: 3 }, why: "Four losses." }]);
  });

  it("accepts a fence with no language tag", () => {
    const { proposals } = extractProposals('ok\n```\n{"proposals":[{"action":"regime.sync","params":{}}]}\n```');

    expect(proposals[0].action).toBe("regime.sync");
  });

  it("keeps the whole reply when there is no block, which is the common case", () => {
    const { prose, proposals } = extractProposals("Everything looks fine.");

    expect(prose).toBe("Everything looks fine.");
    expect(proposals).toEqual([]);
  });

  it("keeps the prose when the block is malformed rather than losing the answer", () => {
    // Being unable to parse the optional half of a reply is not a reason to
    // throw away the half that was fine.
    const { prose, proposals } = extractProposals("Here is what I found.\n\n```json\n{not json at all}\n```");

    expect(prose).toBe("Here is what I found.");
    expect(proposals).toEqual([]);
  });

  it("ignores a block that is valid json but the wrong shape", () => {
    expect(extractProposals('hi\n```json\n{"proposals":"stop the bot"}\n```').proposals).toEqual([]);
    expect(extractProposals('hi\n```json\n{"other":[1,2]}\n```').proposals).toEqual([]);
  });

  it("drops entries with no action rather than passing a blank button to the UI", () => {
    const { proposals } = extractProposals('x\n```json\n{"proposals":[{"why":"because"},{"action":"regime.sync"}]}\n```');

    expect(proposals).toHaveLength(1);
    expect(proposals[0].action).toBe("regime.sync");
  });

  it("survives an empty or missing reply", () => {
    expect(extractProposals("")).toEqual({ prose: "", proposals: [] });
    expect(extractProposals(undefined as unknown as string)).toEqual({ prose: "", proposals: [] });
  });
});

describe("validateProposal", () => {
  it("accepts an allowed action with the parameters it needs", () => {
    const result = validateProposal({ action: "bot.stop", params: { botId: 3 }, why: "" });

    expect(result.ok).toBe(true);
  });

  it("refuses anything outside the allowlist", () => {
    const result = validateProposal({ action: "bot.purgeTrades", params: { botId: 3 }, why: "" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("not an action");
  });

  it("refuses the destructive and the self-governing actions by name", () => {
    // These are the three that must never be reachable from a chat message,
    // however the conversation is steered.
    for (const action of ["bot.purgeTrades", "freeze", "share.revoke"]) {
      expect(ALLOWED_ACTIONS[action]).toBeUndefined();
      expect(validateProposal({ action, params: {}, why: "" }).ok).toBe(false);
    }
  });

  it("refuses an action that needs a bot id and did not get a usable one", () => {
    for (const params of [{}, { botId: "three" }, { botId: 0 }, { botId: -1 }, { botId: 1.5 }]) {
      expect(validateProposal({ action: "bot.stop", params, why: "" }).ok).toBe(false);
    }
  });

  it("does not demand a bot id from an action that has no bot", () => {
    expect(validateProposal({ action: "regime.disarm", params: {}, why: "" }).ok).toBe(true);
    expect(validateProposal({ action: "learning.evaluate", params: {}, why: "" }).ok).toBe(true);
  });

  it("demands a journal id for the learning actions that name an entry", () => {
    expect(validateProposal({ action: "learning.apply", params: {}, why: "" }).ok).toBe(false);
    expect(validateProposal({ action: "learning.apply", params: { id: 9 }, why: "" }).ok).toBe(true);
  });

  it("fills in missing params rather than passing undefined downstream", () => {
    const result = validateProposal({ action: "regime.sync" } as never);

    expect(result.ok && result.proposal.params).toEqual({});
  });
});

describe("buildContextBlock", () => {
  it("states the fleet, each bot, the convictions and the waiting proposals", () => {
    const block = buildContextBlock(context());

    expect(block).toContain("realised 128.40");
    expect(block).toContain("#3 Grid-ETH (ETH/USDT)");
    expect(block).toContain("running");
    expect(block).toContain("ETH/USDT: sell at 72% confidence");
    expect(block).toContain("#9 Grid-ETH, after 4 losses in a row");
  });

  it("calls out a stranded position, which is the thing most worth acting on", () => {
    expect(buildContextBlock(context())).toContain("1 STRANDED");
  });

  it("says n/a rather than 0 for a figure that could not be marked to market", () => {
    const block = buildContextBlock(
      context({ fleet: { realisedPnl: 10, floatingPnl: null, openPositions: 1 } }),
    );

    expect(block).toContain("floating n/a");
  });

  it("leaves out sections that have nothing in them", () => {
    const block = buildContextBlock(context({ convictions: [], openProposals: [] }));

    expect(block).not.toContain("Research convictions");
    expect(block).not.toContain("Learning proposals");
  });

  it("carries no credential, host or share detail", () => {
    // The assistant has no business with any of these and cannot leak what it
    // never saw. Asserted rather than assumed, because the context builder is
    // the one place where widening it would be an easy accident.
    const block = buildContextBlock(context()).toLowerCase();

    for (const forbidden of ["apikey", "api key", "password", "token", "secret", "share", "hostname", "/api/"]) {
      expect(block).not.toContain(forbidden);
    }
  });
});

describe("buildUserTurn", () => {
  it("puts the snapshot first and the conversation after it", () => {
    const turn = buildUserTurn(context(), [
      { role: "user", content: "how are we doing?" },
      { role: "assistant", content: "down a little." },
      { role: "user", content: "stop the worst one" },
    ]);

    expect(turn.indexOf("SNAPSHOT")).toBeLessThan(turn.indexOf("CONVERSATION"));
    expect(turn).toContain("Owner: stop the worst one");
    expect(turn).toContain("You: down a little.");
  });

  it("keeps only the most recent turns, so state beats history", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ role: "user" as const, content: `q${i}` }));
    const turn = buildUserTurn(context(), many, 5);

    expect(turn).toContain("q39");
    expect(turn).not.toContain("q30");
  });
});

describe("SYSTEM_PROMPT", () => {
  it("names every allowed action, so the model is told the same list the server enforces", () => {
    for (const action of Object.keys(ALLOWED_ACTIONS)) expect(SYSTEM_PROMPT).toContain(action);
  });

  it("tells the model it cannot carry anything out itself", () => {
    expect(SYSTEM_PROMPT).toContain("cannot carry any of this out");
  });
});
