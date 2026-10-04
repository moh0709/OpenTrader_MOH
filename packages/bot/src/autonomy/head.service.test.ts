import type { HeadPlan } from "@opentrader/ai-team";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TradingHead } from "./head.service.js";
import { DEFAULT_AUTOPILOT, type AutopilotConfig } from "./policy.js";

/**
 * The entry gate in `execute`.
 *
 * The journal is the head's budget, cooldown and exit-in-flight memory — so
 * when it cannot be read the head used to receive 0 / null from every read,
 * which reads as "nothing spent, no cooldown, no working exit": three
 * permissions granted by a broken table. The rule now being pinned down:
 *
 *   - unreadable journal → refuse a fresh commitment of money, opener untouched
 *   - readable journal   → the door decides as before
 *   - exits              → never blocked either way (they reduce risk and
 *                           need no budget)
 */
const mocks = vi.hoisted(() => ({
  journalStatus: vi.fn(
    (): { readable: boolean; writable: boolean; lastReadError: string | null; lastWriteError: string | null } => ({
      readable: true,
      writable: true,
      lastReadError: null,
      lastWriteError: null,
    }),
  ),
  openSmartTrade: vi.fn(),
  closeSmartTrade: vi.fn(),
}));

vi.mock("./journal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./journal.js")>();
  return { ...actual, journalStatus: mocks.journalStatus };
});

vi.mock("../trade-opener.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../trade-opener.js")>();
  return { ...actual, openSmartTrade: mocks.openSmartTrade };
});

vi.mock("../trade-closer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../trade-closer.js")>();
  return { ...actual, closeSmartTrade: mocks.closeSmartTrade };
});

const config: AutopilotConfig = {
  ...DEFAULT_AUTOPILOT,
  enabled: true,
  mode: "live",
  symbols: ["BTC/USDT"],
  botId: 7,
  entryOrderType: "market",
};

const entryPlan: HeadPlan = {
  symbol: "BTC/USDT",
  action: "open",
  sizeQuote: 50,
  quantity: 0.001,
  smartTradeId: null,
  confidence: 0.6,
  reason: "Council is buy at 60% confidence.",
  notes: [],
  urgency: "now",
  netPnlQuote: null,
};

const exitPlan: HeadPlan = {
  ...entryPlan,
  action: "close",
  sizeQuote: 0,
  smartTradeId: 42,
  reason: "Council turned against the position.",
};

type ExecuteResult = { ok: boolean; smartTradeId: number | null; message: string };

/** Drive the private `execute` without widening its visibility in production. */
function execute(head: TradingHead, plan: HeadPlan, price = 100): Promise<ExecuteResult> {
  const fn = (
    head as unknown as {
      execute: (plan: HeadPlan, config: AutopilotConfig, price: number, exchange: unknown) => Promise<ExecuteResult>;
    }
  ).execute;

  return fn.call(head, plan, config, price, {});
}

function journalReadable(readable: boolean): void {
  mocks.journalStatus.mockReturnValue({
    readable,
    writable: readable,
    lastReadError: readable ? null : "no such table: AutopilotJournal",
    lastWriteError: readable ? null : "no such table: AutopilotJournal",
  });
}

describe("the head's entry gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    journalReadable(true);
    mocks.openSmartTrade.mockResolvedValue({
      ok: true,
      smartTradeId: 11,
      message: "Entry placed as market.",
    });
    mocks.closeSmartTrade.mockResolvedValue({ outcome: "closed", message: "Closed at market." });
  });

  it("refuses a new entry while the journal is unreadable, without touching the opener", async () => {
    journalReadable(false);

    const result = await execute(new TradingHead(), entryPlan);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/journal is unreadable/);
    expect(result.message).toMatch(/exits are unaffected/);
    expect(mocks.openSmartTrade).not.toHaveBeenCalled();
  });

  it("opens when the journal can record the decision", async () => {
    const result = await execute(new TradingHead(), entryPlan);

    expect(result.ok).toBe(true);
    expect(result.smartTradeId).toBe(11);
    expect(mocks.openSmartTrade).toHaveBeenCalledTimes(1);
    expect(mocks.openSmartTrade.mock.calls[0][2]).toBe("auto:");
  });

  it("never blocks an exit on journal state", async () => {
    journalReadable(false);

    const result = await execute(new TradingHead(), exitPlan);

    expect(result.ok).toBe(true);
    expect(result.smartTradeId).toBe(42);
    expect(mocks.closeSmartTrade).toHaveBeenCalledWith(42, "market");
    expect(mocks.openSmartTrade).not.toHaveBeenCalled();
  });
});