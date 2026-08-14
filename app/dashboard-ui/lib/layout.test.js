/**
 * The deep-link contract.
 *
 * The "Arbitrage" button in the main OpenTrader navigation is a plain link to
 * /analytics/#arbitrage. Nothing joins that fragment to the widgets except this
 * slug, so renaming the group heading would break the button silently — the
 * dashboard would load, ignore the fragment, and show a board with no arbitrage
 * on it, which is exactly the failure this replaced.
 *
 * The widget modules are imported directly rather than through the catalogue:
 * the catalogue pulls in the charting code, which reaches for `document` while
 * it loads. Placement, scrolling and the focus ring touch the document too and
 * are verified in a real browser; the slug is pure and belongs here.
 */
import { describe, expect, it } from "vitest";
import { groupSlug } from "./groups.js";
import { arbitrageWidgets } from "../widgets/arbitrage.js";

describe("groupSlug", () => {
  it("resolves the fragment the Arbitrage button links to", () => {
    expect(groupSlug("Arbitrage")).toBe("arbitrage");
  });

  it("collapses punctuation and spacing", () => {
    expect(groupSlug("Grid & market")).toBe("grid-market");
  });

  it("leaves no leading or trailing separator", () => {
    expect(groupSlug("& Ops &")).toBe("ops");
  });

  it("survives a missing group without throwing", () => {
    expect(groupSlug(undefined)).toBe("");
  });
});

describe("the arbitrage group", () => {
  it("still answers to the fragment the button targets", () => {
    for (const widget of arbitrageWidgets) expect(groupSlug(widget.group)).toBe("arbitrage");
  });

  it("is the scanner and the venue prices, both of which the button should reveal", () => {
    expect(arbitrageWidgets.map((widget) => widget.id)).toEqual(["arbitrageScanner", "arbitrageVenues"]);
  });
});
