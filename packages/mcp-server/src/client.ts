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

/**
 * Send a request and return its parsed JSON body.
 *
 * Deliberately returns the raw body rather than unwrapping anything: this helper
 * serves both surfaces, and only one of them envelopes anything.
 */
async function fetchJson(config: ClientConfig, label: string, init: RequestInit, url: string): Promise<unknown> {
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
      // Surface the body: both surfaces put the reason in it â€” tRPC in an error
      // envelope, the dashboard routes as a plain `{ error, message }`.
      throw new Error(`OpenTrader API ${response.status} on ${label}: ${text.slice(0, 400)}`);
    }

    return text.length > 0 ? JSON.parse(text) : null;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`OpenTrader API timed out after ${config.timeoutMs}ms on ${label}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Reject a tRPC error envelope, which arrives inside an otherwise-successful body. */
function unwrap(payload: TrpcEnvelope, procedure: string): unknown {
  if (payload.error) {
    const message = payload.error.json?.message ?? payload.error.message ?? "unknown error";
    throw new Error(`OpenTrader API error on ${procedure}: ${message}`);
  }

  return payload.result?.data?.json;
}

async function request(config: ClientConfig, procedure: string, init: RequestInit, url: string): Promise<unknown> {
  return unwrap((await fetchJson(config, procedure, init, url)) as TrpcEnvelope, procedure);
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

/**
 * Plain JSON surface (`/api/dash`) for everything tRPC does not expose.
 *
 * The council's reasoning, the trading head's decisions, health and realised
 * performance all live on the REST dashboard rather than in the tRPC router â€”
 * the dashboard renders them and the API never grew them. So reaching them
 * means a second client rather than more procedures.
 *
 * Unlike the tRPC surface, these routes are scoped: an agent token works here,
 * and `Authorization` still accepts the admin password, so one credential and
 * one helper reach both surfaces. A `read` token is refused on any mutating
 * route by the daemon itself, which is the correct place for that check to live.
 */

/** Build a query string, dropping undefined so callers can pass optionals freely. */
function queryString(params: Record<string, unknown> | undefined): string {
  if (!params) return "";

  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else {
      search.set(key, String(value));
    }
  }

  const encoded = search.toString();

  return encoded ? `?${encoded}` : "";
}

export async function rest(
  config: ClientConfig,
  path: string,
  options: { params?: Record<string, unknown>; body?: unknown; method?: "GET" | "POST" } = {},
): Promise<unknown> {
  const method = options.method ?? "GET";
  const url = `${config.baseUrl}/api/dash${path}${queryString(options.params)}`;

  // Plain JSON, not unwrapped: these routes return the object itself. Running
  // them through the tRPC unwrapper would silently discard the whole response
  // and hand the agent `null` â€” which reads as "the desk has no opinions".
  return fetchJson(
    config,
    path,
    {
      method,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    url,
  );
}

/**
 * Pull the daemon's password out of a request the MCP HTTP transport was given.
 *
 * The remote transport cannot inherit an in-process credential, so it has to be
 * handed one on every call â€” which is the correct shape for something reachable
 * over the internet. Both the header spellings the daemon already accepts are
 * honoured so a single credential works everywhere.
 */
export function bearerFrom(request: Request): string | null {
  const header = request.headers.get("authorization");

  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
    // ChatGPT and curl both send it raw in places; the daemon treats Authorization
    // as the bare password, so accept that rather than failing on a technicality.
    return header.trim();
  }

  return request.headers.get("x-agent-token");
}
