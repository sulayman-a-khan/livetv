/**
 * Shared helpers for the cloud API the local PC server talks to:
 *   1. CORS            — one place to configure cross-origin access
 *   2. Auth            — local PC server shared-secret check (admin auth lives in lib/adminAuth)
 *
 * Server-only. Never import from a client component.
 *
 * `SPORTS_CORS_ORIGINS` and `LOCAL_SERVER_SECRET` keep their existing names and
 * defaults: they are what the operator's env and the packaged Origin Control already
 * set and send. An unset origin list still means "allow any origin", and an unset
 * secret still fails closed.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

/* ------------------------------------------------------------------ *
 * 1. CORS
 * ------------------------------------------------------------------ */

const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization, X-Admin-Secret, X-Local-Server-Secret";

/**
 * SPORTS_CORS_ORIGINS is a comma-separated allow-list, e.g.
 *   https://tv.example.com,https://admin.example.com
 * Unset (or containing "*") = allow any origin. That is safe here because the
 * API never uses cookies — every write is protected by a secret header.
 */
function allowedOrigins(): string[] {
  return (process.env.SPORTS_CORS_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function sportsCorsHeaders(req: Request, extra: Record<string, string> = {}): Record<string, string> {
  const allowed = allowedOrigins();
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
  };

  if (allowed.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else {
    headers["Vary"] = "Origin";
    const origin = req.headers.get("origin");
    if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  }

  return { ...headers, ...extra };
}

/** JSON response with CORS + no-store by default. */
export function sportsJson(
  req: Request,
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): NextResponse {
  return NextResponse.json(body, {
    status: init.status ?? 200,
    headers: sportsCorsHeaders(req, { "Cache-Control": "no-store", ...(init.headers || {}) }),
  });
}

/** Answer for CORS preflight (OPTIONS) requests. */
export function sportsPreflight(req: Request): NextResponse {
  return new NextResponse(null, { status: 204, headers: sportsCorsHeaders(req) });
}

/* ------------------------------------------------------------------ *
 * 2. Auth for the local PC server
 * ------------------------------------------------------------------ */

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * The PC server authenticates with `X-Local-Server-Secret: <LOCAL_SERVER_SECRET>`.
 * Fails CLOSED: with no LOCAL_SERVER_SECRET configured, nothing matches
 * (the admin secret can still be used by the caller as an alternative).
 */
export function isAuthorizedLocalServer(req: NextRequest): boolean {
  const expected = process.env.LOCAL_SERVER_SECRET?.trim();
  if (!expected) return false;
  const provided = (req.headers.get("x-local-server-secret") || "").trim();
  return Boolean(provided) && safeEquals(provided, expected);
}
