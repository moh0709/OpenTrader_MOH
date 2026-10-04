import assert from "node:assert/strict";
import test from "node:test";

import { configs } from "./mcp-link.js";

/**
 * The MCP panel is the only setup documentation this project has for an outside
 * agent, so what it prints is worth pinning. Every assertion here is about a
 * claim the panel makes to someone about to spend an afternoon on it.
 */

const ready = { endpoint: "https://trade.example.com/mcp", chatgptReady: true, note: "reachable" };
const notReady = { endpoint: "http://10.0.0.5:5000/mcp", chatgptReady: false, note: "not behind HTTPS" };

const byId = (list, id) => list.find((c) => c.id === id);

test("lists ChatGPT first, because it is the client that works from a phone", () => {
  // Stdio clients cannot run on iOS or Android at all. If ChatGPT ever moves down
  // this list the reason is that the remote path stopped working, and it should
  // be noticed rather than discovered by a user on their phone.
  assert.equal(configs(ready)[0].id, "chatgpt");
});

test("gives ChatGPT the remote URL, which is the only transport it accepts", () => {
  assert.equal(byId(configs(ready), "chatgpt").body, "https://trade.example.com/mcp");
});

test("marks ChatGPT unavailable when the endpoint is not on HTTPS", () => {
  // ChatGPT refuses a plain-HTTP remote endpoint. Saying "available" here sends
  // someone to debug a connection that was never going to succeed.
  const chatgpt = byId(configs(notReady), "chatgpt");

  assert.equal(chatgpt.works, false);
  assert.match(chatgpt.caveat, /HTTPS/i);
});

test("marks ChatGPT available when it is on HTTPS", () => {
  const chatgpt = byId(configs(ready), "chatgpt");

  assert.equal(chatgpt.works, true);
  // Still says what to do — available and self-explanatory are not opposites.
  assert.match(chatgpt.caveat, /authenticate/i);
});

test("stdio clients stay available regardless of TLS, since they are local", () => {
  // The desktop clients run the download on their own machine and talk to the
  // daemon over whatever scheme it serves. A missing proxy must not disable them,
  // or an operator fixing TLS would lose the working option they had.
  for (const info of [ready, notReady]) {
    assert.equal(byId(configs(info), "claude").works, true);
    assert.equal(byId(configs(info), "codex").works, true);
  }
});

test("every stdio config is valid JSON that actually spawns the server", () => {
  for (const id of ["claude", "codex"]) {
    const parsed = JSON.parse(byId(configs(ready), id).body);
    const entry = parsed.mcpServers.opentrader;

    assert.equal(entry.command, "node", `${id} must run the file with node`);
    assert.match(entry.args[0], /opentrader-mcp\.mjs$/);
    // Without a credential the server refuses to start, so the snippet would look
    // plausible and do nothing.
    assert.ok(entry.env.OPENTRADER_ADMIN_PASSWORD);
  }
});

test("the remote-only clients are told the download exists for the local ones", () => {
  const list = configs(ready);

  for (const id of ["claude", "codex"]) {
    assert.match(list.find((c) => c.id === id).blurb, /download/i);
  }
});
