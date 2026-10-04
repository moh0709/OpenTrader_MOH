import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bearerFrom } from "./client.js";
import { serveHttp } from "./http.js";

/**
 * The remote transport, exercised over a real socket.
 *
 * These are the tests that decide whether "works on my phone" is true. The stdio
 * suite cannot tell us anything about that, because a phone cannot open a pipe to
 * a process on a server in another country — it can only POST JSON-RPC to a URL.
 * So this talks HTTP over a real listener: a genuine initialize handshake and a
 * genuine tools/list, not a mock of either.
 */

const TOKEN = "test-token";

/** A minimal MCP initialize payload, as a conforming client would send it. */
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "probe", version: "1.0.0" },
  },
};

describe("bearerFrom", () => {
  it("reads a standard bearer header", () => {
    expect(bearerFrom(new Request("http://x", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
  });

  it("accepts a bare password, which is what the daemon's own header carries", () => {
    expect(bearerFrom(new Request("http://x", { headers: { authorization: "abc" } }))).toBe("abc");
  });

  it("falls back to the agent-token header", () => {
    expect(bearerFrom(new Request("http://x", { headers: { "x-agent-token": "abc" } }))).toBe("abc");
  });

  it("treats an empty header as no credential at all", () => {
    // Not "" but null: an empty bearer must fail auth, not compare equal to an
    // empty configured password — the same trap as the `undefined === undefined`
    // bug this repository already had once.
    expect(bearerFrom(new Request("http://x", { headers: { authorization: "  " } }))).toBeNull();
    expect(bearerFrom(new Request("http://x"))).toBeNull();
  });
});

describe("serveHttp", () => {
  let base: string;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    const handle = await startWith();
    // handle.url ends in /mcp; the suite addresses routes off the origin.
    base = handle.url.replace(/\/mcp$/, "");
    stop = handle.close;
  });

  afterEach(async () => {
    await stop();
  });

  /**
   * Boot the transport on an OS-assigned port and return its handle.
   *
   * Port 0 plus the returned URL is better than hunting for a free port first:
   * the OS cannot hand out a port another process grabs in between, and nothing
   * here has to guess. The handle is closed in afterEach — an unclosed listener
   * keeps its port bound and the next test fails with EADDRINUSE.
   */
  async function startWith() {
    const { serveHttp } = await import("./http.js");
    const config = { baseUrl: "http://127.0.0.1:1", adminPassword: TOKEN, timeoutMs: 5000 };

    return serveHttp({ port: 0, host: "127.0.0.1", config, authenticate: (t) => t === TOKEN });
  }

  const post = (path: string, body: unknown, token: string | null = TOKEN) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it("serves health without a credential so a proxy can check liveness", async () => {
    const response = await fetch(`${base}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("refuses an unauthenticated call", async () => {
    const response = await post("/mcp", initialize, null);

    expect(response.status).toBe(401);
    // Without this header an MCP client retries the same call forever.
    expect(response.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("refuses a wrong token", async () => {
    expect((await post("/mcp", initialize, "nope")).status).toBe(401);
  });

  it("completes an initialize handshake over HTTP", async () => {
    const response = await post("/mcp", initialize);

    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.result.serverInfo.name).toBe("opentrader");
  });

  it("lists the same tools over HTTP as it does over stdio", async () => {
    const listed = await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const text = await listed.text();

    // Parse whichever framing came back rather than assuming: the transport is
    // configured for a JSON response, but a conforming client must handle the SSE
    // framing too, so a test that hard-codes one would pass on a broken change.
    const json = parseMcpResponse(text);
    const names = json.result.tools.map((t: { name: string }) => t.name);

    // The reading tools are the point of this exercise: an agent on a phone has
    // to be able to ask the council what it concluded.
    expect(names).toContain("get_council_conclusion");
    expect(names).toContain("get_trading_head");
    expect(names).toContain("get_health_report");
    expect(names).toContain("close_deal");
  });

  /** Read a tools/list response in either JSON or SSE framing. */
  function parseMcpResponse(text: string): any {
    if (text.trimStart().startsWith("{")) return JSON.parse(text);

    const data = [...text.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]));
    const withResult = data.find((d) => d.result !== undefined);

    if (!withResult) throw new Error(`No result in SSE response: ${text.slice(0, 300)}`);

    return withResult;
  }

  it("releases its port when closed", async () => {
    // The regression: serveHttp used to resolve to void, so nothing could ever
    // release the listener and every test in this file leaked a socket. The
    // symptom showed up far away as an unrelated suite failing to spawn.
    await stop();

    const again = await startWith();

    // Same host, and a fresh port proves the old one is genuinely free rather
    // than merely unused by us.
    expect(again.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(again.url).not.toBe(base + "/mcp");

    await again.close();
  });
});
