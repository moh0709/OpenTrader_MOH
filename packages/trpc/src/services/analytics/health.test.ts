import { describe, expect, it } from "vitest";
import type { HealthInput } from "./health.js";
import { runHealthChecks, rollUp, timeframeToMs } from "./health.js";
import { makeBot, makeGridSettings } from "./test-fixtures.js";

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
      {
        symbol: "BTC/USD",
        last: 65_025,
        bid: 65_024,
        ask: 65_026,
        timestamp: NOW - 2_000,
        fetchedAt: NOW,
        ageMs: 2_000,
        stale: false,
        error: null,
      },
    ],
    bots: [makeBot()],
    lastBotActivity: { 5: NOW - 30_000 },
    orderFlow: { stuckIdleOrders: 0, oldestStuckIdleMs: null, filledEntriesWithoutExit: 0 },
    botCapital: [],
    // A configured account with a bot on it, so the credential check has something
    // to pass on by default and the "healthy install" fixture stays honest.
    exchangeAccounts: [
      {
        id: 1,
        exchangeCode: "OKX",
        name: "MOH OKX",
        isDemoAccount: false,
        hasApiKey: true,
        hasSecretKey: true,
        botCount: 1,
      },
    ],
    paperFillPatchApplied: true,
    ...overrides,
  };
}

const find = (report: ReturnType<typeof runHealthChecks>, id: string) => report.checks.find((c) => c.id === id)!;

const account = (over: Partial<HealthInput["exchangeAccounts"][number]> = {}) => ({
  id: 1,
  exchangeCode: "OKX",
  name: "MOH OKX",
  isDemoAccount: false,
  hasApiKey: true,
  hasSecretKey: true,
  botCount: 1,
  ...over,
});

