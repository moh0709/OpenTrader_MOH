import { describe, expect, it } from "vitest";
import { decisionFingerprint, type HeadPlan } from "./head.js";

/**
 * Why the desk mailed its operator every few minutes for a day.
 *
 * The head announces a hold only when it *changes* its mind, and journals one
 * on the same rule. Both compared the sentence a human reads — which carries a
 * live P&L figure. "Holding at -0.55%" became "-0.53%" a minute later, so every
 * tick looked like news: 2,662 identical journal rows, 1,399 feed bubbles, a
 * table at 98.6% of the database, and a bloat alarm that emailed on every
 * change of the crit set.
 */
const plan = (action: HeadPlan["action"], reason: string): HeadPlan => ({
  symbol: "ETH/USDT",
  action,
  sizeQuote: 0,
  quantity: 0,
  smartTradeId: null,
  confidence: 0.4,
  reason,
  notes: [],
  urgency: "now",
  netPnlQuote: null,
});

describe("decisionFingerprint", () => {
  it("treats the same decision with a moving number as unchanged", () => {
    const a = decisionFingerprint(plan("hold", "Holding ETH/USDT at -0.55%; nothing to do."));
    const b = decisionFingerprint(plan("hold", "Holding ETH/USDT at -0.63%; nothing to do."));

    expect(a).toBe(b);
  });

  it("still notices a genuinely different reason", () => {
    const holding = decisionFingerprint(plan("hold", "Holding ETH/USDT at -0.55%; nothing to do."));
    const barred = decisionFingerprint(plan("hold", "Council likes ETH/USDT but only at 22%, under the 28% bar."));

    expect(holding).not.toBe(barred);
  });

  it("still notices a different action", () => {
    const same = "Holding ETH/USDT at -0.55%; nothing to do.";

    expect(decisionFingerprint(plan("hold", same))).not.toBe(decisionFingerprint(plan("close", same)));
  });

  it("collapses the halt message whatever the streak count says", () => {
    const three = decisionFingerprint(plan("hold", "3 losing trades in a row reached the limit of 3. Not opening anything else today."));
    const four = decisionFingerprint(plan("hold", "4 losing trades in a row reached the limit of 4. Not opening anything else today."));

    expect(three).toBe(four);
  });
});
