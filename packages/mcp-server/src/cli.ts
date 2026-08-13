// The shebang is added by tsup's banner at build time; having one here too
// would emit it twice and the second line would be a syntax error.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv } from "./client.js";
import { createServer } from "./server.js";

/**
 * stdio entry point.
 *
 * stdout is the MCP protocol channel — anything written there that is not a
 * protocol message corrupts the session. Every diagnostic goes to stderr.
 */
async function main() {
  const config = configFromEnv();
  const server = createServer(config);

  process.stderr.write(`[opentrader-mcp] connecting to ${config.baseUrl}\n`);

  await server.connect(new StdioServerTransport());

  process.stderr.write("[opentrader-mcp] ready\n");
}

main().catch((err: Error) => {
  process.stderr.write(`[opentrader-mcp] fatal: ${err.message}\n`);
  process.exit(1);
});
