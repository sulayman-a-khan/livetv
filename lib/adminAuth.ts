/**
 * Shared admin authentication guard.
 * Accepts the secret via the `x-admin-secret` header, a `secretKey` query
 * param, or a `secretKey` body field, matching the existing admin routes.
 *
 * SECURITY: if ADMIN_SECRET_KEY is never set, every admin route used to fall
 * back to the hardcoded string "supersecret123" — a default that's now
 * public in this codebase, so anyone could have used it to hit any admin
 * endpoint. In production we now fail CLOSED instead: with no env var set,
 * every admin request is rejected rather than silently accepted against a
 * known password. The fallback is kept only for local development so a
 * fresh checkout still works without extra setup.
 */
import { NextRequest } from "next/server";
import crypto from "crypto";

const DEV_FALLBACK_SECRET = "supersecret123";
let warnedAboutFallback = false;

function getExpectedSecret(): string | null {
  const configured = process.env.ADMIN_SECRET_KEY?.trim();
  if (configured) return configured;

  if (process.env.NODE_ENV === "production") {
    // Fail closed: no admin action can succeed until a real secret is set.
    if (!warnedAboutFallback) {
      warnedAboutFallback = true;
      console.error(
        "[adminAuth] ADMIN_SECRET_KEY is not set in production. " +
          "All admin routes will reject requests until it is configured — " +
          "the old hardcoded fallback secret is no longer accepted outside development."
      );
    }
    return null;
  }

  return DEV_FALLBACK_SECRET;
}

/** Constant-time string comparison to avoid leaking the secret via response timing. */
function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function isAuthorizedAdmin(req: NextRequest, bodySecret?: string): boolean {
  const expected = getExpectedSecret();
  if (!expected) return false;

  const header = req.headers.get("x-admin-secret");
  const { searchParams } = new URL(req.url);
  const raw = (header || searchParams.get("secretKey") || bodySecret || "").trim();

  return Boolean(raw) && safeEquals(raw, expected);
}
