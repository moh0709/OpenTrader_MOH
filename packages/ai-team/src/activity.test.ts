import { describe, expect, it } from "vitest";
import {
  AiActivityJournal,
  DETAIL_MAX,
  TITLE_MAX,
  TRADE_CHIPS,
  concise,
  recordAiAction,
} from "./activity.js";

describe("concise", () => {
  it("returns short text unchanged, with whitespace collapsed", () => {
    expect(concise("  Closed BTC/USDT,   +$3.40 ", 60)).toBe("Closed BTC/USDT, +$3.40");
  });

  it("never exceeds the cap", () => {
    const long = "The council turned bearish on Bitcoin after four consecutive sessions of falling volume and widening spreads across every venue scanned";

    expect(concise(long, 40).length).toBeLessThanOrEqual(40);
    expect(concise(long, DETAIL_MAX).length).toBeLessThanOrEqual(DETAIL_MAX);
  });

  it("cuts on a word boundary rather than mid-word", () => {
    const result = concise("Force-exited the position because the daily loss budget tripped", 30);

    // Everything before the ellipsis must be whole words.
    expect(result.endsWith("…")).toBe(true);
    expect(result.slice(0, -1)).not.toMatch(/\s$/);
    expect("Force-exited the position because the daily loss budget tripped").toContain(result.slice(0, -1));
  });

  it("hard-cuts a single enormous token rather than returning a stub", () => {
    const result = concise("A" + "b".repeat(80), 20);

    expect(result.length).toBe(20);
    expect(result.endsWith("…")).toBe(true);
  });

  it("treats null and undefined as empty", () => {
    expect(concise(null, 10)).toBe("");
    expect(concise(undefined, 10)).toBe("");
  });
});

