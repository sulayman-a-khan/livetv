import { NextRequest } from "next/server";

/**
 * MPEG-TS / Xtream passthrough proxy — a clean, direct pipe.
 *
 * The browser can't fetch a raw `.ts` feed from the provider directly: the
 * provider blocks non-IPTV user agents and sends no CORS headers. This route
 * exists only to add those two things and hand the bytes straight through:
 *
 *   browser (mpegts.js) -> /api/stream?id=<streamId>  (or ?url=<absolute .ts>)
 *                       -> http://toxicplay1.com/live/<user>/<pass>/<id>.ts
 *
 * There is deliberately NO retry loop, NO session recovery, and NO buffering
 * wrapper. Whatever the upstream does — buffer, drop, or end — is passed
 * straight to the client, exactly like a normal HTTP stream. mpegts.js on the
 * client decides how to react.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A live feed is endless; let one proxied connection run for the platform's
// full window instead of the default short cap, then end naturally.
export const maxDuration = 60;

/* ------------------------------------------------------------------ *
 * Hardcoded Xtream test credentials (per request — for testing ease)
 * ------------------------------------------------------------------ */
const XTREAM_HOST = "http://toxicplay1.com";
const XTREAM_USER = "1Aoen7elp5";
const XTREAM_PASS = "IgMJ60tmAa";

/** Headers the provider expects from an IPTV player. */
const UPSTREAM_HEADERS: Record<string, string> = {
  "User-Agent": "IPTVSmartersPlayer",
  Accept: "*/*",
};

function corsHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type",
    ...extra,
  };
}

/**
 * Aggressive anti-cache headers. A live TS feed must NEVER be cached by the
 * browser, Vercel's edge, or any intermediary — otherwise, once the upstream
 * session drops (~25s), the player re-reads the same stale bytes from cache and
 * "replays" the first chunk instead of fetching the live edge.
 */
const NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "Surrogate-Control": "no-store",
  // Disable any intermediary (nginx/CDN) response buffering.
  "X-Accel-Buffering": "no",
};

/** Builds the canonical Xtream live transport-stream URL for a stream id. */
function buildXtreamTsUrl(streamId: string): string {
  return `${XTREAM_HOST}/live/${XTREAM_USER}/${XTREAM_PASS}/${streamId}.ts`;
}

/**
 * If someone stored a toxicplay1.com link WITHOUT credentials
 * (e.g. http://toxicplay1.com/live/1234.ts), inject the hardcoded ones so it
 * still plays. Fully-qualified or non-Xtream URLs are returned untouched.
 */
function applyXtreamDefaults(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const xhost = new URL(XTREAM_HOST).host;
    if (u.host.toLowerCase() === xhost.toLowerCase()) {
      const parts = u.pathname.split("/").filter(Boolean); // e.g. ["live","1234.ts"]
      if (parts.length === 2 && parts[0].toLowerCase() === "live") {
        return `${XTREAM_HOST}/live/${XTREAM_USER}/${XTREAM_PASS}/${parts[1]}`;
      }
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

/** Resolves the upstream target from `?url=` (absolute feed) or `?id=`
 *  (Xtream stream id, or an absolute URL passed as id). */
function resolveTarget(req: NextRequest): string | null {
  const params = req.nextUrl.searchParams;
  const urlParam = (params.get("url") || "").trim();
  const idParam = (params.get("id") || "").trim();

  if (urlParam && /^https?:\/\//i.test(urlParam)) return applyXtreamDefaults(urlParam);
  if (idParam) {
    if (/^https?:\/\//i.test(idParam)) return applyXtreamDefaults(idParam);
    // Bare Xtream stream id -> build the credentialed .ts URL.
    if (/^[A-Za-z0-9_-]+$/.test(idParam)) return buildXtreamTsUrl(idParam);
  }
  return null;
}

function badRequest(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: corsHeaders({ "Content-Type": "application/json" }),
  });
}

/** Preflight for cross-origin players. */
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function HEAD(req: NextRequest) {
  const target = resolveTarget(req);
  if (!target) return badRequest("A valid `id` (Xtream stream id) or `url` query parameter is required");
  return new Response(null, {
    status: 200,
    headers: corsHeaders({ "Content-Type": "video/mp2t", ...NO_STORE_HEADERS }),
  });
}

export async function GET(req: NextRequest) {
  const target = resolveTarget(req);
  if (!target) return badRequest("A valid `id` (Xtream stream id) or `url` query parameter is required");

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: UPSTREAM_HEADERS,
      signal: req.signal,
      // Never let the Next.js/Vercel fetch cache retain a chunk of a live feed.
      cache: "no-store",
    });
  } catch (err) {
    // The client left (abort) or the provider is unreachable — pass it through
    // as a gateway error rather than retrying.
    if (req.signal.aborted) {
      return new Response(null, { status: 499, headers: corsHeaders(NO_STORE_HEADERS) });
    }
    console.error("[/api/stream] upstream fetch failed", err);
    return new Response(JSON.stringify({ error: "Upstream connection failed" }), {
      status: 502,
      headers: corsHeaders({ "Content-Type": "application/json", ...NO_STORE_HEADERS }),
    });
  }

  if (!upstream.ok || !upstream.body) {
    // 401/403/404/etc. — surface the provider's status directly, no recovery.
    try {
      await upstream.body?.cancel();
    } catch {
      /* ignore */
    }
    return new Response(JSON.stringify({ error: `Upstream returned ${upstream.status}` }), {
      status: upstream.status || 502,
      headers: corsHeaders({ "Content-Type": "application/json", ...NO_STORE_HEADERS }),
    });
  }

  // Pipe the transport stream straight to the client. The upstream body is a
  // ReadableStream that CLOSES the moment the provider ends/drops the feed
  // (session expiry at ~25s), which in turn ends this response cleanly — so
  // mpegts.js sees end-of-feed and re-requests the live edge rather than
  // replaying buffered bytes. No-store headers keep every layer from caching.
  return new Response(upstream.body, {
    status: 200,
    headers: corsHeaders({ "Content-Type": "video/mp2t", ...NO_STORE_HEADERS }),
  });
}
