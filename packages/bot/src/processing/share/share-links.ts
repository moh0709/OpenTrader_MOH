/**
 * Share links: read-only access to a live feed of the analytics, for one named
 * person, on one device, until a date you choose.
 *
 * Everything here is pure. Token derivation, expiry, the single-device rule and
 * the presence window are all decidable from data the caller already holds, so
 * each rule is testable without a database - which matters, because these are
 * the rules that decide who may see your trading.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type ShareLinkRow = {
  id: number;
  token: string;
  name: string;
  email: string;
  expiresAt: Date;
  revokedAt: Date | null;
  deviceId: string | null;
  claimedAt: Date | null;
  lastSeenAt: Date | null;
};

/** How long after its last heartbeat a viewer still counts as watching. */
export const PRESENCE_WINDOW_MS = 45_000;

/** How often a viewer should say it is still there. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * The token for a share link.
 *
 * Derived from the recipient's email and name so a given person has one
 * identity, and salted with server-side randomness so it cannot be guessed by
 * anyone who merely knows who you shared with. Email is lower-cased and both
 * fields trimmed, so "Bob" and " bob " are the same recipient.
 */
export function deriveToken(email: string, name: string, secret: string, nonce = randomBytes(16).toString("hex")) {
  const identity = `${email.trim().toLowerCase()}|${name.trim()}|${nonce}`;
  const digest = createHmac("sha256", secret).update(identity).digest("base64url");

  return digest.slice(0, 43);
}

/** Compare tokens without leaking their contents through timing. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

/** Normalised identity, so the same person is never issued two links. */
export function identityOf(email: string, name: string) {
  return { email: email.trim().toLowerCase(), name: name.trim() };
}

export type ShareStatus = "active" | "expired" | "revoked" | "unclaimed";

export function isExpired(link: Pick<ShareLinkRow, "expiresAt">, now: number): boolean {
  return link.expiresAt.getTime() <= now;
}

export function isRevoked(link: Pick<ShareLinkRow, "revokedAt">): boolean {
  return link.revokedAt !== null;
}

/** Whether a viewer has sent a heartbeat recently enough to count as watching. */
export function isWatching(link: Pick<ShareLinkRow, "lastSeenAt">, now: number): boolean {
  return link.lastSeenAt !== null && now - link.lastSeenAt.getTime() < PRESENCE_WINDOW_MS;
}

export function statusOf(link: ShareLinkRow, now: number): ShareStatus {
  if (isRevoked(link)) return "revoked";
  if (isExpired(link, now)) return "expired";
  if (link.deviceId === null) return "unclaimed";

  return "active";
}

export type AccessDecision =
  | { allowed: true; claims: boolean }
  | { allowed: false; code: "revoked" | "expired" | "in_use"; message: string };

/**
 * Whether a device may view through this link.
 *
 * The first device to arrive claims it; anyone else is turned away, which is the
 * whole point of a single-use link. A device that has already claimed it can
 * come back as often as it likes.
 *
 * "In use" deliberately does not depend on whether the first viewer is currently
 * watching: a link that freed itself the moment someone closed a tab would not
 * be single-device at all, it would be first-come-first-served forever. Freeing
 * it is an explicit act by the owner.
 */
export function decideAccess(link: ShareLinkRow, deviceId: string, now: number): AccessDecision {
  if (isRevoked(link)) {
    return { allowed: false, code: "revoked", message: "This link has been revoked." };
  }

  if (isExpired(link, now)) {
    return { allowed: false, code: "expired", message: "This link has expired." };
  }

  if (link.deviceId === null) return { allowed: true, claims: true };
  if (tokensMatch(link.deviceId, deviceId)) return { allowed: true, claims: false };

  return { allowed: false, code: "in_use", message: "This link is already in use." };
}

/** A viewer as shown to the owner. Never includes the token. */
export type Viewer = {
  id: number;
  name: string;
  email: string;
  watching: boolean;
  lastSeenAt: number | null;
  status: ShareStatus;
  expiresAt: number;
};

export function toViewer(link: ShareLinkRow, now: number): Viewer {
  return {
    id: link.id,
    name: link.name,
    email: link.email,
    watching: isWatching(link, now) && statusOf(link, now) === "active",
    lastSeenAt: link.lastSeenAt?.getTime() ?? null,
    status: statusOf(link, now),
    expiresAt: link.expiresAt.getTime(),
  };
}

/** Only the people actually watching right now, for the presence indicator. */
export function watchersOf(links: ShareLinkRow[], now: number): Viewer[] {
  return links
    .map((link) => toViewer(link, now))
    .filter((viewer) => viewer.watching)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The URL a recipient opens. */
export function shareUrl(baseUrl: string, token: string) {
  return `${baseUrl.replace(/\/+$/, "")}/analytics/?share=${token}`;
}

/**
 * Validate what the share form submitted.
 *
 * Returns the first problem rather than a list: the form has three fields, and
 * naming the one that is wrong is more useful than enumerating them.
 */
export function validateShareInput(input: { email?: unknown; name?: unknown; expiresAt?: unknown }, now: number) {
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const expiresAt = typeof input.expiresAt === "string" || typeof input.expiresAt === "number" ? new Date(input.expiresAt) : null;

  if (name.length < 2) return { ok: false as const, error: "Enter the recipient's name." };
  // Deliberately loose: the point is to catch a typo, not to police addresses.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false as const, error: "Enter a valid email address." };
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) return { ok: false as const, error: "Choose an expiry date." };
  if (expiresAt.getTime() <= now) return { ok: false as const, error: "The expiry date must be in the future." };

  return { ok: true as const, ...identityOf(email, name), expiresAt };
}
