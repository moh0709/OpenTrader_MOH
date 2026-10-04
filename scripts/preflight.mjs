#!/usr/bin/env node
/**
 * Preflight: what state is this deployment actually in?
 *
 * Written because every question it answers has a failure mode that looks like
 * working. The head with no provider configured does not error - it drops the
 * `llm-strategist` seat and keeps trading, so an operator sees a desk that
 * "runs fine" and has quietly lost a 1.5-weight vote. An ungenerated Prisma
 * client looks like an installed one until something calls it. A developer CLI
 * that is logged in is not the same as a subscription that is paid, and no local
 * check can tell the difference.
 *
 * So this prints what is *configured* and refuses to guess past that. It reads
 * no secret values, contacts no provider unless asked, and opens no position.
 *
 *   node scripts/preflight.mjs              # configuration and reachability
 *   node scripts/preflight.mjs --probe      # additionally ask the LLM to say OK
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = process.argv.includes("--probe");

/** ok | warn | crit | unknown — mirrors the dashboard's health vocabulary. */
const results = [];
const record = (status, label, value, detail) => {
  results.push({ status, label, value, detail });
  const mark = { ok: "  ok  ", warn: " warn ", crit: " CRIT ", unknown: " ???? " }[status];
  console.log(`[${mark}] ${label.padEnd(34)} ${value}`);
  if (detail) console.log(`         ${detail}`);
};

/** Load `.env` into process.env without overriding a real environment variable. */
function loadDotEnv() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return false;

  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = match[2].trim().replace(/^["']|["']$/g, "");
  }

  return true;
}

const hasEnvFile = loadDotEnv();
const set = (name) => {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

console.log("OpenTrader preflight\n");

// ---------------------------------------------------------------- environment

record(
  hasEnvFile ? "ok" : "unknown",
  ".env",
  hasEnvFile ? "present" : "absent (using process env)",
  hasEnvFile ? null : "No .env here. Values below are read from the ambient environment, which may not be the daemon's.",
);

if (set("AI_DISABLED") === "1") {
  record("warn", "AI master switch", "disabled", "AI_DISABLED=1 stops the chat and any agentic action. Unset it to re-enable.");
}

// ------------------------------------------------------------------ providers

/**
 * The auto-detect order in packages/ai-team/src/providers.ts. Kept in the same
 * order on purpose: with two keys set and no AI_PROVIDER, the first one here is
 * the one the council will actually use, which is exactly the sort of thing an
 * operator gets wrong and cannot see.
 */
const PROVIDERS = [
  { id: "anthropic", keys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], model: "claude-opus-5" },
  { id: "openai", keys: ["OPENAI_API_KEY"], model: "gpt-5" },
  { id: "openrouter", keys: ["OPENROUTER_API_KEY"], model: "openrouter/auto" },
  { id: "gemini", keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], model: "gemini-2.5-pro" },
  { id: "ollama", keys: [], model: "qwen3:14b" },
  { id: "opencode-zen", keys: ["OPENCODE_ZEN_API_KEY", "OPENCODE_GO_API_KEY"], model: "nemotron-3-ultra-free" },
];

const configured = PROVIDERS.filter((provider) => provider.keys.some((key) => set(key)));
const forced = set("AI_PROVIDER");
const customBase = set("AI_BASE_URL");
const genericKey = set("AI_API_KEY");

let resolved = null;
if (forced === "custom") resolved = customBase ? { id: "custom", baseUrl: customBase, model: set("AI_MODEL") || "" } : null;
else if (forced) resolved = configured.find((p) => p.id === forced) || (forced === "ollama" ? { id: "ollama" } : null);
else if (configured.length > 0) resolved = configured[0];
else if (customBase) resolved = { id: "custom", baseUrl: customBase, model: set("AI_MODEL") || "" };
else if (set("OLLAMA_BASE_URL")) resolved = { id: "ollama", baseUrl: set("OLLAMA_BASE_URL"), model: "qwen3:14b" };

