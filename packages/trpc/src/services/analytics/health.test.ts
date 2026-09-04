import { describe, expect, it } from "vitest";
import type { HealthInput } from "./health.js";
import { runHealthChecks, rollUp, timeframeToMs } from "./health.js";
import { makeBot } from "./test-fixtures.js";

const NOW = 1_786_362_000_000;

function makeInput(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    now: NOW,
    process: { pid: 105_390, uptimeMs: 7_200_000, rssBytes: 281_350_144, nodeVersion: "22.12.0" },
    host: {
      totalMemoryBytes: 11 * 1_073_741_824,
      freeMemoryBytes: 4 * 1_073_741_824,
      loadAverage1m: 0.6,
      cpuCount: 6,
      diskTotalBytes: 96 * 1_073_741_824,
      diskFreeBytes: 19 * 1_073_741_824,
    },
    database: {
      path: "/var/lib/opentrader/opentrader.db",
      sizeBytes: 766_763_008,
      journalMode: "delete",
      tableCounts: { SmartTrade: 369, Order: 746, BotLog: 3394 },
      largestTable: { name: "BotLog", bytes: 763_363_328 },
    },
    apiLatencyMs: 40,
    tickers: [
      { symbol: "BTC/USD", last: 65_025, bid: 65_024, ask: 65_026, timestamp: NOW - 2_000, fetchedAt: NOW, ageMs: 2_000, stale: false, error: null },
    ],
    bots: [makeBot()],
    lastBotActivity: { 5: NOW - 30_000 },
    orderFlow: { stuckIdleOrders: 0, oldestStuckIdleMs: null, filledEntriesWithoutExit: 0 },
    paperFillPatchApplied: true,
    ...overrides,
  };
}

const find = (report: ReturnType<typeof runHealthChecks>, id: string) => report.checks.find((c) => c.id === id)!;

