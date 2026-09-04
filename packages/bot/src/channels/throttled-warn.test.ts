import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearThrottled, resetThrottled, warnThrottled } from "./throttled-warn.js";
import { logger } from "@opentrader/logger";

/**
 * A flapping watcher reconnects every three seconds and logged every time.
 * Measured on a live host at 1,200 identical lines an hour for one symbol —
 * enough to bury everything else, including the trading decisions.
 */
describe("warnThrottled", () => {
  beforeEach(() => {
    resetThrottled();
    vi.restoreAllMocks();
  });

  it("says it the first time", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    warnThrottled("okx:BTC", "checksum failed", 60_000, 1000);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while the same condition repeats inside the window", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    for (let i = 0; i < 50; i++) warnThrottled("okx:BTC", "checksum failed", 60_000, 1000 + i * 3000 / 50);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reports how much it swallowed when the window lapses", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    warnThrottled("okx:BTC", "checksum failed", 60_000, 1000);
    for (let i = 1; i <= 20; i++) warnThrottled("okx:BTC", "checksum failed", 60_000, 1000 + i * 1000);
    warnThrottled("okx:BTC", "checksum failed", 60_000, 200_000);

    // The condition stays visible, and so does its volume.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toMatch(/20 more like this/);
  });

  it("keeps different symbols and different faults apart", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    warnThrottled("okx:BTC", "checksum failed", 60_000, 1000);
    warnThrottled("okx:ETH", "checksum failed", 60_000, 1000);
    warnThrottled("okx:BTC:timeout", "timed out", 60_000, 1000);

    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("reports a condition again immediately once it has been cleared", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    warnThrottled("okx:BTC", "checksum failed", 60_000, 1000);
    clearThrottled("okx:BTC");
    warnThrottled("okx:BTC", "checksum failed", 60_000, 2000);

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