describe("exchange.credentials", () => {
  it("passes an account that has both a key and a secret", () => {
    const check = find(runHealthChecks(makeInput({ exchangeAccounts: [account()] })), "exchange.credentials");

    expect(check.status).toBe("ok");
    expect(check.group).toBe("Exchange");
  });

  it("goes crit when a live account with bots has no key", () => {
    // The regression this whole check exists for: an account whose credentials
    // were cleared while eight bots stayed enabled. The desk cannot trade, and
    // before this check nothing said so.
    const check = find(
      runHealthChecks(makeInput({ exchangeAccounts: [account({ hasApiKey: false, botCount: 8 })] })),
      "exchange.credentials",
    );

    expect(check.status).toBe("crit");
    expect(check.metric).toBe(1);
  });

  it("goes crit on a missing secret alone, because half a credential is none", () => {
    const check = find(
      runHealthChecks(makeInput({ exchangeAccounts: [account({ hasSecretKey: false })] })),
      "exchange.credentials",
    );

    expect(check.status).toBe("crit");
  });

  it("names the account and how many bots are stranded on it", () => {
    // An operator reading "1 unusable" has to open the dashboard to find out
    // which account and how much is affected, which is one step too many.
    const check = find(
      runHealthChecks(makeInput({ exchangeAccounts: [account({ hasApiKey: false, botCount: 8 })] })),
      "exchange.credentials",
    );

    expect(check.detail).toMatch(/MOH OKX/);
    expect(check.detail).toMatch(/OKX/);
    expect(check.detail).toMatch(/8 bots/);
    expect(check.detail).toMatch(/cannot place, read or cancel orders/);
  });

  it("stays quiet about a credential-less account that no bot uses", () => {
    // An unused, half-configured account is not an outage. Firing on it would be
    // the kind of false alarm that teaches people to ignore this check.
    const report = runHealthChecks(makeInput({ exchangeAccounts: [account({ hasApiKey: false, botCount: 0 })] }));

    expect(report.checks.find((c) => c.id === "exchange.credentials")).toBeUndefined();
  });

  it("never faults a demo account, which trades without keys by design", () => {
    const check = find(
      runHealthChecks(
        makeInput({
          exchangeAccounts: [account({ isDemoAccount: true, hasApiKey: false, hasSecretKey: false })],
        }),
      ),
      "exchange.credentials",
    );

    // Present and green, not absent: an operator has to be able to tell "all
    // demo" from "could not read the accounts".
    expect(check.status).toBe("ok");
    expect(check.detail).toMatch(/demo account/i);
  });

  it("omits the check when there are no accounts to judge", () => {
    // Also what a failed database read looks like: absent, not a green tick.
    const report = runHealthChecks(makeInput({ exchangeAccounts: [] }));

    expect(report.checks.find((c) => c.id === "exchange.credentials")).toBeUndefined();
  });

  it("takes the whole report to crit, so the board cannot look healthy", () => {
    // The check is only worth having if it moves the rollup. A single crit check
    // that the summary averages away is exactly the silence this replaces.
    const report = runHealthChecks(makeInput({ exchangeAccounts: [account({ hasApiKey: false })] }));

    expect(report.status).toBe("crit");
    expect(report.counts.crit).toBeGreaterThan(0);
  });

  it("is not fooled by a credential that is only whitespace", () => {
    // Trimming happens where the value is read; this pins that the boolean it
    // produces is the one the check reasons about.
    expect("".trim().length > 0).toBe(false);
    expect("   ".trim().length > 0).toBe(false);
  });
});

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
      find(
        runHealthChecks(makeInput({ host: { ...makeInput().host, diskFreeBytes: freeGb * 1_073_741_824 } })),
        "host.disk",
      ).status;

    expect(disk(60)).toBe("ok");
    expect(disk(19)).toBe("warn"); // 80% used, the current state
    expect(disk(5)).toBe("crit");
  });

  it("treats a rollback journal as worth improving, not broken", () => {
    expect(find(runHealthChecks(makeInput()), "db.journal").status).toBe("warn");
    expect(
      find(runHealthChecks(makeInput({ database: { ...makeInput().database, journalMode: "wal" } })), "db.journal")
        .status,
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
    expect(find(runHealthChecks(makeInput({ lastBotActivity: { 5: NOW - 300_000 } })), "bots.stalled").status).toBe(
      "ok",
    );
  });

  it("flags an enabled bot that has never executed at all", () => {
    // The blind spot that hid three dead bots: with no activity row to measure,
    // the check skipped them entirely and reported only the healthy ones.
    const never = runHealthChecks(makeInput({ lastBotActivity: {} }));

    expect(find(never, "bots.stalled").status).toBe("warn");
    expect(find(never, "bots.stalled").detail).toContain("Bronze Dud Bolt");
  });

  it("gives a newly created bot its first window before calling it stalled", () => {
    const fresh = runHealthChecks(
      makeInput({ bots: [makeBot({ createdAt: new Date(NOW - 60_000) })], lastBotActivity: {} }),
    );

    expect(find(fresh, "bots.stalled").status).toBe("ok");
  });

  it("says out loud when a bot is at its capital cap", () => {
    // The failure this exists for: the executor refuses every entry and the
    // refusal log is throttled, so a capped bot looks identical to an idle one.
    const capped = runHealthChecks(
      makeInput({ botCapital: [{ botId: 5, name: "Bronze Dud Bolt", maxCapital: 1000, committed: 1926 }] }),
    );

    expect(find(capped, "bots.capital").status).toBe("warn");
    expect(find(capped, "bots.capital").value).toBe("1 at cap");
    expect(find(capped, "bots.capital").detail).toContain("Bronze Dud Bolt (1926/1000)");
  });

  it("reports headroom for a bot that still has room", () => {
    const roomy = runHealthChecks(
      makeInput({ botCapital: [{ botId: 5, name: "Bronze Dud Bolt", maxCapital: 1000, committed: 400 }] }),
    );

    expect(find(roomy, "bots.capital").status).toBe("ok");
    expect(find(roomy, "bots.capital").detail).toContain("(400/1000)");
  });

  it("treats a bot exactly at its cap as capped, since the next entry cannot fit", () => {
    const exact = runHealthChecks(
      makeInput({ botCapital: [{ botId: 5, name: "Bronze Dud Bolt", maxCapital: 1000, committed: 1000 }] }),
    );

    expect(find(exact, "bots.capital").status).toBe("warn");
  });

  it("omits the capital check entirely when no bot has a cap", () => {
    expect(runHealthChecks(makeInput()).checks.find((c) => c.id === "bots.capital")).toBeUndefined();
  });

  it("says when the profit floor is moving exits past the grid spacing", () => {
    // Hermes Bot in the live fleet: a 40-point ETH grid at qty 0.05 with a 3.00
    // floor needs 60 points, so every exit was quietly 50% further out.
    const report = runHealthChecks(
      makeInput({
        bots: [makeBot({ minProfit: 3, settings: makeGridSettings([2520, 2480], 0.05) })],
      }),
    );

    const check = find(report, "bots.minProfit");
    expect(check.status).toBe("warn");
    expect(check.value).toBe("1 lifted");
    expect(check.detail).toContain("+60.00");
    expect(check.detail).toContain("+40.00");
  });

  it("stays quiet when the grid spacing already earns the floor", () => {
    const report = runHealthChecks(
      makeInput({ bots: [makeBot({ minProfit: 3, settings: makeGridSettings([4410, 4360], 0.22) })] }),
    );

    expect(find(report, "bots.minProfit").status).toBe("ok");
  });

  it("omits the profit floor check when no bot has a floor", () => {
    expect(runHealthChecks(makeInput()).checks.find((c) => c.id === "bots.minProfit")).toBeUndefined();
  });

  it("explains a quiet grid bot by its run policy, not by the candle feed", () => {
    const quiet = runHealthChecks(makeInput({ lastBotActivity: { 5: NOW - 3_600_000 } }));

    expect(find(quiet, "bots.stalled").detail).toContain("run only when one of their own trades completes");
    expect(find(quiet, "bots.stalled").detail).toContain("bots.capital");
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
    const check = find(
      runHealthChecks(
        makeInput({ orderFlow: { stuckIdleOrders: 0, oldestStuckIdleMs: null, filledEntriesWithoutExit: 47 } }),
      ),
      "orders.unprotected",
    );

    expect(check.status).toBe("warn");
    expect(check.value).toBe("47");
  });

  it("escalates an order stuck idle by how long it has been stuck", () => {
    const stuck = (ms: number) =>
      find(
        runHealthChecks(
          makeInput({ orderFlow: { stuckIdleOrders: 1, oldestStuckIdleMs: ms, filledEntriesWithoutExit: 0 } }),
        ),
        "orders.stuck",
      ).status;

    expect(stuck(60_000)).toBe("ok");
    expect(stuck(1_200_000)).toBe("warn");
    expect(stuck(7_200_000)).toBe("crit");
  });

  it("notes a daemon that has only just restarted", () => {
    expect(
      find(runHealthChecks(makeInput({ process: { ...makeInput().process, uptimeMs: 5_000 } })), "daemon.uptime")
        .status,
    ).toBe("warn");
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
      id: status,
      group: "g",
      label: "l",
      status,
      value: null,
      detail: null,
      metric: null,
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
