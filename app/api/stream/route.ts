import { NextRequest } from "next/server";
import crypto from "crypto";
import {
  PROVIDERS,
  buildProviderStreamUrl,
  parseProviderKey,
  resolveChannel,
  type ProviderFormat,
} from "@/lib/providers";
import { STREAM_PROXY_PATH } from "@/lib/streamType";

/**
 * Multi-provider IPTV passthrough proxy.
 *
 * The browser can't hit the providers directly: they block non-IPTV user agents
 * and send no CORS headers. This route adds those two things and hands the media
 * to the client WITHOUT ever exposing provider credentials.
 *
 * Entry points (all resolve to one upstream target):
 *   ?channel=<normalizedName>  generic routing via lib/providers (preferred)
 *   ?provider=<p1|p2>&id=<id>  pick a provider explicitly, build {id}.m3u8
 *   ?ref=<opaque token>        an encrypted absolute URL — used for the child
 *                              links inside a rewritten .m3u8 (see below)
 *   ?url=<absolute feed>       legacy direct feed (still supported)
 *   ?id=<xtream stream id>     stream id on the default provider (p1)
 *
 * Provider `p1` (toxicplay1, default) and `p2` (BanglaView) both serve `.m3u8`.
 *
 * Delivery depends on the resolved container:
 *   - `.m3u8` -> the playlist is fetched, and every child URI (variant
 *     playlists, media segments, key/map URIs) is rewritten to
 *     `${STREAM_PROXY_PATH}?ref=<encrypted absolute url>`. Those opaque tokens
 *     keep the credentialed provider URLs on the server, so hls.js only ever
 *     sees our origin. Child requests re-enter here via `?ref=` and recurse.
 *   - `.ts`   -> piped straight through as video/mp2t.
 *
 * There is NO retry loop, NO session recovery, and NO cross-provider fallback:
 * the active provider for a channel is used, and whatever it does — buffer,
 * drop, 404, or end — is passed straight to the client.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A live feed is endless; let one proxied connection run for the platform's
// full window instead of the default short cap, then end naturally.
export const maxDuration = 60;

/** Headers the providers expect from an IPTV player. */
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
 * Opaque target tokens (AES-256-GCM) — hide credentialed provider URLs
 * from the client inside rewritten .m3u8 playlists.
 * ------------------------------------------------------------------ */
const CIPHER_KEY = crypto
  .createHash("sha256")
  .update(process.env.STREAM_PROXY_SECRET || "soluplay-stream-proxy-fallback-key")
  .digest();

