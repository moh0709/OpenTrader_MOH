/**
 * The venue timeout.
 *
 * This exists because a scan is only as fast as its slowest venue, and a venue
 * that never answers — a socket held open against a stalled exchange — is
 * indistinguishable from a slow one unless something bounds it. On production
 * that is what made a page look broken: the request took ten seconds and a
 * five-second poll started another one before it finished.
 */
import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "./timeout.js";

describe("withTimeout", () => {
  it("resolves with the value when the promise wins", async () => {
    await expect(withTimeout(Promise.resolve("fast"), 1_000, "too slow")).resolves.toBe("fast");
  });

  it("rejects when the deadline passes first", async () => {
    vi.useFakeTimers();

    const never = new Promise<string>(() => {});
    const pending = withTimeout(never, 50, "did not answer within 50ms");

    const assertion = expect(pending).rejects.toThrow("did not answer within 50ms");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;

    vi.useRealTimers();
  });

  it("clears its timer on success, so a resolved request leaks no pending timer", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    await withTimeout(Promise.resolve("done"), 10_000, "too slow");

    expect(clearSpy).toHaveBeenCalled();

    clearSpy.mockRestore();
    vi.useRealTimers();
  });

  it("propagates the promise's own rejection rather than the timeout", async () => {
    await expect(withTimeout(Promise.reject(new Error("venue exploded")), 1_000, "too slow")).rejects.toThrow(
      "venue exploded",
    );
  });
});
