/**
 * Minimal tRPC-over-HTTP client for the OpenTrader daemon.
 *
 * The daemon speaks tRPC with the superjson transformer, so payloads are
 * wrapped as `{ json: <value> }` in both directions. Auth is a single shared
 * secret sent in the `Authorization` header, matching how the daemon's
 * `createContext` checks it.
 */

export type ClientConfig = {
  baseUrl: string;
  adminPassword: string;
  timeoutMs: number;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const adminPassword = env.OPENTRADER_ADMIN_PASSWORD ?? env.ADMIN_PASSWORD ?? "";

  if (!adminPassword) {
    throw new Error(
      "OPENTRADER_ADMIN_PASSWORD is not set. The MCP server cannot authenticate against the OpenTrader API without it.",
    );
  }

  return {
    // Defaults to the loopback address the daemon listens on, so nothing has to
    // traverse the public internet when the agent runs on the same host.
    baseUrl: (env.OPENTRADER_URL ?? "http://127.0.0.1:8000").replace(/\/$/, ""),
    adminPassword,
    timeoutMs: Number(env.OPENTRADER_TIMEOUT_MS) || 30_000,
  };
}

type TrpcEnvelope = {
  result?: { data?: { json?: unknown } };
  error?: { json?: { message?: string; code?: number }; message?: string };
};

function unwrap(payload: TrpcEnvelope, procedure: string): unknown {
  if (payload.error) {
    const message = payload.error.json?.message ?? payload.error.message ?? "unknown error";
    throw new Error(`OpenTrader API error on ${procedure}: ${message}`);
  }

  return payload.result?.data?.json;
}

async function request(config: ClientConfig, procedure: string, init: RequestInit, url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: config.adminPassword,
        "content-type": "application/json",
        ...init.headers,
      },
    });

    const text = await response.text();

    if (!response.ok) {
      // Surface the body: tRPC returns its error envelope with a non-2xx status.
      throw new Error(`OpenTrader API ${response.status} on ${procedure}: ${text.slice(0, 400)}`);
    }

    return unwrap(JSON.parse(text) as TrpcEnvelope, procedure);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`OpenTrader API timed out after ${config.timeoutMs}ms on ${procedure}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function query(config: ClientConfig, procedure: string, input?: unknown): Promise<unknown> {
  const encoded = encodeURIComponent(JSON.stringify({ json: input ?? null }));
  const url = `${config.baseUrl}/api/trpc/${procedure}?input=${encoded}`;

  return request(config, procedure, { method: "GET" }, url);
}

export async function mutate(config: ClientConfig, procedure: string, input: unknown): Promise<unknown> {
  const url = `${config.baseUrl}/api/trpc/${procedure}`;

  return request(config, procedure, { method: "POST", body: JSON.stringify({ json: input }) }, url);
}