describe("AiActivityJournal", () => {
  const at = (value: number) => () => value;

  it("caps the ring and evicts the oldest", () => {
    const journal = new AiActivityJournal(3);

    for (const title of ["one", "two", "three", "four"]) journal.record({ chip: "analysis", title });

    const all = journal.since(0);
    expect(all).toHaveLength(3);
    expect(all.map((entry) => entry.title)).toEqual(["two", "three", "four"]);
  });

  it("cursors on the sequence, so two actions in the same millisecond both survive", () => {
    // This is the whole reason the cursor is not the timestamp: a council tick
    // records its verdict and its order within the same millisecond, and a
    // timestamp cursor would silently drop the second one.
    const journal = new AiActivityJournal(10, at(1_700_000_000_000));

    journal.record({ chip: "decision", title: "Buy BTC/USDT" });
    journal.record({ chip: "open", title: "Opened $100 BTC/USDT" });

    expect(journal.since(0)).toHaveLength(2);
    expect(journal.cursor()).toBe(2);
    expect(journal.since(1).map((entry) => entry.title)).toEqual(["Opened $100 BTC/USDT"]);
    expect(journal.since(2)).toEqual([]);
  });

  it("returns oldest first, so a client can append", () => {
    const journal = new AiActivityJournal();

    journal.record({ chip: "analysis", title: "first" });
    journal.record({ chip: "analysis", title: "second" });

    expect(journal.since(0).map((entry) => entry.title)).toEqual(["first", "second"]);
  });

  it("enforces the length caps at write time", () => {
    const journal = new AiActivityJournal();

    const entry = journal.record({
      chip: "risk",
      title: "The risk governor has decided to reduce the position size considerably",
      detail: "x".repeat(400),
    });

    expect(entry.title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(entry.detail.length).toBeLessThanOrEqual(DETAIL_MAX);
  });

  it("defaults severity from the chip", () => {
    const journal = new AiActivityJournal();

    expect(journal.record({ chip: "take-profit", title: "t" }).severity).toBe("success");
    expect(journal.record({ chip: "risk", title: "t" }).severity).toBe("warning");
    expect(journal.record({ chip: "denied", title: "t" }).severity).toBe("danger");
    expect(journal.record({ chip: "risk", title: "t", severity: "info" }).severity).toBe("info");
  });

  it("derives a target most-specific-first", () => {
    const journal = new AiActivityJournal();

    expect(journal.record({ chip: "close", title: "t", botId: 3, smartTradeId: 649, symbol: "BTC/USDT" }).target).toEqual({
      smartTradeId: 649,
    });
    expect(journal.record({ chip: "cap", title: "t", botId: 3, symbol: "BTC/USDT" }).target).toEqual({ botId: 3 });
    expect(journal.record({ chip: "analysis", title: "t", symbol: "BTC/USDT" }).target).toEqual({ symbol: "BTC/USDT" });
  });

  it("falls back to the action window when nothing on the board owns the action", () => {
    const journal = new AiActivityJournal();

    expect(journal.record({ chip: "settings", title: "Model changed" }).target).toEqual({ widget: "aiActions" });
  });

  it("keeps an explicit target over a derived one", () => {
    const journal = new AiActivityJournal();

    expect(journal.record({ chip: "cap", title: "t", botId: 3, target: { symbol: "ETH/USDT" } }).target).toEqual({
      symbol: "ETH/USDT",
    });
  });

  it("marks unattended actions", () => {
    const journal = new AiActivityJournal();

    expect(journal.record({ chip: "adjust", title: "t" }).autonomous).toBe(false);
    expect(journal.record({ chip: "adjust", title: "t", autonomous: true }).autonomous).toBe(true);
  });
});

describe("recordAiAction", () => {
  it("never throws, whatever it is handed", () => {
    // Called from inside the trading loop: a journal that can break a strategy
    // is worse than no journal.
    expect(() => recordAiAction({ chip: "analysis", title: undefined as unknown as string })).not.toThrow();
  });
});

describe("TRADE_CHIPS", () => {
  it("covers everything that moves money and nothing that does not", () => {
    expect(TRADE_CHIPS).toContain("open");
    expect(TRADE_CHIPS).toContain("close");
    expect(TRADE_CHIPS).toContain("take-profit");
    expect(TRADE_CHIPS).not.toContain("analysis");
    expect(TRADE_CHIPS).not.toContain("settings");
  });
});

describe("persistence hooks", () => {
  it("tells a subscriber about each new entry", () => {
    const journal = new AiActivityJournal();
    const seen: string[] = [];

    journal.subscribe((entry) => seen.push(entry.title));
    journal.record({ chip: "open", title: "one" });
    journal.record({ chip: "close", title: "two" });

    expect(seen).toEqual(["one", "two"]);
  });

  it("stops telling a subscriber that has unsubscribed", () => {
    const journal = new AiActivityJournal();
    const seen: string[] = [];

    const off = journal.subscribe((entry) => seen.push(entry.title));
    journal.record({ chip: "open", title: "one" });
    off();
    journal.record({ chip: "open", title: "two" });

    expect(seen).toEqual(["one"]);
  });

  it("records the entry even when a subscriber throws", () => {
    // Persisting is best-effort and runs inside the trading loop. A failed write
    // must not cost the feed its entry, or the strategy its tick.
    const journal = new AiActivityJournal();

    journal.subscribe(() => {
      throw new Error("database is locked");
    });

    expect(() => journal.record({ chip: "open", title: "survives" })).not.toThrow();
    expect(journal.since(0)).toHaveLength(1);
  });

  it("brings past entries back, re-sequenced but otherwise intact", () => {
    const journal = new AiActivityJournal();

    journal.hydrate([
      {
        at: 1_700_000_000_000,
        chip: "close",
        severity: "success",
        botId: 3,
        botName: "Grid-ETH",
        symbol: "ETH/USDT",
        smartTradeId: null,
        title: "Closed ETH/USDT",
        detail: "Sold at market.",
        target: { botId: 3 },
        autonomous: false,
      },
    ]);

    const [entry] = journal.since(0);
    expect(entry.title).toBe("Closed ETH/USDT");
    expect(entry.at).toBe(1_700_000_000_000);
    // The cursor only means anything within one process, so it is re-issued.
    expect(entry.seq).toBe(1);
    expect(entry.id).toBe("ai-1");
  });

  it("keeps new entries sequenced after hydrated ones", () => {
    const journal = new AiActivityJournal();

    journal.hydrate([
      { at: 1, chip: "open", severity: "info", botId: null, botName: null, symbol: null, smartTradeId: null, title: "old", detail: "", target: {}, autonomous: false },
    ]);
    journal.record({ chip: "open", title: "new" });

    expect(journal.since(0).map((entry) => entry.title)).toEqual(["old", "new"]);
    expect(journal.cursor()).toBe(2);
  });

  it("does not let hydration overflow the ring", () => {
    const journal = new AiActivityJournal(2);

    journal.hydrate(
      ["a", "b", "c"].map((title) => ({
        at: 1, chip: "open" as const, severity: "info" as const, botId: null, botName: null,
        symbol: null, smartTradeId: null, title, detail: "", target: {}, autonomous: false,
      })),
    );

    expect(journal.since(0).map((entry) => entry.title)).toEqual(["b", "c"]);
  });
});
