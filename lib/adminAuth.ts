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

/** The message every admin route has always answered an unauthorized call with. */
const UNAUTHORIZED_ERROR = "Unauthorized: Invalid Admin Secret Key";

/**
 * The largest admin request body the server will read, in bytes.
 *
 * The cap is what keeps the body-secret fallback from becoming a way to make
 * the server allocate an arbitrary amount of memory: only a request that
 * carries no `x-admin-secret` header is read before the decision is made, and
 * that read is bounded by this budget.
 */
export const MAX_ADMIN_BODY_BYTES = 256 * 1024;

/**
 * The parsed admin request body. Every route declares its own shape; before
 * this helper existed the body came from `req.json()`, which is `any`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdminRequestBody = any;

export type AdminAuthResult =
  | { ok: true; body: AdminRequestBody; credential: "admin" | "bearer" }
  | { ok: false; status: number; error: string };

/**
 * Reads and parses the request body, or null when it is larger than the cap.
 *
 * The declared `content-length` is checked first, so an oversized payload is
 * refused before it is buffered; the byte count of what actually arrived is
 * checked again afterwards, because a chunked request declares no length.
 */
async function readRequestBody(
  req: NextRequest,
  maxBytes: number
): Promise<AdminRequestBody | null> {
  const declared = Number(req.headers.get("content-length") || "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return null;

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A body that is not JSON is treated as an empty one, exactly as the
    // `req.json().catch(() => ({}))` this replaces.
    return {};
  }
}

/**
 * Authorizes an admin request and hands back its parsed body.
 *
 * The credential is decided BEFORE the body is read, so a request that presents
 * a wrong secret is rejected without the server ever buffering its payload.
 *
 * The secret travels in the `x-admin-secret` header or in a `secretKey` body
 * field. The header has always taken precedence, and it still does: a request
 * that presents a wrong header is rejected even when its body carries the
 * right secret. Only a request with NO header falls back to reading the body,
 * and that read is capped.
 *
 * `bearerEnv` names the environment variable whose value may also be presented
 * as `Authorization: Bearer …` — used by the scheduled passes, which hold a
 * narrower credential than the admin secret.
 */
export async function authorizeAdminRequest(
  req: NextRequest,
  options: { maxBodyBytes?: number; bearerEnv?: string } = {}
): Promise<AdminAuthResult> {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_ADMIN_BODY_BYTES;

  const viaRunCredential = options.bearerEnv
    ? isAuthorizedByBearer(req, options.bearerEnv)
    : false;

  if (viaRunCredential) {
    // The run credential wins over the admin secret, exactly as the routes that
    // accept both have always treated it: a scheduled pass is a scheduled pass.
    const body = await readRequestBody(req, maxBodyBytes);
    if (!body) {
      return { ok: false, status: 413, error: "Request body too large" };
    }
    return { ok: true, body, credential: "bearer" };
  }

  if (isAuthorizedAdmin(req)) {
    const body = await readRequestBody(req, maxBodyBytes);
    if (!body) {
      return { ok: false, status: 413, error: "Request body too large" };
    }
    return { ok: true, body, credential: "admin" };
  }

  const header = (req.headers.get("x-admin-secret") || "").trim();
  if (header) {
    // A header was presented and it was wrong. The body does not get a second
    // chance — this is the precedence the routes have always had.
    return { ok: false, status: 401, error: UNAUTHORIZED_ERROR };
  }

  // No header: the secret may still travel in the body. This is the only path
  // that reads the body before the decision, so it is bounded.
  const body = await readRequestBody(req, maxBodyBytes);
  if (!body || !isAuthorizedAdmin(req, typeof body.secretKey === "string" ? body.secretKey : undefined)) {
    return { ok: false, status: 401, error: UNAUTHORIZED_ERROR };
  }
  return { ok: true, body, credential: "admin" };
}

