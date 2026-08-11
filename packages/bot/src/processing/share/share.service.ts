/**
 * Share link storage, delivery and presence.
 *
 * The rules live in ./share-links.ts; this is the part that touches the database
 * and sends mail.
 *
 * On delivery: the link is always returned to the caller so it can be copied by
 * hand, and email is treated as a convenience that may fail. A share feature
 * that only works when SMTP is configured correctly is a share feature that
 * mostly does not work, and silently pretending a mail was delivered is worse
 * than saying it was not.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { xprisma } from "@opentrader/db";
import { logger } from "@opentrader/logger";
import type { ShareLinkRow, Viewer } from "./share-links.js";
import { decideAccess, deriveToken, shareUrl, toViewer, validateShareInput, watchersOf } from "./share-links.js";

/**
 * The secret the tokens are derived from.
 *
 * Falls back to the admin password so the feature works out of the box; set
 * SHARE_LINK_SECRET to rotate tokens independently of it.
 */
function tokenSecret(): string {
  return process.env.SHARE_LINK_SECRET || process.env.ADMIN_PASSWORD || "opentrader-share";
}

/** The origin recipients should open. Falls back to the request's own host. */
export function publicBaseUrl(requestHost?: string, protocol = "https"): string {
  return process.env.PUBLIC_BASE_URL || (requestHost ? `${protocol}://${requestHost}` : "http://localhost:8000");
}

export type ShareRecord = Viewer & { url: string; emailSentAt: number | null; emailError: string | null };

function toRecord(link: ShareLinkRow & { emailSentAt: Date | null; emailError: string | null }, baseUrl: string, now: number): ShareRecord {
  return {
    ...toViewer(link, now),
    url: shareUrl(baseUrl, link.token),
    emailSentAt: link.emailSentAt?.getTime() ?? null,
    emailError: link.emailError,
  };
}

type FullRow = ShareLinkRow & { emailSentAt: Date | null; emailError: string | null };

export async function listShares(baseUrl: string, now = Date.now()): Promise<ShareRecord[]> {
  const links = (await xprisma.shareLink.findMany({ orderBy: { createdAt: "desc" } })) as FullRow[];

  return links.map((link) => toRecord(link, baseUrl, now));
}

/** Everyone watching right now. Drives the presence indicator. */
export async function currentWatchers(now = Date.now()): Promise<Viewer[]> {
  const links = (await xprisma.shareLink.findMany({
    where: { revokedAt: null, expiresAt: { gt: new Date(now) }, lastSeenAt: { not: null } },
  })) as ShareLinkRow[];

  return watchersOf(links, now);
}

export type CreateShareResult = { ok: true; share: ShareRecord } | { ok: false; error: string };

/**
 * Issue a link for one person.
 *
 * Re-sharing with the same person updates their existing link rather than
 * issuing a second one: the address and name are the identity, so two links for
 * the same recipient would just be two ways to lose track of who can see what.
 */
export async function createShare(
  input: { email?: unknown; name?: unknown; expiresAt?: unknown },
  baseUrl: string,
  now = Date.now(),
): Promise<CreateShareResult> {
  const parsed = validateShareInput(input, now);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const { email, name, expiresAt } = parsed;
  const existing = (await xprisma.shareLink.findFirst({ where: { email, name } })) as FullRow | null;

  const link = existing
    ? ((await xprisma.shareLink.update({
        where: { id: existing.id },
        // Renewing clears the revocation and the device, so the person can open
        // it again on whatever they are using now.
        data: { expiresAt, revokedAt: null, deviceId: null, claimedAt: null, emailError: null },
      })) as FullRow)
    : ((await xprisma.shareLink.create({
        data: {
          token: deriveToken(email, name, tokenSecret(), randomBytes(16).toString("hex")),
          email,
          name,
          expiresAt,
        },
      })) as FullRow);

  const url = shareUrl(baseUrl, link.token);
  const delivery = await sendShareEmail({ to: email, name, url, expiresAt });

  const saved = (await xprisma.shareLink.update({
    where: { id: link.id },
    data: { emailSentAt: delivery.sent ? new Date() : null, emailError: delivery.error },
  })) as FullRow;

  return { ok: true, share: toRecord(saved, baseUrl, now) };
}

export async function revokeShare(id: number): Promise<boolean> {
  const link = (await xprisma.shareLink.findUnique({ where: { id } })) as ShareLinkRow | null;
  if (!link) return false;

  await xprisma.shareLink.update({ where: { id }, data: { revokedAt: new Date() } });

  return true;
}

export async function deleteShare(id: number): Promise<boolean> {
  const link = (await xprisma.shareLink.findUnique({ where: { id } })) as ShareLinkRow | null;
  if (!link) return false;

  await xprisma.shareLink.delete({ where: { id } });

  return true;
}

/**
 * Free a link from the device holding it.
 *
 * Without this a recipient who changed phone, or cleared their browser storage,
 * is locked out of their own link forever.
 */
