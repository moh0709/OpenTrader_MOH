import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer as createHttpServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end: spawn the built MCP server over stdio, drive it with a real MCP
 * client, and serve it a stub OpenTrader API.
 *
 * This is the only test that proves the pieces actually fit — the stdio
 * transport, the tool registrations, the tRPC wire format, and the auth header
 * all have to be right for a single call to succeed.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(here, "../dist/cli.mjs");

// This drives the *built* server, so it needs `tsup` to have run. Skipping with
// a clear reason beats a confusing "connection closed" when the build is stale.
const isBuilt = existsSync(cliPath);

type Received = { url: string; method: string; body: string; auth: string | undefined };

let http: Server;
let port: number;
let client: Client;
const received: Received[] = [];

beforeAll(async () => {
  if (!isBuilt) return;
  // Stub OpenTrader: answers every tRPC call with a recognisable envelope.
  http = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({
        url: req.url ?? "",
        method: req.method ?? "",
        body,
        auth: req.headers.authorization,
      });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: { data: { json: { echoed: req.url } } } }));
    });
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  port = (http.address() as { port: number }).port;

  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      env: {
        ...(process.env as Record<string, string>),
        OPENTRADER_ADMIN_PASSWORD: "test-secret",
        OPENTRADER_URL: `http://127.0.0.1:${port}`,
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await client?.close();
  await new Promise<void>((resolve) => http?.close(() => resolve()));
});

describe.skipIf(!isBuilt)("MCP server over stdio", () => {
  it("exposes every expected tool", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(
      [
        "close_all_deals",
        "close_bot_deals",
        "close_deal",
        "get_bot",
        "get_bot_logs",
        "list_bots",
        "list_open_deals",
        "open_deal",
        "scan_arbitrage",
        "start_bot",
        "stop_bot",
      ].sort(),
    );
  });

  it("marks the closing tools as destructive so an agent treats them carefully", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName.close_deal.annotations?.destructiveHint).toBe(true);
    expect(byName.close_bot_deals.annotations?.destructiveHint).toBe(true);
    expect(byName.close_all_deals.annotations?.destructiveHint).toBe(true);
    expect(byName.list_bots.annotations?.readOnlyHint).toBe(true);
  });

  it("round-trips a read-only call through to the API", async () => {
    received.length = 0;

    const result = await client.callTool({ name: "list_bots", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(received).toHaveLength(1);
    expect(received[0].method).toBe("GET");
    expect(received[0].url).toContain("/api/trpc/bot.list");
    expect(received[0].auth).toBe("test-secret");
  });

  it("sends a close as a POST to the right procedure with the right body", async () => {
    received.length = 0;

    await client.callTool({ name: "close_deal", arguments: { smartTradeId: 42 } });

    expect(received).toHaveLength(1);
    expect(received[0].method).toBe("POST");
    expect(received[0].url).toBe("/api/trpc/smartTrade.close");
    // Defaults to a guaranteed exit when the caller does not say otherwise.
    expect(JSON.parse(received[0].body)).toEqual({ json: { smartTradeId: 42, mode: "market" } });
  });

  it("passes limit mode through when asked", async () => {
    received.length = 0;

    await client.callTool({ name: "close_deal", arguments: { smartTradeId: 7, mode: "limit" } });

    expect(JSON.parse(received[0].body).json.mode).toBe("limit");
  });

  it("requires confirm on the panic close", async () => {
    const result = await client.callTool({ name: "close_all_deals", arguments: {} });

    // The schema rejects it before any HTTP call is made.
    expect(result.isError).toBe(true);
  });

  it("forwards confirm: true on the panic close", async () => {
    received.length = 0;

    await client.callTool({ name: "close_all_deals", arguments: { confirm: true } });

    expect(received[0].url).toBe("/api/trpc/smartTrade.closeAll");
    expect(JSON.parse(received[0].body).json.confirm).toBe(true);
  });

  it("marks open_deal destructive and non-idempotent", async () => {
    const { tools } = await client.listTools();
    const open = tools.find((t) => t.name === "open_deal")!;

    expect(open.annotations?.destructiveHint).toBe(true);
    // Unlike closing, opening twice opens two positions.
    expect(open.annotations?.idempotentHint).toBe(false);
  });

  it("sends open_deal to the right procedure, defaulting to market", async () => {
    received.length = 0;

    await client.callTool({ name: "open_deal", arguments: { botId: 1, side: "buy", quoteAmount: 25 } });

    expect(received[0].method).toBe("POST");
    expect(received[0].url).toBe("/api/trpc/smartTrade.open");
    expect(JSON.parse(received[0].body).json).toMatchObject({
      botId: 1,
      side: "buy",
      quoteAmount: 25,
      orderType: "market",
    });
  });

  it("scans arbitrage as a read-only query with sensible defaults", async () => {
    received.length = 0;

    await client.callTool({ name: "scan_arbitrage", arguments: {} });

    expect(received[0].method).toBe("GET");
    expect(received[0].url).toContain("/api/trpc/arbitrage.scan");
    expect(decodeURIComponent(received[0].url)).toContain('"symbol":"BTC/USDT"');
  });

  it("reports API failures as tool errors rather than crashing the server", async () => {
    // Point the next call at a closed port by stopping the stub.
    await new Promise<void>((resolve) => http.close(() => resolve()));

    const result = await client.callTool({ name: "list_bots", arguments: {} });
    expect(result.isError).toBe(true);

    // The server is still alive and serving after a failed call.
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });
});
