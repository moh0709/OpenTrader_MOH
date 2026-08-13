// The shebang is added by tsup's banner at build time; having one here too
// would emit it twice and the second line would be a syntax error.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, query } from "./client.js";
import { createServer } from "./server.js";

/**
 * stdio entry point.
 *
 * stdout is the MCP protocol channel — anything written there that is not a
 * protocol message corrupts the session. Every diagnostic goes to stderr.
 */
/**
 * Confirm we are actually talking to OpenTrader before advertising tools that
 * can close positions.
 *
 * This is not paranoia. A daemon bound to IPv6 loopback and an unrelated
 * service bound to IPv4 can share a port number, so `127.0.0.1:8000` and
 * `[::1]:8000` reach *different applications* — which is exactly the case on
 * the deployment this was written for. An MCP server that silently points at
 * the wrong service, while exposing tools that sell positions, is worth one
 * request at startup to rule out.
 *
 * Deliberately non-fatal: a daemon restart should not take Hermes's MCP server
 * down with it, and every tool already reports its own errors.
 */
async function probe(config: ReturnType<typeof configFromEnv>) {
  try {
    await query(config, "bot.list");
    process.stderr.write(`[opentrader-mcp] connected to OpenTrader at ${config.baseUrl}\n`);
  } catch (err) {
    process.stderr.write(
      `[opentrader-mcp] WARNING: could not reach OpenTrader at ${config.baseUrl}: ${(err as Error).message}\n` +
        "[opentrader-mcp] Tools will start but every call will fail until this is fixed.\n" +
        "[opentrader-mcp] If the daemon binds IPv6 loopback, set OPENTRADER_URL=http://[::1]:8000 — " +
        "127.0.0.1 on the same port can reach a different service entirely.\n",
    );
  }
}

async function main() {
  const config = configFromEnv();
  const server = createServer(config);

  await probe(config);
  await server.connect(new StdioServerTransport());

  process.stderr.write("[opentrader-mcp] ready\n");
}

main().catch((err: Error) => {
  process.stderr.write(`[opentrader-mcp] fatal: ${err.message}\n`);
  process.exit(1);
});
