import { describe, expect, it } from "vitest";
import { sortLevels, totalDepth, walkBook } from "./depth.js";

describe("walkBook", () => {
  it("fills entirely on the top level without slippage", () => {
    const fill = walkBook([{ price: 100, quantity: 5 }], 2);

    expect(fill.avgPrice).toBe(100);
    expect(fill.filledQty).toBe(2);
    expect(fill.notional).toBe(200);
    expect(fill.complete).toBe(true);
    expect(fill.levelsConsumed).toBe(1);
    expect(fill.slippageBps).toBe(0);
  });

  it("computes a volume-weighted average across several levels", () => {
    const fill = walkBook(
      [
        { price: 100, quantity: 1 },
        { price: 102, quantity: 1 },
      ],
      2,
    );

    // (1*100 + 1*102) / 2
    expect(fill.avgPrice).toBe(101);
    expect(fill.notional).toBe(202);
    expect(fill.complete).toBe(true);
    expect(fill.levelsConsumed).toBe(2);
    // 101 vs best price of 100 => 100 bps of slippage
    expect(fill.slippageBps).toBeCloseTo(100, 6);
  });

  it("reports incomplete when the book is too thin", () => {
    const fill = walkBook([{ price: 100, quantity: 1 }], 5);

    expect(fill.complete).toBe(false);
    expect(fill.filledQty).toBe(1);
    expect(fill.avgPrice).toBe(100);
  });

  it("ignores malformed levels instead of poisoning the average", () => {
    const fill = walkBook(
      [
        { price: 100, quantity: 1 },
        { price: -5, quantity: 10 },
        { price: 101, quantity: 0 },
        { price: Number.NaN, quantity: 3 },
        { price: 102, quantity: 1 },
      ],
      2,
    );

    expect(fill.avgPrice).toBe(101);
    expect(fill.filledQty).toBe(2);
    expect(fill.complete).toBe(true);
  });

  it("returns an empty fill for empty books or non-positive targets", () => {
    expect(walkBook([], 1).filledQty).toBe(0);
    expect(walkBook([{ price: 100, quantity: 1 }], 0).filledQty).toBe(0);
    expect(walkBook([{ price: 100, quantity: 1 }], -1).complete).toBe(false);
  });
});

describe("sortLevels", () => {
  it("sorts asks cheapest first and bids highest first", () => {
    const levels = [
      { price: 101, quantity: 1 },
      { price: 99, quantity: 1 },
      { price: 100, quantity: 1 },
    ];

    expect(sortLevels(levels, "asks").map((l) => l.price)).toEqual([99, 100, 101]);
    expect(sortLevels(levels, "bids").map((l) => l.price)).toEqual([101, 100, 99]);
  });

  it("does not mutate the input", () => {
    const levels = [
      { price: 101, quantity: 1 },
      { price: 99, quantity: 1 },
    ];
    sortLevels(levels, "asks");
    expect(levels[0].price).toBe(101);
  });
});

describe("totalDepth", () => {
  it("sums valid quantities only", () => {
    expect(
      totalDepth([
        { price: 100, quantity: 1 },
        { price: 101, quantity: 2 },
        { price: 102, quantity: -5 },
      ]),
    ).toBe(3);
  });
});
