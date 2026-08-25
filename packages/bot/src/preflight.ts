/**
 * Boot-time safety checks.
 *
 * Everything here is a warning, never a refusal. A trading daemon that will not
 * start because it disapproves of its own configuration is a daemon that stops
 * managing open positions, and an unattended position is a worse outcome than
 * a weak password. So this says its piece loudly, once, and gets out of the way.
 *
 * The checks are chosen for what actually goes wrong on a first deploy: a
 * default password, a port open to the world without TLS in front of it, and a
 * database file readable by anyone on the host — which matters here more than
 * usual, because that file holds exchange API keys and now the AI provider key
 * as well.
 */
import { statSync } from "node:fs";
import { logger } from "@opentrader/logger";

/** Passwords that are published in this repository and its documentation. */
const KNOWN_PASSWORDS = new Set(["opentrader", "password", "admin", "changeme", "secret", "test"]);

export type PreflightWarning = { id: string; message: string };

export type PreflightInput = {
  env: NodeJS.ProcessEnv;
  host: string;
  /** Database file path, when there is one on disk. */
  databasePath?: string | null;
  /** Injected so the check is testable without a filesystem. */
  statFile?: (path: string) => { mode: number } | null;
};

const statOrNull = (path: string) => {
  try {
    return statSync(path);
  } catch {
    return null;
  }
};

/**
 * What is wrong with this deployment, in the order it is worth fixing.
 *
 * Pure: it takes the environment rather than reading it, so the whole matrix
 * can be checked without a live process.
 */
export function preflightWarnings(input: PreflightInput): PreflightWarning[] {
  const { env, host } = input;
  const stat = input.statFile ?? statOrNull;
  const warnings: PreflightWarning[] = [];

  const password = env.ADMIN_PASSWORD?.trim();
  // Reachable from beyond this machine. A bare port on 0.0.0.0 is the internet
  // unless something in front of it says otherwise.
  const public_ = host === "0.0.0.0" || host === "::" || host === "";

  if (!password) {
    warnings.push({
      id: "password.missing",
      message:
        "ADMIN_PASSWORD is not set. The dashboard, the tRPC API and every control endpoint are unauthenticated.",
    });
  } else if (KNOWN_PASSWORDS.has(password.toLowerCase())) {
    warnings.push({
      id: "password.default",
      message: `ADMIN_PASSWORD is "${password}", which appears in this project's own README and docker-compose. Anyone who has read them can start and stop your bots.`,
    });
  } else if (password.length < 12) {
    warnings.push({
      id: "password.short",
      message: `ADMIN_PASSWORD is ${password.length} characters. It is the only credential in front of live trading controls and it is sent on every request, so length is the whole defence.`,
    });
  }

  if (public_) {
    warnings.push({
      id: "network.public",
      message: `Listening on ${host || "all interfaces"}. The admin password travels as a plain Authorization header and is kept in browser localStorage, so this must sit behind TLS — put a reverse proxy in front of it, or bind to localhost and reach it over SSH.`,
    });
  }

  if (input.databasePath) {
    const file = stat(input.databasePath);

    // World- or group-readable. The file holds exchange API keys, share tokens
    // and the AI provider key, all in plain text.
    if (file && (file.mode & 0o077) !== 0) {
      warnings.push({
        id: "database.permissions",
        message: `${input.databasePath} is readable by other users on this host (mode ${(file.mode & 0o777).toString(8)}). It stores exchange API keys and the AI provider key in plain text. chmod 600 it.`,
      });
    }
  }

  return warnings;
}

/** Run the checks and log what they found. Never throws, never exits. */
export function runPreflight(input: PreflightInput): PreflightWarning[] {
  const warnings = preflightWarnings(input);

  if (warnings.length === 0) {
    logger.info("[Preflight] No configuration warnings.");

    return warnings;
  }

  logger.warn(`[Preflight] ${warnings.length} configuration warning${warnings.length === 1 ? "" : "s"}:`);
  for (const warning of warnings) logger.warn(`[Preflight]   ${warning.id}: ${warning.message}`);

  return warnings;
}
