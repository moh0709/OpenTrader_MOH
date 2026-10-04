import { describe, expect, it, vi } from "vitest";
import { SingleFlight } from "./single-flight.js";

/**
 * The gate between the timer and `runNow`.
 *
 * What matters here is not throughput but the ways it could still go wrong:
 * two callers both getting "yes", a rejection latching the gate shut forever,
 * or a synchronously-throwing task never registering at all. Each has its own
 * case below.
 */

/** A promise whose resolution the test controls by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("SingleFlight", () => {
  it("answers the second caller instead of starting a second task", async () => {
    const gate = new SingleFlight(() => "skipped");
    const pending = deferred<string>();
    const task = vi.fn(() => pending.promise);

    const first = gate.run(task);
    const second = gate.run(task);

    expect(await second).toBe("skipped");
    expect(task).toHaveBeenCalledTimes(1);

    pending.resolve("done");
    expect(await first).toBe("done");
  });

  it("runs again once the previous task has settled", async () => {
    const gate = new SingleFlight(() => "skipped");
    const task = vi.fn(async () => "done");

    expect(await gate.run(task)).toBe("done");
    expect(gate.busy()).toBe(false);

    expect(await gate.run(task)).toBe("done");
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("releases the gate when the task rejects, and passes the error through", async () => {
    const gate = new SingleFlight(() => "skipped");

    await expect(
      gate.run(async () => {
        throw new Error("pass failed");
      }),
    ).rejects.toThrow("pass failed");

    expect(gate.busy()).toBe(false);
    expect(await gate.run(async () => "recovered")).toBe("recovered");
  });

  it("holds the gate while the task is pending, then frees it", async () => {
    const gate = new SingleFlight(() => "skipped");
    const pending = deferred<string>();

    const running = gate.run(() => pending.promise);
    expect(gate.busy()).toBe(true);

    pending.resolve("ok");
    expect(await running).toBe("ok");
    expect(gate.busy()).toBe(false);
  });

  it("treats a task that throws before returning a promise as a release", async () => {
    const gate = new SingleFlight(() => "skipped");

    await expect(
      gate.run(() => {
        throw new Error("sync failure");
      }),
    ).rejects.toThrow("sync failure");

    expect(gate.busy()).toBe(false);
    expect(await gate.run(async () => "recovered")).toBe("recovered");
  });
});