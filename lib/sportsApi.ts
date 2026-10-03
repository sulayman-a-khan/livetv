/**
 * Shared helpers for the /api/sports/* routes:
 *   1. CORS            — one place to configure cross-origin access
 *   2. Auth            — local PC server shared-secret check (admin auth lives in lib/adminAuth)
 *   3. Validation      — strict allow-list parsing of event payloads (no mass assignment)
 *   4. Serialization   — DB document -> public JSON, with derived status / online flags
 *
 * Server-only. Never import from a client component.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { SPORTS_EVENT_STATUSES, MAX_BACKUP_URLS, isHttpUrl, type SportsEventStatus } from "@/models/SportsEvent";
import { resolveStreamUrl } from "@/lib/streamUrl";

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

/** Heartbeats older than this mean "the PC is offline". Default 90 s, minimum 10 s. */
export function heartbeatTtlMs(): number {
  const sec = Number(process.env.LOCAL_SERVER_HEARTBEAT_TTL_SEC);
  return (Number.isFinite(sec) && sec >= 10 ? sec : 90) * 1000;
}

/* ------------------------------------------------------------------ *
 * 3. Validation
 * ------------------------------------------------------------------ */

export type ParseResult = { ok: true; data: Record<string, unknown> } | { ok: false; errors: string[] };

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseText(value: unknown, field: string, max: number, errors: string[]): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${field} must be a non-empty string`);
    return undefined;
  }
  const v = value.trim();
  if (v.length > max) {
    errors.push(`${field} must be at most ${max} characters`);
    return undefined;
  }
  return v;
}

/**
 * Turns an untrusted request body into a clean update object.
 * Only the whitelisted card fields are ever copied — sourceNode, externalId and
 * lastHeartbeatAt can only be written by the local-server sync, never by this API.
 *
 * create: matchTitle, sportType, startTime, endTime and primaryStreamUrl are required.
 * update: any subset, but at least one field.
 */
export function parseEventPayload(raw: unknown, mode: "create" | "update"): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["Request body must be a JSON object"] };
  }
  const body = raw as Record<string, unknown>;
  const errors: string[] = [];
  const data: Record<string, unknown> = {};
  const has = (k: string) => body[k] !== undefined;

  if (mode === "create") {
    for (const k of ["matchTitle", "sportType", "startTime", "endTime", "primaryStreamUrl"]) {
      if (!has(k)) errors.push(`${k} is required`);
    }
  }

  if (has("matchTitle")) {
    const v = parseText(body.matchTitle, "matchTitle", 200, errors);
    if (v !== undefined) data.matchTitle = v;
  }
  if (has("sportType")) {
    const v = parseText(body.sportType, "sportType", 60, errors);
    if (v !== undefined) data.sportType = v;
  }
  if (has("startTime")) {
    const d = parseDate(body.startTime);
    if (d) data.startTime = d;
    else errors.push("startTime must be a valid ISO date");
  }
  if (has("endTime")) {
    const d = parseDate(body.endTime);
    if (d) data.endTime = d;
    else errors.push("endTime must be a valid ISO date");
  }
  if (data.startTime && data.endTime && (data.endTime as Date) <= (data.startTime as Date)) {
    errors.push("endTime must be later than startTime");
  }

  if (has("status")) {
    if (typeof body.status === "string" && (SPORTS_EVENT_STATUSES as readonly string[]).includes(body.status)) {
      data.status = body.status as SportsEventStatus;
    } else {
      errors.push(`status must be one of: ${SPORTS_EVENT_STATUSES.join(", ")}`);
    }
  }

  if (has("primaryStreamUrl")) {
    const v = typeof body.primaryStreamUrl === "string" ? body.primaryStreamUrl.trim() : "";
    if (v && v.length <= 2048 && isHttpUrl(v)) data.primaryStreamUrl = v;
    else errors.push("primaryStreamUrl must be an absolute http(s) URL (max 2048 chars)");
  }

  if (has("backupStreamUrls")) {
    if (!Array.isArray(body.backupStreamUrls)) {
      errors.push("backupStreamUrls must be an array of URL strings");
    } else {
      const urls: string[] = [];
      for (const item of body.backupStreamUrls) {
        const v = typeof item === "string" ? item.trim() : "";
        if (!v) continue; // ignore blanks
        if (v.length > 2048 || !isHttpUrl(v)) {
          errors.push(`backupStreamUrls contains an invalid http(s) URL: ${String(item).slice(0, 80)}`);
          continue;
        }
        if (!urls.includes(v)) urls.push(v); // de-duplicate, keep order
      }
      if (urls.length > MAX_BACKUP_URLS) errors.push(`backupStreamUrls can hold at most ${MAX_BACKUP_URLS} URLs`);
      data.backupStreamUrls = urls;
    }
  }

  if (has("isLocalServerActive")) {
    if (typeof body.isLocalServerActive === "boolean") data.isLocalServerActive = body.isLocalServerActive;
    else errors.push("isLocalServerActive must be a boolean");
  }

  if (has("priorityOrder")) {
    const n = body.priorityOrder;
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 9999) data.priorityOrder = n;
    else errors.push("priorityOrder must be an integer between 0 and 9999");
  }

  if (mode === "update" && Object.keys(data).length === 0 && errors.length === 0) {
    errors.push("No updatable fields were provided");
  }

  return errors.length ? { ok: false, errors } : { ok: true, data };
}

/** Reads a JSON body, returning null (instead of throwing) when it is missing or malformed. */
export async function readJsonBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ *
 * 4. Serialization
 * ------------------------------------------------------------------ */

/**
 * Status as viewers should see it, derived from the clock so a card never
 * stays "live" after its end time or "scheduled" after it started:
 *   - stored "ended"             -> ended
 *   - endTime passed             -> ended
 *   - "scheduled" + start passed -> live
 *   - otherwise                  -> stored status (so an admin can go live early)
 */
export function effectiveStatus(status: SportsEventStatus, startTime: Date, endTime: Date, now: number): SportsEventStatus {
  if (status === "ended") return "ended";
  if (endTime.getTime() <= now) return "ended";
  if (status === "scheduled" && startTime.getTime() <= now) return "live";
  return status;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeEvent(doc: any, now: number = Date.now(), customBaseUrl?: string) {
  const startTime = doc.startTime ? new Date(doc.startTime) : new Date(now);
  const endTime = doc.endTime ? new Date(doc.endTime) : new Date(now + 3 * 3600 * 1000);

  // Cards owned by the local PC server only count as "active" while its heartbeat is fresh.
  const lastBeat = doc.lastHeartbeatAt ? new Date(doc.lastHeartbeatAt).getTime() : null;
  const heartbeatFresh = lastBeat !== null && now - lastBeat <= heartbeatTtlMs();
  const isLocalServerActive = doc.sourceNode
    ? (doc.isLocalServerActive !== undefined ? (Boolean(doc.isLocalServerActive) || heartbeatFresh) : true)
    : (doc.isLocalServerActive !== undefined ? Boolean(doc.isLocalServerActive) : true);

  const rawStream = (doc.primaryStreamUrl || doc.streamUrl || doc.url || "") as string;
  const stream = resolveStreamUrl(rawStream, customBaseUrl);
  const rawBackups = ((doc.backupStreamUrls || doc.backupUrls || []) as string[]).filter(Boolean);
  const backupStreamUrls = rawBackups.map((u) => resolveStreamUrl(u, customBaseUrl));

  return {
    id: String(doc._id || doc.id || ""),
    _id: String(doc._id || doc.id || ""),
    matchTitle: (doc.matchTitle || doc.title || doc.name || "Live Match") as string,
    sportType: (doc.sportType || doc.sport || doc.category || "Sports") as string,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    status: effectiveStatus(doc.status || "live", startTime, endTime, now),
    primaryStreamUrl: stream,
    streamUrl: stream,
    backupStreamUrls,
    isLocalServerActive,
    priorityOrder: typeof doc.priorityOrder === "number" ? doc.priorityOrder : 99,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}
