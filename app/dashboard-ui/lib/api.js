/**
 * tRPC client for the dashboard.
 *
 * Reuses the admin password the main OpenTrader UI already stores under
 * `ADMIN_PASSWORD`, so opening the dashboard needs no second login, and logging
 * out of one logs out of both.
 *
 * Queries are batched: tRPC accepts several procedures in one request, so a
 * refresh tick that needs a snapshot, events and health costs one round trip
 * rather than three.
 */
const BASE = "/api/trpc";
const PASSWORD_KEY = "ADMIN_PASSWORD";

export class UnauthorizedError extends Error {
  constructor() {
    super("Not authorized");
    this.name = "UnauthorizedError";
  }
}

export function getPassword() {
  try {
    return window.localStorage.getItem(PASSWORD_KEY);
  } catch {
    return null;
  }
}

export function setPassword(password) {
  window.localStorage.setItem(PASSWORD_KEY, password);
}

export function clearPassword() {
  window.localStorage.removeItem(PASSWORD_KEY);
}

function authHeaders() {
  const password = getPassword();
  if (!password) throw new UnauthorizedError();

  return { authorization: password };
}

/** A single query. Returns the unwrapped result. */
export async function query(path, input = {}, { signal } = {}) {
  const search = new URLSearchParams({ input: JSON.stringify({ json: input }) });
  const response = await fetch(`${BASE}/${path}?${search}`, { headers: authHeaders(), signal });

  if (response.status === 401 || response.status === 403) throw new UnauthorizedError();
  if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}`);

  const payload = await response.json();
  if (payload?.error) throw new Error(payload.error?.json?.message ?? `${path} failed`);

  return payload?.result?.data?.json;
}

/**
 * Several queries in one request.
 *
 * `calls` is `[{ path, input }]`; the result array matches its order. One failing
 * procedure yields an Error in its slot rather than rejecting the batch, so a
 * single broken widget cannot blank the whole dashboard.
 */
export async function batch(calls, { signal } = {}) {
  if (calls.length === 0) return [];
  if (calls.length === 1) {
    try {
      return [await query(calls[0].path, calls[0].input, { signal })];
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      return [error];
    }
  }

  const paths = calls.map((call) => call.path).join(",");
  const input = {};
  calls.forEach((call, index) => {
    input[index] = { json: call.input ?? {} };
  });

  const search = new URLSearchParams({ batch: "1", input: JSON.stringify(input) });
  const response = await fetch(`${BASE}/${paths}?${search}`, { headers: authHeaders(), signal });

  if (response.status === 401 || response.status === 403) throw new UnauthorizedError();
  if (!response.ok) throw new Error(`Batch request failed with HTTP ${response.status}`);

  const payload = await response.json();
  const entries = Array.isArray(payload) ? payload : [payload];

  return calls.map((call, index) => {
    const entry = entries[index];
    if (entry?.error) return new Error(entry.error?.json?.message ?? `${call.path} failed`);

    return entry?.result?.data?.json;
  });
}

/** A mutation, used by the optional bot controls. */
export async function mutate(path, input = {}) {
  const response = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ json: input }),
  });

  if (response.status === 401 || response.status === 403) throw new UnauthorizedError();

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error?.json?.message ?? `${path} failed with HTTP ${response.status}`);
  }

  return payload?.result?.data?.json;
}

/** Verify a password before storing it, so a typo is reported at the login screen. */
export async function verifyPassword(password) {
  const search = new URLSearchParams({ input: JSON.stringify({ json: {} }) });
  const response = await fetch(`${BASE}/dashboard.snapshot?${search}`, {
    headers: { authorization: password },
  });

  return response.ok;
}