function b64u(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64u(str: string): Buffer {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function encryptTarget(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", CIPHER_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return b64u(Buffer.concat([iv, cipher.getAuthTag(), enc]));
}

function decryptTarget(token: string): string | null {
  try {
    const buf = unb64u(token);
    if (buf.length < 29) return null; // 12 iv + 16 tag + >=1 byte
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", CIPHER_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Target resolution
 * ------------------------------------------------------------------ */

interface ResolvedTarget {
  url: string;
  format: ProviderFormat;
}

/** `.m3u8` -> HLS playlist; anything else (`.ts`, segments) -> transport stream. */
function formatFromUrl(url: string): ProviderFormat {
  try {
    const path = new URL(url, "http://_local.invalid").pathname.toLowerCase();
    if (path.endsWith(".m3u8")) return "m3u8";
  } catch {
    /* ignore */
  }
  return "ts";
}

/**
 * If someone stored a provider link WITHOUT credentials
 * (e.g. http://toxicplay1.com/live/1234.ts), inject the matching provider's
 * creds so it still plays. Any other URL is returned untouched.
 */
function applyProviderDefaults(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    for (const p of Object.values(PROVIDERS)) {
      const host = new URL(p.baseUrl).host;
      if (u.host.toLowerCase() !== host.toLowerCase()) continue;
      const parts = u.pathname.split("/").filter(Boolean); // e.g. ["live","1234.ts"]
      if (parts.length === 2 && parts[0].toLowerCase() === "live") {
        return `${p.baseUrl.replace(/\/+$/, "")}/live/${p.username}/${p.password}/${parts[1]}`;
      }
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

/** Resolves the request to a single upstream target (url + container format). */
function resolveTarget(req: NextRequest): ResolvedTarget | null {
  const params = req.nextUrl.searchParams;
  const refParam = (params.get("ref") || "").trim();
  const channelParam = (params.get("channel") || "").trim();
  const urlParam = (params.get("url") || "").trim();
  const idParam = (params.get("id") || "").trim();

  // 1) Opaque token from a rewritten playlist (already an absolute provider URL).
  if (refParam) {
    const abs = decryptTarget(refParam);
    if (abs && /^https?:\/\//i.test(abs)) return { url: abs, format: formatFromUrl(abs) };
    return null;
  }

  // 2) Generic per-channel routing (the preferred entry point).
  if (channelParam) {
    const resolved = resolveChannel(channelParam);
    if (resolved) return { url: resolved.url, format: resolved.format };
    return null; // unknown channel, no active provider, or placeholder id
  }

  // 3) Legacy absolute feed URL.
  if (urlParam && /^https?:\/\//i.test(urlParam)) {
    const abs = applyProviderDefaults(urlParam);
    return { url: abs, format: formatFromUrl(abs) };
  }

  // 4) Provider + Xtream stream id -> `${base}/live/${user}/${pass}/${id}.m3u8`.
  //    `?provider=` selects p1 (default) or p2; a bare `?id=` uses the default.
  if (idParam) {
    if (/^https?:\/\//i.test(idParam)) {
      const abs = applyProviderDefaults(idParam);
      return { url: abs, format: formatFromUrl(abs) };
    }
    if (/^[A-Za-z0-9_-]+$/.test(idParam)) {
      const provider = PROVIDERS[parseProviderKey(params.get("provider"))];
      return { url: buildProviderStreamUrl(provider, idParam), format: provider.format };
    }
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * .m3u8 playlist rewriting
 * ------------------------------------------------------------------ */

/** Rewrites one child URI to an opaque proxied link resolved against the playlist. */
function proxify(uri: string, baseUrl: string): string {
  try {
    const abs = new URL(uri, baseUrl).toString();
    return `${STREAM_PROXY_PATH}?ref=${encryptTarget(abs)}`;
  } catch {
    return uri; // leave un-parseable URIs alone
  }
}

/**
 * Rewrites every URI in an HLS playlist — bare media/variant lines plus any
 * `URI="…"` attribute (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA) — so all children are
 * fetched back through this proxy. Credentials stay server-side inside `?ref=`.
 */
function rewritePlaylist(text: string, baseUrl: string): string {
  return text
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      if (!line) return raw;
      if (line.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_m, u: string) => `URI="${proxify(u, baseUrl)}"`);
      }
      return proxify(line, baseUrl);
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
  "A valid `channel`, `ref`, `provider`+`id`, or `url` query parameter is required";

/** Preflight for cross-origin players. */
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function HEAD(req: NextRequest) {
  const target = resolveTarget(req);
  if (!target) return badRequest(MISSING_TARGET_MSG);
  const contentType =
    target.format === "m3u8" ? "application/vnd.apple.mpegurl" : "video/mp2t";
  return new Response(null, {
    status: 200,
    headers: corsHeaders({ "Content-Type": contentType, ...NO_STORE_HEADERS }),
  });
}

export async function GET(req: NextRequest) {
  const target = resolveTarget(req);
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

  if (!upstream.ok) {
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
    const rewritten = rewritePlaylist(text, target.url);
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
  // the upstream body ends (provider drop / session expiry), which cleanly
  // signals end-of-feed to mpegts.js.
  return new Response(upstream.body, {
    status: 200,
    headers: corsHeaders({ "Content-Type": "video/mp2t", ...NO_STORE_HEADERS }),
  });
}