if (forced && !resolved) {
  record(
    "crit",
    "AI provider",
    `${forced} selected but unusable`,
    `AI_PROVIDER=${forced} names a tier with no credential configured. Either set its key or unset AI_PROVIDER to fall back to auto-detection.`,
  );
} else if (resolved) {
  record(
    "ok",
    "AI provider",
    `${resolved.id}${resolved.model ? ` · ${resolved.model}` : ""}`,
    resolved.id === "ollama" && !set("OLLAMA_BASE_URL")
      ? "Ollama needs OLLAMA_BASE_URL to be auto-detected, so this one is only selected because AI_PROVIDER forced it."
      : null,
  );
  if (configured.length > 1) {
    record(
      "warn",
      "AI provider ambiguity",
      `${configured.length} keys present`,
      `${configured.map((p) => p.id).join(", ")} are all set and AI_PROVIDER is unset, so the council uses ${configured[0].id}. Pin it with AI_PROVIDER if that is not the one you meant.`,
    );
  }
  if (resolved.id === "custom" && !genericKey) {
    record("warn", "Custom provider key", "none set", "A custom base URL with no AI_API_KEY is fine for a local runtime, and a 401 otherwise.");
  }
} else {
  record(
    "ok",
    "AI provider",
    "not configured (deterministic-only)",
    "Supported, not a fault. The council keeps its deterministic seats and the head keeps trading — but the `llm-strategist` seat is absent from every vote. See .env.example for the keys that switch it on.",
  );
}

// ---------------------------------------------------------------- agent tools

/**
 * Developer assistants, checked for presence only.
 *
 * None of these participate in a trading decision. The council reaches its LLM
 * seat over HTTP through packages/ai-team/src/providers.ts, not by shelling out
 * to a CLI, so installing or authenticating one of them changes nothing about
 * how the desk trades. Reported because "is my toolchain wired up" is a fair
 * question and this is the honest answer to it.
 */
console.log("");
const AGENT_TOOLS = [
  { name: "claude", auth: join(process.env.USERPROFILE || "", ".claude", ".credentials.json") },
  { name: "codex", auth: join(process.env.USERPROFILE || "", ".codex", "auth.json") },
  { name: "opencode", auth: join(process.env.USERPROFILE || "", ".local", "share", "opencode", "auth.json") },
  { name: "kilo", auth: join(process.env.USERPROFILE || "", ".config", "kilo", "auth.json") },
];

const onPath = (name) => {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split(/\r?\n/).filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
};

for (const tool of AGENT_TOOLS) {
  const binary = onPath(tool.name);
  const authed = existsSync(tool.auth);
  if (!binary) {
    record("unknown", tool.name, "not installed", null);
  } else if (authed) {
    record("ok", tool.name, "installed · credential file present", `A credential file existing means a login happened at some point. It is not evidence that a paid plan is active today.`);
  } else {
    record("warn", tool.name, "installed · no credential file", "Installed but not signed in, or signed in somewhere this script cannot see.");
  }
}

// ------------------------------------------------------------------- database

console.log("");
let prisma = null;
try {
  const require = createRequire(import.meta.url);
  // pathToFileURL, not the bare path: on Windows an absolute `E:\...` specifier
  // is rejected by the ESM loader, which reads the drive letter as a protocol.
  const mod = await import(pathToFileURL(require.resolve("@prisma/client")).href);
  prisma = new mod.PrismaClient({ log: [] });
} catch (error) {
  const message = String(error?.message ?? error).split("\n")[0];
  // An ungenerated client is by far the most common case and has a one-line fix,
  // so it is worth naming precisely rather than reporting as a load failure.
  const generated = /did not initialize yet|@prisma\/client|ClientKnownRequestError/i.test(message);
  record(
    "crit",
    "Prisma client",
    generated ? "not generated" : "could not load",
    generated
      ? "Run `pnpm install` (it triggers `prisma generate`), or `npx prisma generate --schema packages/prisma/src/schema.prisma`. Nothing that touches the database can start until this is done."
      : message,
  );
}

