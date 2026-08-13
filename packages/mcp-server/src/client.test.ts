import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv, mutate, query, type ClientConfig } from "./client.js";

const config: ClientConfig = {
  baseUrl: "http://127.0.0.1:8000",
  adminPassword: "secret",
  timeoutMs: 5_000,
};

type Call = { url: string; init: RequestInit };

function stubFetch(response: unknown, status = 200) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(response),
    } as Response;
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("configFromEnv", () => {
  it("refuses to start without an admin password", () => {
    expect(() => configFromEnv({} as NodeJS.ProcessEnv)).toThrow(/OPENTRADER_ADMIN_PASSWORD/);
  });

  it("defaults to loopback so nothing leaves the host", () => {
    const c = configFromEnv({ OPENTRADER_ADMIN_PASSWORD: "x" } as NodeJS.ProcessEnv);
    expect(c.baseUrl).toBe("http://127.0.0.1:8000");
  });

  it("accepts ADMIN_PASSWORD as a fallback name", () => {
    expect(configFromEnv({ ADMIN_PASSWORD: "y" } as NodeJS.ProcessEnv).adminPassword).toBe("y");
  });

  it("strips a trailing slash so URLs do not double up", () => {
    const c = configFromEnv({ OPENTRADER_ADMIN_PASSWORD: "x", OPENTRADER_URL: "https://host/" } as NodeJS.ProcessEnv);
    expect(c.baseUrl).toBe("https://host");
  });
});

describe("query", () => {
  it("wraps input in the superjson envelope and unwraps the result", async () => {
    const calls = stubFetch({ result: { data: { json: [{ id: 1 }] } } });

    const result = await query(config, "bot.list");

    expect(result).toEqual([{ id: 1 }]);
    expect(calls[0].init.method).toBe("GET");
    // superjson expects { json: ... } on the way in
    expect(decodeURIComponent(calls[0].url)).toContain('input={"json":null}');
    expect(calls[0].url).toContain("/api/trpc/bot.list");
  });

  it("sends the admin password as the Authorization header", async () => {
    const calls = stubFetch({ result: { data: { json: true } } });

    await query(config, "bot.list");

    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("secret");
  });

  it("encodes object input", async () => {
    const calls = stubFetch({ result: { data: { json: [] } } });

    await query(config, "bot.openSmartTrades", { botId: 4 });

    expect(decodeURIComponent(calls[0].url)).toContain('{"json":{"botId":4}}');
  });
});

describe("mutate", () => {
  it("posts the superjson envelope", async () => {
    const calls = stubFetch({ result: { data: { json: { ok: true } } } });

    const result = await mutate(config, "smartTrade.close", { smartTradeId: 3, mode: "market" });

    expect(result).toEqual({ ok: true });
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      json: { smartTradeId: 3, mode: "market" },
    });
  });
});

describe("error handling", () => {
  it("surfaces a tRPC error envelope as a readable message", async () => {
    stubFetch({ error: { json: { message: "UNAUTHORIZED" } } });

    await expect(query(config, "bot.list")).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("surfaces a non-2xx response with its body", async () => {
    stubFetch({ error: { json: { message: "nope" } } }, 401);

    await expect(query(config, "bot.list")).rejects.toThrow(/401/);
  });

  it("names the procedure in the error so the agent can tell what failed", async () => {
    stubFetch({ error: { json: { message: "boom" } } });

    await expect(mutate(config, "smartTrade.closeAll", { confirm: true })).rejects.toThrow(/smartTrade.closeAll/);
  });
});
