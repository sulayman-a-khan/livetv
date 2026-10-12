import { NextRequest } from "next/server";
import crypto from "crypto";
import { STREAM_PROXY_PATH } from "@/lib/streamType";

/**
 * Direct-feed IPTV passthrough proxy.
 *
 * Some stream hosts block non-player user agents or send no CORS headers, so
 * the browser can't play them directly. This route adds those two things and
 * hands the media to the client. Xtream-codes providers are NOT handled here
 * anymore — they live in the separate Live Sports Arena area.
 *
 * Entry points (both resolve to one upstream target):
 *   ?url=<absolute feed>  a direct stream/playlist URL (players wrap it like this)
 *   ?ref=<opaque token>   an encrypted absolute URL — used for the child
 *                         links inside a rewritten .m3u8 (see below)
 *
 * Delivery depends on the resolved container:
 *   - `.m3u8` -> the playlist is fetched, and every child URI (variant
 *     playlists, media segments, key/map URIs) is rewritten to
 *     `${STREAM_PROXY_PATH}?ref=<encrypted absolute url>`. Those opaque tokens
 *     keep the raw upstream URLs (which may embed tokens/credentials) on the
 *     server, so hls.js only ever sees our origin. Child requests re-enter
 *     here via `?ref=` and recurse.
 *   - `.ts`   -> piped straight through as video/mp2t.
 *
 * There is NO retry loop and NO session recovery: whatever the upstream does —
 * buffer, drop, 404, or end — is passed straight to the client.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A live feed is endless; let one proxied connection run for the platform's
// full window instead of the default short cap, then end naturally.
export const maxDuration = 60;

/** Headers typical IPTV stream hosts expect from a player. */
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
 * Anti-cache headers. A live feed must never be cached by the browser or
 * Vercel's edge — otherwise, once the upstream session drops, the player can
 * re-read stale bytes instead of the live edge.
 */
const NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
  // Disable any intermediary (nginx/CDN) response buffering so media flushes
  // straight through as a smooth, continuous stream.
  "X-Accel-Buffering": "no",
};

/* ------------------------------------------------------------------ *
 * Opaque target tokens (AES-256-GCM) — keep raw upstream URLs out of
 * the client inside rewritten .m3u8 playlists.
 *
 * The key derives from STREAM_PROXY_SECRET and from nothing else. A
 * source-tree default would be a publicly known key (this repository is
 * public), and whoever holds it can mint `?ref=` tokens that make this
 * route fetch any URL they name — so when the variable is unset or blank
 * the proxy refuses to serve rather than degrading to a guessable key.
 * ------------------------------------------------------------------ */
let cachedCipherKey: Buffer | null | undefined;

/** The derived AES key, or null when the proxy has no secret configured. */
function cipherKey(): Buffer | null {
  if (cachedCipherKey === undefined) {
    const secret = process.env.STREAM_PROXY_SECRET;
    cachedCipherKey = secret
      ? crypto.createHash("sha256").update(secret).digest()
      : null;
  }
  return cachedCipherKey;
}