export async function releaseDevice(id: number): Promise<boolean> {
  const link = (await xprisma.shareLink.findUnique({ where: { id } })) as ShareLinkRow | null;
  if (!link) return false;

  await xprisma.shareLink.update({ where: { id }, data: { deviceId: null, claimedAt: null, lastSeenAt: null } });

  return true;
}

/**
 * Someone tried to open a link from a device that does not hold it.
 *
 * Kept in memory rather than in the database: this is a notification, not a
 * record. Losing it on restart is fine; growing a table of them is not.
 */
export type BlockedAttempt = { at: number; shareId: number; name: string; email: string };

const BLOCKED_LIMIT = 50;
const blockedAttempts: BlockedAttempt[] = [];

function recordBlocked(attempt: BlockedAttempt) {
  blockedAttempts.push(attempt);
  if (blockedAttempts.length > BLOCKED_LIMIT) blockedAttempts.shift();

  logger.warn(`[Share] ${attempt.name} <${attempt.email}> tried to open their link from another device`);
}

/** Refused attempts after a cursor, newest last, for the owner to be told about. */
export function blockedSince(since: number): BlockedAttempt[] {
  return blockedAttempts.filter((attempt) => attempt.at > since);
}

export type ViewerSession =
  | { ok: true; name: string; email: string; expiresAt: number }
  | { ok: false; code: string; message: string };

/**
 * Admit a device, claiming the link if it is the first.
 *
 * Also serves as the heartbeat: every call refreshes `lastSeenAt`, so presence
 * needs no second endpoint and a viewer that stops calling simply fades out.
 */
export async function admitViewer(token: string, deviceId: string, now = Date.now()): Promise<ViewerSession> {
  if (!token || !deviceId) return { ok: false, code: "invalid", message: "This link is not valid." };

  const link = (await xprisma.shareLink.findUnique({ where: { token } })) as ShareLinkRow | null;
  if (!link) return { ok: false, code: "invalid", message: "This link is not valid." };

  const decision = decideAccess(link, deviceId, now);
  if (!decision.allowed) {
    // Only a wrong device is worth telling the owner about: an expired or
    // revoked link is something they did on purpose.
    if (decision.code === "in_use") {
      recordBlocked({ at: now, shareId: link.id, name: link.name, email: link.email });
    }

    return { ok: false, code: decision.code, message: decision.message };
  }

  await xprisma.shareLink.update({
    where: { id: link.id },
    data: {
      lastSeenAt: new Date(now),
      ...(decision.claims ? { deviceId, claimedAt: new Date(now) } : {}),
    },
  });

  return { ok: true, name: link.name, email: link.email, expiresAt: link.expiresAt.getTime() };
}

// ---------- email ----------

export type Delivery = { sent: boolean; error: string | null };

function emailBody(name: string, url: string, expiresAt: Date) {
  const expiry = expiresAt.toISOString().slice(0, 16).replace("T", " ");

  return [
    `Hi ${name},`,
    "",
    "You have been given a live view of an OpenTrader analytics feed.",
    "",
    url,
    "",
    `The link works until ${expiry} UTC, and only on the first device that opens it.`,
    "If you open it somewhere else you will be told it is already in use.",
    "",
    "You can only view. Nothing you do can change any trading.",
  ].join("\n");
}

/**
 * Send the link.
 *
 * Uses the local mail transport, which on most hosts means postfix. Delivery to
 * the big providers depends on that host's SPF, DKIM and IP reputation, none of
 * which this code can assert - so the result is recorded either way and the URL
 * is always available to copy.
 *
 * Set SHARE_EMAIL=off to skip sending entirely and share links by hand.
 */
export async function sendShareEmail(params: { to: string; name: string; url: string; expiresAt: Date }): Promise<Delivery> {
  if (process.env.SHARE_EMAIL === "off") return { sent: false, error: "Email sending is disabled (SHARE_EMAIL=off)" };

  const from = process.env.SHARE_EMAIL_FROM || "opentrader@localhost";
  const subject = "Your OpenTrader live feed link";
  const message = [
    `From: OpenTrader <${from}>`,
    `To: ${params.to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    emailBody(params.name, params.url, params.expiresAt),
    "",
  ].join("\n");

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("/usr/sbin/sendmail", ["-t", "-i"], { stdio: ["pipe", "ignore", "pipe"] });
    } catch (err) {
      resolve({ sent: false, error: `No local mail transport: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));

    child.on("error", (err) => resolve({ sent: false, error: `Could not run sendmail: ${err.message}` }));

    child.on("close", (code) => {
      if (code === 0) {
        logger.info(`[Share] Handed the link for ${params.to} to the local mail transport`);
        resolve({ sent: true, error: null });
      } else {
        resolve({ sent: false, error: `sendmail exited ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}` });
      }
    });

    child.stdin?.end(message);
  });
}