describe("runHealthChecks", () => {
  it("passes a healthy install", () => {
    // The default fixture is the live install, which is not healthy - it has a
    // bloated log table and a nearly full disk. This is what a good one looks like.
    const report = runHealthChecks(
      makeInput({
        host: { ...makeInput().host, diskFreeBytes: 60 * 1_073_741_824 },
        database: {
          ...makeInput().database,
          sizeBytes: 40_000_000,
          journalMode: "wal",
          largestTable: { name: "Order", bytes: 8_000_000 },
        },
      }),
    );

    expect(report.counts.crit).toBe(0);
    expect(report.counts.warn).toBe(0);
    expect(report.status).toBe("ok");
  });

  it("flags the bot log dominating the database", () => {
    // The live install: 728 MB of bot logs inside a 732 MB database.
    const check = find(runHealthChecks(makeInput()), "db.bloat");

    expect(check.status).toBe("crit");
    expect(check.value).toContain("% of DB");
    expect(check.detail).toContain("never pruned");
  });

  it("says nothing about a table dominating a database that is tiny", () => {
    /*
     * Share alone cannot tell you whether a table is a problem. A young install
     * always has one table holding most of a few megabytes, and calling that
     * "bloat" pages an operator about nothing — which is how they learn to
     * ignore their own alerts. Measured live: 1 MB of journal reading 82.6%.
     */
    const small = makeInput({
      database: {
        ...makeInput().database,
        sizeBytes: 1_572_864,
        largestTable: { name: "AutopilotJournal", bytes: 1_300_000 },
      },
    });

    const check = find(runHealthChecks(small), "db.bloat");

    expect(check.status).toBe("ok");
    // The share is still reported — it is the interesting number once the
    // database is actually large.
    expect(check.value).toContain("% of DB");
    expect(check.detail).not.toContain("never pruned");
  });

  it("still flags a dominant table once there is enough of it to hurt", () => {
    const big = makeInput({
      database: {
        ...makeInput().database,
        sizeBytes: 400 * 1_048_576,
        largestTable: { name: "BotLog", bytes: 380 * 1_048_576 },
      },
    });

    expect(find(runHealthChecks(big), "db.bloat").status).toBe("crit");
  });

  it("escalates disk usage through warn to crit", () => {
    const disk = (freeGb: number) =>
      find(runHealthChecks(makeInput({ host: { ...makeInput().host, diskFreeBytes: freeGb * 1_073_741_824 } })), "host.disk").status;

    expect(disk(60)).toBe("ok");
    expect(disk(19)).toBe("warn"); // 80% used, the current state
    expect(disk(5)).toBe("crit");
  });

  it("treats a rollback journal as worth improving, not broken", () => {
    expect(find(runHealthChecks(makeInput()), "db.journal").status).toBe("warn");
    expect(
      find(runHealthChecks(makeInput({ database: { ...makeInput().database, journalMode: "wal" } })), "db.journal").status,
    ).toBe("ok");
  });

  it("raises a critical alert when the paper fill fix is missing", () => {
    // A rebuild that loses this patch stops every limit order from filling, so it
    // has to be caught loudly rather than inferred from an absence of trades.
    const check = find(runHealthChecks(makeInput({ paperFillPatchApplied: false })), "build.paperFillPatch");

    expect(check.status).toBe("crit");
    expect(check.detail).toContain("never fill");
  });

  it("warns when no bot is enabled", () => {
    const check = find(runHealthChecks(makeInput({ bots: [makeBot({ enabled: false })] })), "bots.enabled");

    expect(check.status).toBe("warn");
    expect(check.detail).toContain("Nothing is trading");
  });

  it("flags a bot that has gone quiet for many timeframes", () => {
    const quiet = runHealthChecks(makeInput({ lastBotActivity: { 5: NOW - 3_600_000 } }));

    expect(find(quiet, "bots.stalled").status).toBe("warn");
    expect(find(quiet, "bots.stalled").detail).toContain("Bronze Dud Bolt");
  });

  it("does not flag a fast bot for a short quiet spell", () => {
    // A 1m bot silent for 5 minutes is normal, so the stall window has a floor.
    expect(find(runHealthChecks(makeInput({ lastBotActivity: { 5: NOW - 300_000 } })), "bots.stalled").status).toBe("ok");
  });

  it("flags a stuck processing flag", () => {
    const report = runHealthChecks(makeInput({ bots: [makeBot({ processing: true })] }));

    expect(find(report, "bots.processing").status).toBe("warn");
  });

  it("does not flag a quiet market as a fault", () => {
    // A thinly traded pair can sit a minute between trades. Our polling is fine,
    // so this must not raise an alarm - it did on the first live run.
    const quiet = makeInput().tickers.map((t) => ({ ...t, ageMs: 60_000, fetchedAt: NOW - 2_000 }));

    expect(find(runHealthChecks(makeInput({ tickers: quiet })), "exchange.tickers").status).toBe("ok");
  });

  it("flags market data we have stopped fetching", () => {
    const notFetching = makeInput().tickers.map((t) => ({ ...t, fetchedAt: NOW - 400_000 }));

    expect(find(runHealthChecks(makeInput({ tickers: notFetching })), "exchange.tickers").status).toBe("crit");
  });

  it("flags a reading too old to mark positions against", () => {
    // Polling is working, but the last trade was 40 minutes ago, so any floating
    // P&L computed from it is meaningless.
    const ancient = makeInput().tickers.map((t) => ({ ...t, ageMs: 2_400_000, fetchedAt: NOW - 1_000 }));

    expect(find(runHealthChecks(makeInput({ tickers: ancient })), "exchange.tickers").status).toBe("crit");
  });

  it("goes critical when every symbol fails to price", () => {
    const failing = makeInput().tickers.map((t) => ({ ...t, error: "network timeout", stale: true }));
    const check = find(runHealthChecks(makeInput({ tickers: failing })), "exchange.tickers");

    expect(check.status).toBe("crit");
    expect(check.detail).toContain("network timeout");
  });

  it("warns about positions left without an exit order", () => {
    const check = find(runHealthChecks(makeInput({ orderFlow: { stuckIdleOrders: 0, oldestStuckIdleMs: null, filledEntriesWithoutExit: 47 } })), "orders.unprotected");

    expect(check.status).toBe("warn");
    expect(check.value).toBe("47");
  });

  it("escalates an order stuck idle by how long it has been stuck", () => {
    const stuck = (ms: number) =>
      find(runHealthChecks(makeInput({ orderFlow: { stuckIdleOrders: 1, oldestStuckIdleMs: ms, filledEntriesWithoutExit: 0 } })), "orders.stuck").status;

    expect(stuck(60_000)).toBe("ok");
    expect(stuck(1_200_000)).toBe("warn");
    expect(stuck(7_200_000)).toBe("crit");
  });

  it("notes a daemon that has only just restarted", () => {
    expect(find(runHealthChecks(makeInput({ process: { ...makeInput().process, uptimeMs: 5_000 } })), "daemon.uptime").status).toBe("warn");
  });

  it("honours caller-supplied thresholds", () => {
    const report = runHealthChecks(makeInput({ thresholds: { diskWarn: 99, diskCrit: 100 } }));

    expect(find(report, "host.disk").status).toBe("ok");
  });

  it("rolls the overall status up to the worst check", () => {
    expect(runHealthChecks(makeInput({ paperFillPatchApplied: false })).status).toBe("crit");
  });

  it("copes with a host that cannot report disk", () => {
    const report = runHealthChecks(
      makeInput({ host: { ...makeInput().host, diskTotalBytes: null, diskFreeBytes: null } }),
    );

    expect(report.checks.some((c) => c.id === "host.disk")).toBe(false);
  });
});

describe("rollUp", () => {
  it("orders crit above warn above unknown above ok", () => {
    const check = (status: "ok" | "warn" | "crit" | "unknown") => ({
      id: status, group: "g", label: "l", status, value: null, detail: null, metric: null,
    });

    expect(rollUp([check("ok"), check("warn"), check("crit")])).toBe("crit");
    expect(rollUp([check("ok"), check("warn")])).toBe("warn");
    expect(rollUp([check("ok"), check("unknown")])).toBe("unknown");
    expect(rollUp([check("ok")])).toBe("ok");
    expect(rollUp([])).toBe("ok");
  });
});

describe("timeframeToMs", () => {
  it("parses the timeframes the bots use", () => {
    expect(timeframeToMs("1m")).toBe(60_000);
    expect(timeframeToMs("15m")).toBe(900_000);
    expect(timeframeToMs("4h")).toBe(14_400_000);
    expect(timeframeToMs("1d")).toBe(86_400_000);
  });

  it("returns null for anything it does not understand", () => {
    expect(timeframeToMs(null)).toBeNull();
    expect(timeframeToMs("banana")).toBeNull();
  });
});