function b64u(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64u(str: string): Buffer {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function encryptTarget(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return b64u(Buffer.concat([iv, cipher.getAuthTag(), enc]));
}

function decryptTarget(key: Buffer, token: string): string | null {
  try {
    const buf = unb64u(token);
    if (buf.length < 29) return null; // 12 iv + 16 tag + >=1 byte
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Target resolution
 * ------------------------------------------------------------------ */

type StreamFormat = "ts" | "m3u8";

interface ResolvedTarget {
  url: string;
  format: StreamFormat;
}

/** `.m3u8` -> HLS playlist; anything else (`.ts`, segments) -> transport stream. */
function formatFromUrl(url: string): StreamFormat {
  try {
    const path = new URL(url, "http://_local.invalid").pathname.toLowerCase();
    if (path.endsWith(".m3u8")) return "m3u8";
  } catch {
    /* ignore */
  }
  return "ts";
}

/** Resolves the request to a single upstream target (url + container format). */
function resolveTarget(req: NextRequest, key: Buffer): ResolvedTarget | null {
  const params = req.nextUrl.searchParams;

  // 1) Opaque token from a rewritten playlist (already an absolute URL).
  const refParam = (params.get("ref") || "").trim();
  if (refParam) {
    const abs = decryptTarget(key, refParam);
    if (abs && /^https?:\/\//i.test(abs)) return { url: abs, format: formatFromUrl(abs) };
    return null;
  }

  // 2) Direct absolute feed URL.
  const urlParam = (params.get("url") || "").trim();
  if (urlParam && /^https?:\/\//i.test(urlParam)) {
    return { url: urlParam, format: formatFromUrl(urlParam) };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * .m3u8 playlist rewriting
 * ------------------------------------------------------------------ */

/** Rewrites one child URI to an opaque proxied link resolved against the playlist. */
function proxify(key: Buffer, uri: string, baseUrl: string): string {
  try {
    const abs = new URL(uri, baseUrl).toString();
    return `${STREAM_PROXY_PATH}?ref=${encryptTarget(key, abs)}`;
  } catch {
    return uri; // leave un-parseable URIs alone
  }
}

/**
 * Rewrites every URI in an HLS playlist — bare media/variant lines plus any
 * `URI="…"` attribute (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA) — so all children are
 * fetched back through this proxy. Raw upstream URLs stay server-side inside `?ref=`.
 */
function rewritePlaylist(key: Buffer, text: string, baseUrl: string): string {
  return text
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      if (!line) return raw;
      if (line.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_m, u: string) => `URI="${proxify(key, u, baseUrl)}"`);
      }
      return proxify(key, line, baseUrl);
    })
    .join("\n");
}

function badRequest(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: corsHeaders({ "Content-Type": "application/json", ...NO_STORE_HEADERS }),
  });
}

const MISSING_TARGET_MSG =
  "A valid `url` or `ref` query parameter is required";

/**
 * Without its secret the proxy can neither read a `?ref=` token nor hide the
 * child URLs of a playlist, so it serves nothing rather than falling back to a
 * key that is public knowledge. The message names the variable on purpose; the
 * value itself never reaches a log or a response body.
 *
 * Logged once per instance: a live feed re-requests this route every few
 * seconds, so an unconfigured deploy would otherwise flood the platform logs.
 */
let unconfiguredLogged = false;

function proxyUnconfigured() {
  if (!unconfiguredLogged) {
    unconfiguredLogged = true;
    console.error("[/api/stream] STREAM_PROXY_SECRET is not set — proxy disabled");
  }
  return new Response(JSON.stringify({ error: "Stream proxy is not configured" }), {
    status: 500,
    headers: corsHeaders({ "Content-Type": "application/json", ...NO_STORE_HEADERS }),
  });
}

/** Preflight for cross-origin players. */
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function HEAD(req: NextRequest) {
  const key = cipherKey();
  if (!key) return proxyUnconfigured();
  const target = resolveTarget(req, key);
  if (!target) return badRequest(MISSING_TARGET_MSG);
  const contentType =
    target.format === "m3u8" ? "application/vnd.apple.mpegurl" : "video/mp2t";
  return new Response(null, {
    status: 200,
    headers: corsHeaders({ "Content-Type": contentType, ...NO_STORE_HEADERS }),
  });
}

export async function GET(req: NextRequest) {
  const key = cipherKey();
  if (!key) return proxyUnconfigured();
  const target = resolveTarget(req, key);
  if (!target) return badRequest(MISSING_TARGET_MSG);

  let upstream: Response;
  try {
    upstream = await fetch(target.url, {
      headers: UPSTREAM_HEADERS,
      signal: req.signal,
      // Never let the Next.js/Vercel fetch cache retain any of a live feed.
      cache: "no-store",
    });
  } catch (err) {
    // The client left (abort) or the upstream is unreachable — pass it through
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

  if (!upstream.ok) {
    // 401/403/404/etc. — surface the upstream status directly, no recovery.
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

  // ---- HLS: fetch the (small) playlist, rewrite children, hand it back ----
  if (target.format === "m3u8") {
    let text: string;
    try {
      text = await upstream.text();
    } catch (err) {
      console.error("[/api/stream] failed to read playlist", err);
      return new Response(JSON.stringify({ error: "Failed to read upstream playlist" }), {
        status: 502,
        headers: corsHeaders({ "Content-Type": "application/json", ...NO_STORE_HEADERS }),
      });
    }
    const rewritten = rewritePlaylist(key, text, target.url);
    return new Response(rewritten, {
      status: 200,
      headers: corsHeaders({
        "Content-Type": "application/vnd.apple.mpegurl",
        ...NO_STORE_HEADERS,
      }),
    });
  }

  // ---- MPEG-TS: pipe the bytes straight through as one chunked response ----
  if (!upstream.body) {
    return new Response(JSON.stringify({ error: "Upstream returned no body" }), {
      status: 502,
      headers: corsHeaders({ "Content-Type": "application/json", ...NO_STORE_HEADERS }),
    });
  }
  // A brief upstream delay simply means no bytes flow for a moment — we do NOT
  // abort or close on it, so playback stays smooth. The response only ends when
  // the upstream body ends (upstream drop / session expiry), which cleanly
  // signals end-of-feed to mpegts.js.
  return new Response(upstream.body, {
    status: 200,
    headers: corsHeaders({ "Content-Type": "video/mp2t", ...NO_STORE_HEADERS }),
  });
}