if (prisma) {
  // The blank first line on a Prisma error is deliberate — it separates the
  // invocation banner from the cause — so the first *non-empty* line is the
  // one worth showing, and an empty slice is worse than no detail at all.
  const firstLine = (text) =>
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no further detail";

  try {
    await prisma.$queryRaw`SELECT 1`;
    record("ok", "Database", "reachable", null);
  } catch (error) {
    const message = String(error?.message ?? error);

    if (/Environment variable not found:\s*DATABASE_URL/.test(message)) {
      record(
        "crit",
        "Database",
        "DATABASE_URL not set",
        "Nothing that touches the database can start. Set DATABASE_URL in .env (the schema is sqlite by default: file:./dev.db) and run `npx prisma db push --schema packages/prisma/src/schema.prisma`.",
      );
    } else if (/did not initialize yet|@prisma\/client/.test(message)) {
      record(
        "crit",
        "Database",
        "client not generated",
        "Run `pnpm install` (it triggers `prisma generate`), or `npx prisma generate --schema packages/prisma/src/schema.prisma`.",
      );
    } else {
      record("crit", "Database", "unreachable", firstLine(message));
    }
  }
}

// The autopilot tables and the policy the head would read.
if (results.some((r) => r.label === "Database" && r.status === "ok")) {
  console.log("");
  try {
    const policy = await prisma.autopilotPolicy.findFirst();
    if (!policy) {
      // Not a fault, and not the same as "unconfigured". `loadAutopilotPolicy`
      // seeds a disarmed default row on its first read, so a virgin database
      // reports empty here and the daemon fills it in moments later. It only
      // becomes a real problem if it is *still* empty after the daemon has run.
      record(
        "ok",
        "Autopilot policy",
        "not seeded yet",
        "Expected on a fresh database — the daemon seeds a disarmed, observe-mode default on its first read. If this is still empty after a restart, the daemon is not reaching this database.",
      );
    } else {
      const symbols = (() => {
        try {
          return JSON.parse(policy.symbols).length;
        } catch {
          return 0;
        }
      })();

      record(
        policy.enabled && policy.mode === "live" ? "warn" : "ok",
        "Autopilot policy",
        policy.enabled ? `enabled · ${policy.mode}` : "disarmed",
        policy.enabled && policy.mode === "live"
          ? `LIVE with ${symbols} symbol(s) and every ${policy.intervalSec}s. This is real money.`
          : `${symbols} symbol(s) watched, bot ${policy.botId ?? "none"}, every ${policy.intervalSec}s.`,
      );
    }
  } catch (error) {
    const detail = String(error?.message ?? error)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    record(
      "crit",
      "Autopilot tables",
      "missing or unreadable",
      `${(detail ?? "no further detail").slice(0, 140)} — run \`npx prisma db push --schema packages/prisma/src/schema.prisma\`.`,
    );
  }
}

// ----------------------------------------------------------------- provider probe

if (PROBE && resolved) {
  console.log("");
  const base = {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com/v1",
    openrouter: "https://openrouter.ai/api/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
    ollama: "http://127.0.0.1:11434/v1",
    "opencode-zen": "https://opencode.ai/zen/v1",
  };
  const url = customBase || base[resolved.id];
  const key =
    genericKey ||
    (configured.find((p) => p.id === resolved.id)?.keys ?? []).map((k) => set(k)).find(Boolean) ||
    null;

  try {
    const response = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: set("AI_MODEL") || resolved.model,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const body = await response.text();
    record(
      response.ok ? "ok" : "crit",
      "Provider probe",
      response.ok ? "answered" : `HTTP ${response.status}`,
      response.ok
        ? "The provider accepted this credential and model id. This costs a fraction of a cent."
        : body.replace(/\b(sk|pk|api|key|tok)[-_][A-Za-z0-9._-]{8,}/gi, "[redacted]").slice(0, 200),
    );
  } catch (error) {
    record("crit", "Provider probe", "unreachable", String(error?.message ?? error).split("\n")[0]);
  }
}

// -------------------------------------------------------------------- summary

const blockers = results.filter((r) => r.status === "crit");
const warnings = results.filter((r) => r.status === "warn");

console.log("");
console.log("─".repeat(74));
console.log(
  blockers.length === 0
    ? `No blockers. ${warnings.length} warning(s).`
    : `${blockers.length} blocker(s), ${warnings.length} warning(s).`,
);

console.log("");
console.log("This script does NOT verify, and nothing local can:");
console.log("  · whether a third-party plan is paid, funded or in good standing");
console.log("  · whether a key still works after a rotation or a revocation");
console.log("  · whether an exchange account can actually place an order");
console.log("  · whether the council's verdict is any good — that is a month of observe mode");
console.log("Arming the head in live mode is a human decision. This script will not do it.");

process.exit(blockers.length === 0 ? 0 : 1);
