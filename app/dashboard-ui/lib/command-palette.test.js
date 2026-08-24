import { describe, expect, it } from "vitest";
import { fuzzyScore, rankActions } from "./command-palette.js";

describe("fuzzyScore", () => {
  it("matches an empty query with a neutral score", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("rejects when characters are missing", () => {
    expect(fuzzyScore("xyz", "Open positions")).toBe(-1);
  });

  it("prefers a clean word match over scattered letters", () => {
    const whole = fuzzyScore("theme", "Toggle theme");
    const scattered = fuzzyScore("tme", "Toggle theme");
    expect(whole).toBeGreaterThan(scattered);
  });

  it("prefers consecutive runs over scattered letters", () => {
    const run = fuzzyScore("posi", "Open positions");
    const scattered = fuzzyScore("pni", "positions open");
    expect(run).toBeGreaterThan(scattered);
  });

  it("is case insensitive", () => {
    expect(fuzzyScore("OPEN", "open positions")).toBeGreaterThan(0);
  });
});

describe("rankActions", () => {
  const actions = [
    { label: "Add Overview" },
    { label: "Toggle light / dark theme" },
    { label: "Refresh now" },
    { label: "Pause auto-refresh", keywords: ["pause"] },
  ];

  it("keeps everything in order for an empty query", () => {
    expect(rankActions("", actions).map((a) => a.label)).toEqual(actions.map((a) => a.label));
  });

  it("drops actions that do not match", () => {
    const ranked = rankActions("theme", actions);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].label).toContain("theme");
  });

  it("searches keywords too", () => {
    expect(rankActions("pause", actions)[0].label).toBe("Pause auto-refresh");
  });

  it("ranks the best match first", () => {
    expect(rankActions("refresh", actions)[0].label).toBe("Refresh now");
  });

  it("breaks ties by original order", () => {
    // Identical match geometry: the query lands at the same offsets in both.
    const tied = [{ label: "a xq" }, { label: "b xq" }];
    expect(rankActions("xq", tied)).toEqual(tied);
  });
});
