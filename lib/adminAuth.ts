/**
 * Shared admin authentication guard.
 * The secret is read from the `x-admin-secret` request header (or a `secretKey`
 * body field, matching the existing admin routes) and compared against the
 * `ADMIN_SECRET_KEY` environment variable.
 *
 * The secret is deliberately NOT read from the query string any more: URLs are
 * persisted in Vercel/CDN request logs, browser history and `Referer` headers,
 * so a passcode that travels as `?secretKey=…` is recorded in plaintext
 * everywhere long after the request ends.
 *
 * SECURITY: there is no default. No secret value appears anywhere in this
 * repository — not in code, not in comments, not in the docs — because this
 * project deploys from a public GitHub repository, so anything hardcoded here
 * would be a published credential. An earlier version fell back to a hardcoded
 * development passcode; that fallback is gone. Without `ADMIN_SECRET_KEY` every
 * admin request is rejected, in every environment, and the dashboard's gate
 * cannot open. That is the intended behaviour: an unset variable is a locked
 * admin area, never an open one.
 */
import { NextRequest } from "next/server";
import crypto from "crypto";

let warnedAboutMissingSecret = false;

/**
 * The configured admin secret, or null when there is none — which is the signal
 * for every caller to deny access.
 */
function getExpectedSecret(): string | null {
  const configured = process.env.ADMIN_SECRET_KEY?.trim();
  if (configured) return configured;

  // Fail closed: no admin action can succeed until a real secret is configured.
  if (!warnedAboutMissingSecret) {
    warnedAboutMissingSecret = true;
    console.error(
      "[adminAuth] ADMIN_SECRET_KEY is not set. All admin routes reject requests " +
        "until it is configured — set it in Vercel (Production) and in your local .env.local."
    );
  }
  return null;
}

/** Constant-time string comparison to avoid leaking the secret via response timing. */
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function isAuthorizedAdmin(req: NextRequest, bodySecret?: string): boolean {
  const expected = getExpectedSecret();
  if (!expected) return false;

  const header = req.headers.get("x-admin-secret");
  const raw = (header || bodySecret || "").trim();

  return Boolean(raw) && safeEquals(raw, expected);
}

/**
 * True when the request presents `envName`'s value as `Authorization: Bearer …`,
 * which is exactly how Vercel's cron scheduler authenticates to a protected
 * endpoint when `CRON_SECRET` is set. Fails closed if the env var is unset, so a
 * misconfigured deployment cannot expose an open scheduler trigger.
 */
export function isAuthorizedByBearer(req: NextRequest, envName: string): boolean {
  const expected = process.env[envName]?.trim();
  if (!expected) return false;
  const header = req.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return Boolean(token) && safeEquals(token, expected);
}
