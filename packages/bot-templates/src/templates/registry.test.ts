import { describe, expect, it } from "vitest";
import * as templates from "./index.js";

/**
 * The app treats every runtime export of the templates barrel as a selectable
 * strategy: `getStrategies` spreads it into the UI list and `findStrategy`
 * resolves names straight out of it.
 *
 * That means a stray exported helper becomes a strategy the user can pick, and
 * picking it crashes the runner — it calls the value as a generator and gets
 * "generator.next is not a function". Types are erased so they are harmless;
 * exported *functions* are not. These tests pin the invariant.
 */
describe("templates registry", () => {
  const entries = Object.entries(templates as Record<string, unknown>);

  it("exports at least the known strategies", () => {
    const names = entries.map(([name]) => name);

    expect(names).toContain("rsi");
    expect(names).toContain("grid");
    expect(names).toContain("dca");
    expect(names).toContain("hybrid");
  });

  it("exports nothing that is not a strategy", () => {
    for (const [name, value] of entries) {
      expect(typeof value, `export "${name}" should be a function`).toBe("function");

      // Every strategy is a generator function; a plain function here means a
      // helper leaked into the barrel.
      expect(
        (value as { constructor?: { name?: string } })?.constructor?.name,
        `export "${name}" must be a generator function, not a plain helper`,
      ).toBe("GeneratorFunction");
    }
  });

  it("gives every strategy the schema the UI reads", () => {
    for (const [name, value] of entries) {
      const schema = (value as { schema?: { _def?: { typeName?: string } } }).schema;

      expect(schema, `strategy "${name}" is missing a schema`).toBeDefined();
      expect(schema?._def?.typeName, `strategy "${name}" schema must be a ZodObject`).toBe("ZodObject");
    }
  });
});
