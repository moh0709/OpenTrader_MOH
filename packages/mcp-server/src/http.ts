import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { bearerFrom, configFromEnv, type ClientConfig } from "./client.js";
import { createServer } from "./server.js";

/**
 * The remote transport: Streamable HTTP instead of stdio.
 *
 * This exists because stdio is not reachable from a phone or a browser tab.
 * Claude Desktop and Hermes spawn the process and speak over its pipes; ChatGPT,
 * the ChatGPT iOS/Android apps and every web client instead POST JSON-RPC to a
 * URL. Serving the *same* tool set both ways is what makes "works on my laptop"
 * and "works from my phone" one server rather than two that drift apart.
 *
 * Three things are deliberately different from the stdio path, and each is a
 * security decision rather than an implementation detail:
 *
 * 1. **Stateless.** No session ids, so nothing is retained between calls and a
 *    dropped connection loses nothing but the one in-flight request.
 * 2. **Bearer auth on every request.** stdio inherits a credential from its
 *    parent process; a socket reachable over the internet has to present one.
 * 3. **Bound to loopback by default.** Exposing tools that can close real
 *    positions to the open internet has to be an operator's deliberate choice,
 *    and TLS termination is the reverse proxy's job, not this process's.
 *
 * Enable it with MCP_HTTP_ENABLED=true (or --http). ChatGPT refuses a plain-HTTP
 * endpoint, so it must sit behind TLS at a reverse proxy.
 */

export type HttpOptions = {
  port: number;
  host: string;
  /** Static config for a standalone process. Omit when running in-daemon. */
  config?: ClientConfig;
  /** Resolve a credential per request; used when running inside the daemon. */
  authenticate?: (token: string | null) => boolean;
};

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);

  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(text);
}

/** Read a Node request body as text, with a hard ceiling. */
async function readBody(request: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // An MCP request carries tool arguments, not payloads. Anything this big is
      // a mistake or an attempt to exhaust memory, and refusing it here is far
      // cheaper than buffering it.
      if (size > limit) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** Adapt a Node request to the web-standard Request the SDK transport wants. */
async function toWebRequest(request: IncomingMessage, body: string): Promise<Request> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";

  return new Request(url, {
    method,
    headers: request.headers as Record<string, string>,
    // GET and DELETE carry no body, and Request rejects one — so only pass a body
    // when there genuinely is one.
    ...(body.length > 0 && method !== "GET" && method !== "HEAD" ? { body } : {}),
  });
}

async function writeWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  // forEach rather than Object.fromEntries(headers.entries()): the two disagree on
  // which DOM lib is in scope, and forEach is available on every one of them.
  const headers: Record<string, string> = {};

  webResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });

  response.writeHead(webResponse.status, headers);

  if (!webResponse.body) {
    response.end();
    return;
  }

  const reader = webResponse.body.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    response.write(Buffer.from(value));
  }

  response.end();
}

export type HttpHandle = {
  /** The bound base URL, so a caller that passed port 0 can discover the port. */
  url: string;
  close: () => Promise<void>;
};

/**
 * Serve one MCP HTTP endpoint.
 *
 * A fresh transport and server per request is what stateless mode means here. It
 * looks wasteful and is not: the tool implementations are cheap closures, and
 * sharing one across requests would reintroduce the session state that stateless
 * mode exists to avoid. It also means a wedged request cannot poison the next
 * caller's connection.
 *
 * Returns a handle rather than resolving to nothing, because a listener that
 * cannot be released is a resource leak with a very confusing symptom: the
 * caller believes it cleaned up, the port stays bound, and the next run fails to
 * bind with EADDRINUSE for reasons three files away.
 */
export async function serveHttp(options: HttpOptions): Promise<HttpHandle> {
  const config = options.config ?? configFromEnv();
  const authenticate =
    options.authenticate ?? ((token: string | null) => token !== null && token === config.adminPassword);

  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    // Unauthenticated liveness, so a reverse proxy or uptime check does not need
    // the credential to learn whether the process is up. It exposes nothing.
    if (url.pathname === "/healthz") return json(response, 200, { ok: true });

    if (!authenticate(bearerFrom(new Request(url, { headers: request.headers as Record<string, string> })))) {
      // WWW-Authenticate is what tells an MCP client to start an auth handshake
      // rather than retry the same call forever.
      return json(
        response,
        401,
        { error: "unauthorized", message: "A valid bearer token is required." },
        { "www-authenticate": 'Bearer realm="opentrader"' },
      );
    }

    let mcp: Awaited<ReturnType<typeof createServer>> | undefined;

    try {
      const method = request.method ?? "GET";
      const body = ["POST", "PUT", "PATCH"].includes(method) ? await readBody(request) : "";

      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      mcp = createServer(config);
      await mcp.connect(transport);

      await writeWebResponse(response, await transport.handleRequest(await toWebRequest(request, body)));
    } catch (error) {
      json(response, 500, { error: "internal_error", message: (error as Error).message });
    } finally {
      // Close on every path, including the error path: a leaked server holds its
      // transport's state alive, and this is the cheapest thing in the file.
      await mcp?.close().catch(() => undefined);
    }
  });

  // Port 0 lets the OS pick a free port, which is what makes this safe to run in
  // parallel with anything else; reading the address back is how we learn which.
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const url = `http://${options.host}:${port}/mcp`;

  process.stderr.write(`[opentrader-mcp] listening on ${url}\n`);

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Destroy keep-alive sockets that are idle, or close() waits on them
        // forever and the caller hangs instead of releasing the port.
        server.closeAllConnections?.();
      }),
  };
}
