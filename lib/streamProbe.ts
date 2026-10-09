/**
 * SoluPlay HLS/M3U8 Stream Health Checker
 * ========================================
 *
 * Replaces the old "does the URL respond with something that smells like
 * HLS" probe with a layered checker that actually understands the HLS
 * protocol:
 *
 *   1. HTTP request       — reachability, status code, redirects, timing
 *   2. Playlist parsing   — is this really an HLS playlist (#EXTM3U), and is
 *                           it a master or media playlist?
 *   3. Variant resolution — for a master playlist, resolve + fetch a variant
 *                           media playlist (RFC 3986 URL resolution, not
 *                           string concatenation)
 *   4. Segment check      — the last 1-3 media segments actually download
 *                           and aren't an HTML error page in disguise
 *   5. Live-refresh check — for live playlists, confirm the segment window
 *                           is actually advancing (best-effort, short)
 *   6. ffprobe (optional) — if ffmpeg/ffprobe is installed on the host, a
 *                           capped probe confirms decodable video/audio
 *   7. Browser gate       — the checks above run server-side, where any header
 *                           can be forged and mixed content doesn't exist. A
 *                           viewer's browser is far stricter, and this app
 *                           relays no media, so a link the browser can never
 *                           fetch is not healthy even when the origin serves it
 *                           happily to us. The gate re-tests what the browser
 *                           will really request, with the headers a browser is
 *                           allowed to send, and demands a CORS grant.
 *   8. Delivery budget    — reachable is not the same as usable. A link has 10
 *                           seconds to hand over real media (a playlist plus a
 *                           segment, or raw `.ts` bytes); a miss is confirmed by
 *                           a second attempt ~15 seconds later, and two of them
 *                           hide the link from viewers until some later check
 *                           delivers.
 *
 * A normal HTTP 200 is never treated as "online" by itself — every one of
 * the steps above has to agree the stream is actually serving playable
 * media before we call it healthy.
 *
 * Backward compatibility: `probeStreamUrl(url, timeoutMs)` keeps its old
 * signature and `{ ok, latency, reason }` shape so every existing caller
 * (`lib/autoHealthChecker.ts`, `app/api/admin/health-check`) keeps working
 * unchanged. The richer result (`checkHlsStream`) is additive.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { isYouTubeUrl } from "@/lib/youtube";
import { isMpegTsUrl } from "@/lib/streamType";
import { normalizeDirectPublicUrl } from "@/lib/freeChannelService";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

/** Fine-grained health status — see the project brief for the meaning of each. */
export type HlsHealthStatus =
  | "ONLINE"
  | "DEGRADED"
  /** The origin serves real media, but no browser on this HTTPS site can fetch it. */
  | "UNPLAYABLE"
  /** Reachable, but it did not put media in our hands inside the delivery budget. */
  | "UNDELIVERABLE"
  | "OFFLINE"
  | "EXPIRED"
  | "BLOCKED"
  | "INVALID"
  | "TIMEOUT"
  | "UNKNOWN";

export type HlsErrorCode =
  | "OK"
  | "DNS_FAILURE"
  | "CONNECTION_REFUSED"
  | "TLS_FAILURE"
  | "TIMEOUT"
  | "PLAYLIST_NOT_FOUND"
  | "PLAYLIST_GONE"
  | "ACCESS_DENIED"
  | "TOKEN_EXPIRED"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "NOT_HLS_PLAYLIST"
  | "HTML_ERROR_PAGE"
  | "NO_VARIANTS"
  | "NO_PLAYABLE_VARIANT"
  | "NO_SEGMENTS_LISTED"
  | "SEGMENTS_UNAVAILABLE"
  | "PARTIAL_SEGMENTS_UNAVAILABLE"
  | "FFPROBE_DECODE_FAILED"
  | "DELIVERY_DEADLINE"
  | "BROWSER_MIXED_CONTENT"
  | "BROWSER_CORS_BLOCKED"
  | "BROWSER_HEADERS_UNSUPPORTED"
  | "UNKNOWN_ERROR";

/** Why a link that the origin serves happily is still impossible in a browser. */
export type BrowserBlocker = "MIXED_CONTENT" | "CORS_BLOCKED" | "HEADERS_REQUIRED";

export const BROWSER_BLOCKER_REASON: Record<BrowserBlocker, string> = {
  MIXED_CONTENT:
    "Plain HTTP origin: a page served over HTTPS is not allowed to load it, and this app relays no media",
  CORS_BLOCKED:
    "The origin never sends Access-Control-Allow-Origin, so the player cannot read the playlist or segments",
  HEADERS_REQUIRED:
    "Only reachable with request headers (Referer/Origin/Authorization) a browser is not allowed to send",
};

export type PlaylistType = "MASTER" | "MEDIA" | null;

export interface HlsCheckResult {
  /** Backward-compat: true only for a fully healthy (ONLINE) stream. */
  ok: boolean;
  /** Backward-compat: round-trip time of the primary playlist request, ms. */
  latency: number;
  /** Backward-compat: short human-readable reason, set whenever ok=false. */
  reason?: string;

  status: HlsHealthStatus;
  errorCode: HlsErrorCode;
  httpStatus: number | null;
  responseTime: number;
  finalUrl?: string;
  playlistType: PlaylistType;
  isLive: boolean | null;
  segmentCount: number | null;
  latestSegment: string | null;
  newSegmentDetected: boolean | null;
  video: boolean | null;
  audio: boolean | null;
  resolution: string | null;
  codec: string | null;
  fps: number | null;
  attempts: number;
  checkedAt: string;
  error: string | null;
  /**
   * Whether the origin granted the cross-origin read a browser needs.
   * `null` means it could not be judged — the probe did not know this
   * deployment's own origin, so no browser-real `Origin` header was sent.
   * Never treat null as "blocked".
   */
  browserCors: boolean | null;
  /** Set only when `status === "UNPLAYABLE"`. */
  browserBlocker: BrowserBlocker | null;
  /**
   * Delivery attempts that ran out the 10-second budget inside this probe run.
   * Zero whenever media arrived in time; `UNDELIVERABLE` only ever carries it.
   */
  deliveryMisses: number;
}

/** Kept for backward compatibility with existing imports. */
export type ProbeResult = HlsCheckResult;

export interface ProbeOptions {
  /** Per-request timeout for the playlist/segment fetches. Default 5000ms. */
  timeoutMs?: number;
  /** How many of the most recent segments to sample. Default 2, max 3. */
  segmentSampleSize?: number;
  /** Whether to re-fetch a live playlist after a short delay to confirm it's advancing. Default true. */
  checkLiveRefresh?: boolean;
  /** Delay before the live-refresh re-check, ms. Default 3500. */
  liveRefreshDelayMs?: number;
  /** Whether to attempt an ffprobe decode confirmation when ffmpeg is installed. Default true. */
  useFfprobe?: boolean;
  /** Max attempts for the retry/backoff wrapper. Default 3. */
  maxAttempts?: number;
  /**
   * How long a link gets to put real media in our hands — playlist plus a
   * segment, or raw `.ts` bytes — before the attempt counts as a delivery miss.
   * Default 10000ms.
   */
  deliveryDeadlineMs?: number;
  /** Wait before the confirming delivery retry. Default 15000ms. */
  deliveryConfirmDelayMs?: number;
  /** Extra headers merged over the defaults (User-Agent, Referer, Origin, Authorization, Cookie...). */
  headers?: Record<string, string>;
}

const DEFAULTS = {
  timeoutMs: 5000,
  segmentSampleSize: 2,
  checkLiveRefresh: true,
  liveRefreshDelayMs: 3500,
  useFfprobe: true,
  maxAttempts: 3,
  deliveryDeadlineMs: 10_000,
  deliveryConfirmDelayMs: 15_000,
};

/**
 * Misses required before a link is called undeliverable. One slow read is a
 * bad second; two, ~15 seconds apart, is a link that cannot serve a viewer.
 */
const DELIVERY_MISSES_TO_CONFIRM = 2;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Query-string keys that typically carry a signed-URL token/expiry. */
const TOKEN_PARAM_NAMES = new Set([
  "token",
  "sig",
  "signature",
  "auth",
  "authorization",
  "key",
  "expires",
  "expire",
  "policy",
  "key-pair-id",
  "hdnts",
  "hdntl",
  "st",
  "e",
]);

/** Masks likely token/signature values before a URL is ever written to a log. */
function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    let touched = false;
    for (const key of Array.from(u.searchParams.keys())) {
      if (TOKEN_PARAM_NAMES.has(key.toLowerCase())) {
        u.searchParams.set(key, "***");
        touched = true;
      }
    }
    const base = `${u.origin}${u.pathname}`;
    return touched ? `${base}?${u.searchParams.toString()}` : `${base}${u.search}`;
  } catch {
    // Not a parseable absolute URL — just truncate defensively.
    return rawUrl.length > 80 ? `${rawUrl.slice(0, 80)}…` : rawUrl;
  }
}

/** True if the URL looks like it carries a signed token/expiry — used to tell EXPIRED apart from BLOCKED. */
function looksLikeSignedUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    for (const key of u.searchParams.keys()) {
      if (TOKEN_PARAM_NAMES.has(key.toLowerCase())) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Resolves a (possibly relative) playlist/segment URI against its parent playlist URL — real RFC 3986 resolution, never string concatenation. */
function resolveUrl(uri: string, baseUrl: string): string | null {
  try {
    return new URL(uri.trim(), baseUrl).toString();
  } catch {
    return null;
  }
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const origin = siteOrigin();
  return {
    "User-Agent": DEFAULT_USER_AGENT,
    Accept: "*/*",
    // A viewer's browser always identifies where the request came from, and a
    // CDN's CORS answer depends on it. Probing without an Origin would get an
    // answer no browser ever receives.
    ...(origin ? { Origin: origin, Referer: `${origin}/` } : {}),
    ...extra,
  };
}

/**
 * This deployment's own browser origin, or null when it cannot be known (local
 * runs). The CORS verdict needs it: an `Origin` we never sent is a CORS answer
 * we never got, so without it the gate stays silent instead of guessing.
 */
function siteOrigin(): string | null {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host ? `https://${host}` : null;
}

function isLocalHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 169;
}

/**
 * The URL a viewer's browser really requests. `normalizeDirectPublicUrl` builds
 * the watch page's ladder, so probing anything else would test a URL nobody
 * ever plays — notably an `http://` link the app upgrades to HTTPS before use.
 */
function browserPlaybackUrl(rawUrl: string): string {
  return normalizeDirectPublicUrl(rawUrl) || rawUrl.trim();
}

/**
 * The direct-play rules bind only links the browser fetches from the origin
 * itself. Local/LAN hosts, Cloudflare tunnels and `/live/` forwarder paths are
 * reached through the secured relay, whose own rules are not these ones, so
 * they keep the ordinary checks.
 */
function isRelayedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      isLocalHost(host) ||
      host.endsWith(".trycloudflare.com") ||
      parsed.pathname.includes("/live/")
    );
  } catch {
    return true; // unreadable URL: nothing to judge from a browser's point of view
  }
}

interface FetchOutcome {
  response: Response | null;
  responseTime: number;
  errorCode: HlsErrorCode | null;
  errorMessage: string | null;
}

/** fetch() with a hard timeout and Node/undici error classification (DNS, TLS, connection refused, abort). */
async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<FetchOutcome> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, responseTime: Date.now() - start, errorCode: null, errorMessage: null };
  } catch (err: unknown) {
    const responseTime = Date.now() - start;
    const e = err as { name?: string; message?: string; cause?: { code?: string } };

    if (e?.name === "AbortError") {
      return { response: null, responseTime, errorCode: "TIMEOUT", errorMessage: "Request timed out" };
    }

    const code = e?.cause?.code || "";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return { response: null, responseTime, errorCode: "DNS_FAILURE", errorMessage: "DNS lookup failed" };
    }
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") {
      return {
        response: null,
        responseTime,
        errorCode: "CONNECTION_REFUSED",
        errorMessage: `Connection failed (${code})`,
      };
    }
    if (code.startsWith("CERT_") || code.startsWith("ERR_TLS") || code.includes("SSL")) {
      return { response: null, responseTime, errorCode: "TLS_FAILURE", errorMessage: `TLS error (${code})` };
    }

    return {
      response: null,
      responseTime,
      errorCode: "UNKNOWN_ERROR",
      errorMessage: e?.message || "Network request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Reads at most `maxBytes` of a response body as text, then cancels the underlying connection — never buffers a whole (potentially endless) stream. */
async function readBodyCapped(
  response: Response,
  maxBytes: number
): Promise<{ text: string; bytesRead: number }> {
  if (!response.body) {
    const text = await response.text().catch(() => "");
    return { text, bytesRead: text.length };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let collected = 0;
  try {
    while (collected < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        const remaining = maxBytes - collected;
        const piece = value.length > remaining ? value.subarray(0, remaining) : value;
        chunks.push(piece);
        collected += piece.length;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(collected);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), bytesRead: collected };
}

function looksLikeHtmlErrorPage(text: string, contentType: string): boolean {
  const lower = text.toLowerCase();
  return (
    contentType.includes("text/html") ||
    lower.includes("<!doctype html") ||
    lower.includes("<html") ||
    lower.includes("<head") ||
    lower.includes("access denied") ||
    lower.includes("404 not found") ||
    lower.includes("error 404") ||
    lower.includes("stream offline") ||
    lower.includes("forbidden")
  );
}

/* ------------------------------------------------------------------ *
 * M3U8 parsing
 * ------------------------------------------------------------------ */

interface ParsedVariant {
  uri: string;
  bandwidth: number | null;
  resolution: string | null;
}

interface ParsedSegment {
  uri: string;
  duration: number | null;
}

interface ParsedPlaylist {
  isValidHls: boolean;
  isMaster: boolean;
  variants: ParsedVariant[];
  segments: ParsedSegment[];
  isLive: boolean;
  hasEndlist: boolean;
}

/** Parses an M3U8 body. Deliberately tolerant of unknown tags — HLS has many
 *  vendor extensions we don't need to understand to check basic health. */
function parseM3U8(text: string): ParsedPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  // #EXTM3U must be the first non-blank line of a real playlist.
  const firstMeaningful = lines.find((l) => l.length > 0);
  const isValidHls = firstMeaningful === "#EXTM3U";

  const variants: ParsedVariant[] = [];
  const segments: ParsedSegment[] = [];
  let hasEndlist = false;
  let pendingDuration: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const attrs = line.substring(line.indexOf(":") + 1);
      const bandwidthMatch = attrs.match(/BANDWIDTH=(\d+)/i);
      const resolutionMatch = attrs.match(/RESOLUTION=(\d+x\d+)/i);
      // The URI is the next non-blank, non-comment line.
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith("#"))) j++;
      const uri = j < lines.length ? lines[j] : null;
      if (uri) {
        variants.push({
          uri,
          bandwidth: bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : null,
          resolution: resolutionMatch ? resolutionMatch[1] : null,
        });
      }
      continue;
    }

    if (line.startsWith("#EXTINF")) {
      const durMatch = line.match(/#EXTINF:([\d.]+)/);
      pendingDuration = durMatch ? parseFloat(durMatch[1]) : null;
      continue;
    }

    if (line.startsWith("#EXT-X-ENDLIST")) {
      hasEndlist = true;
      continue;
    }

    // A non-comment line following #EXTINF is a media segment URI
    // (works for both .ts and fMP4 .m4s segments).
    if (!line.startsWith("#") && pendingDuration !== null) {
      segments.push({ uri: line, duration: pendingDuration });
      pendingDuration = null;
    }
  }

  return {
    isValidHls,
    isMaster: variants.length > 0,
    variants,
    segments,
    // A playlist without #EXT-X-ENDLIST is a live/ongoing playlist by definition.
    isLive: isValidHls && !hasEndlist,
    hasEndlist,
  };
}

/** Picks the lowest-bandwidth variant — we're checking health, not quality, so use the least bandwidth necessary. */
function pickCheapestVariant(variants: ParsedVariant[]): ParsedVariant | null {
  if (variants.length === 0) return null;
  const withBandwidth = variants.filter((v) => v.bandwidth !== null);
  if (withBandwidth.length === 0) return variants[0];
  return withBandwidth.reduce((lowest, v) => ((v.bandwidth as number) < (lowest.bandwidth as number) ? v : lowest));
}

/* ------------------------------------------------------------------ *
 * Segment verification
 * ------------------------------------------------------------------ */

interface SegmentCheckOutcome {
  ok: boolean;
  status: number | null;
  bytesRead: number;
  acao: string | null;
}

/** Verifies one media segment is actually downloadable and isn't an HTML error page. HEAD first (cheap); falls back to a small ranged GET for CDNs that don't implement HEAD correctly. */
async function checkSegment(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<SegmentCheckOutcome> {
  let acao: string | null = null;
  const remember = (response: Response | null) => {
    const value = response?.headers.get("access-control-allow-origin") || null;
    if (value) acao = value;
    return value;
  };

  const head = await timedFetch(url, { method: "HEAD", headers }, timeoutMs);
  if (head.response) remember(head.response);
  if (head.response && (head.response.ok || head.response.status === 206)) {
    const len = parseInt(head.response.headers.get("content-length") || "0", 10);
    if (len > 0 || head.response.status === 206) {
      return { ok: true, status: head.response.status, bytesRead: len, acao };
    }
    // HEAD succeeded but reported 0 bytes — verify with a real GET before giving up on it.
  }

  const get = await timedFetch(
    url,
    { method: "GET", headers: { ...headers, Range: "bytes=0-4096" } },
    timeoutMs
  );
  if (!get.response) return { ok: false, status: null, bytesRead: 0, acao };
  remember(get.response);
  if (!get.response.ok && get.response.status !== 206) {
    return { ok: false, status: get.response.status, bytesRead: 0, acao };
  }

  const contentType = (get.response.headers.get("content-type") || "").toLowerCase();
  const { text, bytesRead } = await readBodyCapped(get.response, 4096);
  if (bytesRead === 0) return { ok: false, status: get.response.status, bytesRead: 0, acao };
  if (looksLikeHtmlErrorPage(text, contentType)) {
    return { ok: false, status: get.response.status, bytesRead, acao };
  }
  return { ok: true, status: get.response.status, bytesRead, acao };
}

/* ------------------------------------------------------------------ *
 * ffprobe (optional layer)
 * ------------------------------------------------------------------ */

let ffprobeAvailable: boolean | null = null;

async function isFfprobeAvailable(): Promise<boolean> {
  if (ffprobeAvailable !== null) return ffprobeAvailable;
  try {
    await execFileAsync("ffprobe", ["-version"], { timeout: 2000 });
    ffprobeAvailable = true;
  } catch {
    ffprobeAvailable = false;
    console.log("[StreamProbe] ffprobe not found on this host — skipping the optional decode-confirmation layer.");
  }
  return ffprobeAvailable;
}

interface FfprobeOutcome {
  ok: boolean;
  video: boolean;
  audio: boolean;
  resolution: string | null;
  codec: string | null;
  fps: number | null;
  error: string | null;
}

/** Runs a strictly-bounded ffprobe pass: capped analyze/probe size, capped
 *  wall-clock duration, at most ~2s of media read. Never used for recording —
 *  only to confirm the media actually decodes into real video/audio streams. */
async function runFfprobe(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<FfprobeOutcome> {
  const headerBlock = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...(headerBlock ? ["-headers", `${headerBlock}\r\n`] : []),
    "-analyzeduration",
    "3000000", // 3s of analysis, microseconds
    "-probesize",
    "2000000", // ~2MB max probe read
    "-i",
    url,
    "-t",
    "2", // never read more than ~2s of media
    "-show_entries",
    "stream=codec_type,codec_name,width,height,avg_frame_rate",
    "-show_format",
    "-print_format",
    "json",
  ];

  try {
    const { stdout } = await execFileAsync("ffprobe", args, {
      timeout: timeoutMs, // hard wall-clock cap — kills ffprobe if it runs long
      maxBuffer: 2 * 1024 * 1024,
    });

    const parsed = JSON.parse(stdout || "{}") as {
      streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }[];
    };
    const streams = parsed.streams || [];
    const videoStream = streams.find((s) => s.codec_type === "video");
    const audioStream = streams.find((s) => s.codec_type === "audio");

    if (!videoStream && !audioStream) {
      return { ok: false, video: false, audio: false, resolution: null, codec: null, fps: null, error: "No decodable streams found" };
    }

    let fps: number | null = null;
    if (videoStream?.avg_frame_rate && videoStream.avg_frame_rate !== "0/0") {
      const [num, den] = videoStream.avg_frame_rate.split("/").map(Number);
      if (den) fps = Math.round((num / den) * 100) / 100;
    }

    return {
      ok: true,
      video: Boolean(videoStream),
      audio: Boolean(audioStream),
      resolution: videoStream?.width && videoStream?.height ? `${videoStream.width}x${videoStream.height}` : null,
      codec: videoStream?.codec_name || audioStream?.codec_name || null,
      fps,
      error: null,
    };
  } catch (err: unknown) {
    const e = err as { message?: string; killed?: boolean };
    return {
      ok: false,
      video: false,
      audio: false,
      resolution: null,
      codec: null,
      fps: null,
      error: e?.killed ? "ffprobe exceeded the time budget" : e?.message || "ffprobe failed",
    };
  }
}

/* ------------------------------------------------------------------ *
 * Result builders
 * ------------------------------------------------------------------ */

function baseResult(overrides: Partial<HlsCheckResult>): HlsCheckResult {
  const status = overrides.status || "UNKNOWN";
  return {
    ok: status === "ONLINE",
    latency: overrides.responseTime ?? 0,
    reason: status === "ONLINE" ? undefined : overrides.error || status,
    status,
    errorCode: overrides.errorCode || "UNKNOWN_ERROR",
    httpStatus: overrides.httpStatus ?? null,
    responseTime: overrides.responseTime ?? 0,
    finalUrl: overrides.finalUrl,
    playlistType: overrides.playlistType ?? null,
    isLive: overrides.isLive ?? null,
    segmentCount: overrides.segmentCount ?? null,
    latestSegment: overrides.latestSegment ?? null,
    newSegmentDetected: overrides.newSegmentDetected ?? null,
    video: overrides.video ?? null,
    audio: overrides.audio ?? null,
    resolution: overrides.resolution ?? null,
    codec: overrides.codec ?? null,
    fps: overrides.fps ?? null,
    attempts: overrides.attempts ?? 1,
    checkedAt: new Date().toISOString(),
    error: overrides.error ?? null,
    browserCors: overrides.browserCors ?? null,
    browserBlocker: overrides.browserBlocker ?? null,
    deliveryMisses: overrides.deliveryMisses ?? 0,
  };
}

/** Rewrites an otherwise-healthy result as "the browser can never fetch this". */
function asUnplayable(
  result: HlsCheckResult,
  blocker: BrowserBlocker,
  checkedUrl: string
): HlsCheckResult {
  const reason = BROWSER_BLOCKER_REASON[blocker];
  const errorCode: HlsErrorCode =
    blocker === "MIXED_CONTENT"
      ? "BROWSER_MIXED_CONTENT"
      : blocker === "CORS_BLOCKED"
        ? "BROWSER_CORS_BLOCKED"
        : "BROWSER_HEADERS_UNSUPPORTED";
  return {
    ...result,
    ok: false,
    status: "UNPLAYABLE",
    errorCode,
    latency: result.responseTime,
    reason,
    finalUrl: checkedUrl || result.finalUrl,
    error: reason,
    browserBlocker: blocker,
  };
}

/** Classifies a non-2xx/206 HTTP status into a health status + error code. */
function classifyHttpStatus(status: number, url: string): { status: HlsHealthStatus; errorCode: HlsErrorCode } {
  if (status === 404) return { status: "OFFLINE", errorCode: "PLAYLIST_NOT_FOUND" };
  if (status === 410) return { status: "EXPIRED", errorCode: "PLAYLIST_GONE" };
  if (status === 403) {
    return looksLikeSignedUrl(url)
      ? { status: "EXPIRED", errorCode: "TOKEN_EXPIRED" }
      : { status: "BLOCKED", errorCode: "ACCESS_DENIED" };
  }
  if (status === 429) return { status: "DEGRADED", errorCode: "RATE_LIMITED" };
  if (status >= 500) return { status: "OFFLINE", errorCode: "SERVER_ERROR" };
  return { status: "OFFLINE", errorCode: "SERVER_ERROR" };
}

/* ------------------------------------------------------------------ *
 * One full pass through steps 1-6 (no retry — the caller wraps this)
 * ------------------------------------------------------------------ */

/**
 * A link that answers, but not in time, is useless to a viewer who pressed play
 * ten seconds ago. Every fetch before the first media bytes land is clamped to
 * this budget, and the pass reports `UNDELIVERABLE` once it runs out — it is the
 * caller that decides whether one miss means anything.
 */
function deliveryMiss(deadlineMs: number, elapsedMs: number): HlsCheckResult {
  const reason = `No media delivered within ${Math.round(deadlineMs / 1000)}s (took ${Math.round(elapsedMs)}s)`;
  return baseResult({
    status: "UNDELIVERABLE",
    errorCode: "DELIVERY_DEADLINE",
    responseTime: elapsedMs,
    error: reason,
    deliveryMisses: 1,
  });
}

async function probeOnce(
  url: string,
  options: typeof DEFAULTS & { headers?: Record<string, string> }
): Promise<HlsCheckResult> {
  const headers = buildHeaders(options.headers);

  // The delivery budget starts here and stops mattering the moment real media
  // is in hand — the checks after that point (live refresh, ffprobe) are
  // diagnostics, not whether a viewer gets a picture.
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const budgetLeft = () => options.deliveryDeadlineMs - elapsed();
  /** Timeout for the next fetch: never longer than what the budget allows. */
  const clipped = (timeoutMs: number) => Math.max(1, Math.min(timeoutMs, budgetLeft()));
  const outOfTime = () => budgetLeft() <= 0;

  // The player fetches every playlist and every segment with XHR, so each
  // response it touches needs the browser's permission slip. Without a known
  // site origin we sent no `Origin` header, so the answer tells us nothing —
  // `corsGranted` stays null and the gate keeps quiet.
  const originKnown = Boolean(siteOrigin());
  let corsGranted: boolean | null = originKnown ? true : null;
  const noteCors = (response: Response | null) => {
    if (!originKnown) return;
    if (!response || !response.headers.get("access-control-allow-origin")) corsGranted = false;
  };

  // ---- STEP 1: HTTP request for the playlist itself ----
  const playlistFetch = await timedFetch(url, { method: "GET", headers }, clipped(options.timeoutMs));

  if (!playlistFetch.response) {
    // Nothing came back before the budget ran out: that is a delivery miss,
    // whatever the individual request would have called itself.
    if (outOfTime()) return deliveryMiss(options.deliveryDeadlineMs, elapsed());
    return baseResult({
      status: playlistFetch.errorCode === "TIMEOUT" ? "TIMEOUT" : "OFFLINE",
      errorCode: playlistFetch.errorCode || "UNKNOWN_ERROR",
      responseTime: playlistFetch.responseTime,
      error: playlistFetch.errorMessage,
    });
  }

  const response = playlistFetch.response;
  const finalUrl = response.url || url;
  noteCors(response);

  if (!response.ok && response.status !== 206) {
    const { status, errorCode } = classifyHttpStatus(response.status, url);
    return baseResult({
      status,
      errorCode,
      httpStatus: response.status,
      responseTime: playlistFetch.responseTime,
      finalUrl,
      error: `HTTP ${response.status}`,
    });
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  // Playlists are plain text and small — a generous cap still protects us
  // from a misconfigured server handing back an entire video as "the playlist".
  const { text: body } = await readBodyCapped(response, 512 * 1024);

  if (looksLikeHtmlErrorPage(body, contentType)) {
    return baseResult({
      status: "INVALID",
      errorCode: "HTML_ERROR_PAGE",
      httpStatus: response.status,
      responseTime: playlistFetch.responseTime,
      finalUrl,
      error: "Server returned an HTML error page instead of a playlist",
    });
  }

  // ---- STEP 2: Validate this is actually an HLS playlist ----
  const parsed = parseM3U8(body);
  if (!parsed.isValidHls) {
    return baseResult({
      status: "INVALID",
      errorCode: "NOT_HLS_PLAYLIST",
      httpStatus: response.status,
      responseTime: playlistFetch.responseTime,
      finalUrl,
      error: "Response is not a valid HLS playlist (missing #EXTM3U)",
    });
  }

  let mediaPlaylistUrl = finalUrl;
  let mediaParsed = parsed;
  const playlistType: PlaylistType = parsed.isMaster ? "MASTER" : "MEDIA";

  // A playlist alone is not a picture: the budget still has to cover a segment.
  if (outOfTime()) return deliveryMiss(options.deliveryDeadlineMs, elapsed());

  // ---- STEP 3: Master playlist -> resolve + fetch a playable variant ----
  if (parsed.isMaster) {
    if (parsed.variants.length === 0) {
      return baseResult({
        status: "INVALID",
        errorCode: "NO_VARIANTS",
        httpStatus: response.status,
        responseTime: playlistFetch.responseTime,
        finalUrl,
        playlistType: "MASTER",
        error: "Master playlist declares no variant streams",
      });
    }

    // Try variants cheapest-first, falling back to the next if one fails —
    // some providers leave a stale/broken low-bitrate rendition behind.
    const orderedVariants = [...parsed.variants].sort((a, b) => (a.bandwidth ?? 0) - (b.bandwidth ?? 0));
    let resolvedOk = false;

    for (const variant of orderedVariants.slice(0, 3)) {
      const variantUrl = resolveUrl(variant.uri, finalUrl);
      if (!variantUrl) continue;
      if (outOfTime()) return deliveryMiss(options.deliveryDeadlineMs, elapsed());

      const variantFetch = await timedFetch(variantUrl, { method: "GET", headers }, clipped(options.timeoutMs));
      if (!variantFetch.response || (!variantFetch.response.ok && variantFetch.response.status !== 206)) {
        continue;
      }
      const variantBody = await readBodyCapped(variantFetch.response, 512 * 1024);
      if (
        looksLikeHtmlErrorPage(
          variantBody.text,
          (variantFetch.response.headers.get("content-type") || "").toLowerCase()
        )
      ) {
        continue;
      }
      const parsedVariant = parseM3U8(variantBody.text);
      if (!parsedVariant.isValidHls || parsedVariant.isMaster) continue; // a master pointing to another master is unusual; don't recurse further

      mediaPlaylistUrl = variantFetch.response.url || variantUrl;
      mediaParsed = parsedVariant;
      resolvedOk = true;
      noteCors(variantFetch.response);
      break;
    }

    if (!resolvedOk) {
      if (outOfTime()) return deliveryMiss(options.deliveryDeadlineMs, elapsed());
      return baseResult({
        status: "OFFLINE",
        errorCode: "NO_PLAYABLE_VARIANT",
        httpStatus: response.status,
        responseTime: playlistFetch.responseTime,
        finalUrl,
        playlistType: "MASTER",
        error: "None of the declared variant streams were reachable",
      });
    }
  }

  if (outOfTime()) return deliveryMiss(options.deliveryDeadlineMs, elapsed());

  // ---- STEP 4: Check the most recent media segments ----
  if (mediaParsed.segments.length === 0) {
    return baseResult({
      status: "DEGRADED",
      errorCode: "NO_SEGMENTS_LISTED",
      httpStatus: response.status,
      responseTime: playlistFetch.responseTime,
      finalUrl: mediaPlaylistUrl,
      playlistType,
      isLive: mediaParsed.isLive,
      segmentCount: 0,
      browserCors: corsGranted,
      error: "Playlist parsed but currently lists no media segments",
    });
  }

  const sampleSize = Math.max(1, Math.min(3, options.segmentSampleSize));
  const sampledSegments = mediaParsed.segments.slice(-sampleSize);
  const segmentResults: SegmentCheckOutcome[] = [];
  for (const seg of sampledSegments) {
    const segUrl = resolveUrl(seg.uri, mediaPlaylistUrl);
    if (!segUrl) {
      segmentResults.push({ ok: false, status: null, bytesRead: 0, acao: null });
      continue;
    }
    // One segment in hand is the delivery proof the budget was waiting for, so
    // from here on a spent budget is simply "no more sampling".
    if (outOfTime()) {
      if (segmentResults.some((s) => s.ok)) break;
      return deliveryMiss(options.deliveryDeadlineMs, elapsed());
    }
    segmentResults.push(
      await checkSegment(segUrl, headers, Math.min(clipped(options.timeoutMs), 6000))
    );
  }

  const okSegments = segmentResults.filter((s) => s.ok).length;
  const latestSegment = mediaParsed.segments[mediaParsed.segments.length - 1]?.uri || null;
  // A downloadable segment the browser is not allowed to read is as good as
  // missing for a viewer — the player fails on the very first fragment.
  if (originKnown && segmentResults.some((s) => s.ok && !s.acao)) corsGranted = false;

  if (okSegments === 0) {
    if (outOfTime()) return deliveryMiss(options.deliveryDeadlineMs, elapsed());
    return baseResult({
      status: "OFFLINE",
      errorCode: "SEGMENTS_UNAVAILABLE",
      httpStatus: response.status,
      responseTime: playlistFetch.responseTime,
      finalUrl: mediaPlaylistUrl,
      playlistType,
      isLive: mediaParsed.isLive,
      segmentCount: mediaParsed.segments.length,
      latestSegment,
      error: "Playlist is valid but none of its media segments are downloadable",
    });
  }

  if (okSegments < segmentResults.length) {
    return baseResult({
      status: "DEGRADED",
      errorCode: "PARTIAL_SEGMENTS_UNAVAILABLE",
      httpStatus: response.status,
      responseTime: playlistFetch.responseTime,
      finalUrl: mediaPlaylistUrl,
      playlistType,
      isLive: mediaParsed.isLive,
      segmentCount: mediaParsed.segments.length,
      latestSegment,
      browserCors: corsGranted,
      error: `${segmentResults.length - okSegments}/${segmentResults.length} sampled segments failed`,
    });
  }

  // ---- STEP 5: For live playlists, confirm the segment window is advancing ----
  let newSegmentDetected: boolean | null = null;
  if (mediaParsed.isLive && options.checkLiveRefresh) {
    await sleep(options.liveRefreshDelayMs);
    const refetch = await timedFetch(mediaPlaylistUrl, { method: "GET", headers }, options.timeoutMs);
    if (refetch.response && (refetch.response.ok || refetch.response.status === 206)) {
      noteCors(refetch.response);
      const refetchBody = await readBodyCapped(refetch.response, 512 * 1024);
      const reparsed = parseM3U8(refetchBody.text);
      const newLatest = reparsed.segments[reparsed.segments.length - 1]?.uri || null;
      // A static/VOD-like live playlist isn't automatically unhealthy — some
      // legitimate encoders use long segment durations — this is purely
      // informational and never downgrades an otherwise-healthy stream.
      newSegmentDetected = Boolean(newLatest && newLatest !== latestSegment);
    }
  }

  // ---- STEP 6: Optional ffprobe decode confirmation ----
  let video: boolean | null = null;
  let audio: boolean | null = null;
  let resolution: string | null = null;
  let codec: string | null = null;
  let fps: number | null = null;
  let ffprobeFailed = false;

  if (options.useFfprobe && (await isFfprobeAvailable())) {
    const probeTarget =
      resolveUrl(sampledSegments[sampledSegments.length - 1]?.uri || "", mediaPlaylistUrl) || mediaPlaylistUrl;
    const ff = await runFfprobe(probeTarget, headers, Math.min(options.timeoutMs + 2000, 8000));
    video = ff.video;
    audio = ff.audio;
    resolution = ff.resolution;
    codec = ff.codec;
    fps = ff.fps;
    ffprobeFailed = !ff.ok;
  }

  if (ffprobeFailed) {
    return baseResult({
      status: "DEGRADED",
      errorCode: "FFPROBE_DECODE_FAILED",
      httpStatus: response.status,
      responseTime: playlistFetch.responseTime,
      finalUrl: mediaPlaylistUrl,
      playlistType,
      isLive: mediaParsed.isLive,
      segmentCount: mediaParsed.segments.length,
      latestSegment,
      newSegmentDetected,
      video,
      audio,
      resolution,
      codec,
      fps,
      browserCors: corsGranted,
      error: "HTTP checks passed but ffprobe could not decode the media",
    });
  }

  // ---- Every layer agrees: this stream is genuinely healthy ----
  return baseResult({
    status: "ONLINE",
    errorCode: "OK",
    httpStatus: response.status,
    responseTime: playlistFetch.responseTime,
    finalUrl: mediaPlaylistUrl,
    playlistType,
    isLive: mediaParsed.isLive,
    segmentCount: mediaParsed.segments.length,
    latestSegment,
    newSegmentDetected,
    video,
    audio,
    codec,
    resolution,
    fps,
    browserCors: corsGranted,
    error: null,
  });
}

/** Failure statuses worth retrying — transient/network-shaped, not content-deterministic. */
const RETRYABLE_STATUSES: HlsHealthStatus[] = ["TIMEOUT", "OFFLINE", "UNKNOWN"];

/**
 * Step 7 — would a viewer's browser be allowed to fetch any of this?
 *
 * Only deterministic refusals count here, because a blocked link is hidden from
 * users at once instead of being given the daily-failure grace period: the
 * origin answered but withheld the CORS grant, or answered only because we sent
 * something a browser is forbidden to send. A timeout or a dropped connection
 * says nothing about the browser, so those keep the ordinary rules.
 */
async function applyBrowserGate(
  result: HlsCheckResult,
  url: string,
  options: typeof DEFAULTS & { headers?: Record<string, string> },
  gateApplies: boolean
): Promise<HlsCheckResult> {
  if (!gateApplies) return result;
  if (result.status !== "ONLINE" && result.status !== "DEGRADED") return result;

  if (result.browserCors === false) {
    return asUnplayable(result, "CORS_BLOCKED", url);
  }

  // The probe may have leaned on an identity a browser cannot copy: the admin's
  // stored headers, or the player User-Agent this checker forges for `.ts`
  // feeds. Re-ask with only what a browser is allowed to send.
  const forgedIdentity = Object.keys(options.headers || {}).length > 0 || isMpegTsUrl(url);
  if (!forgedIdentity) return result;

  const bare = await timedFetch(
    url,
    { method: "GET", headers: buildHeaders() },
    Math.min(options.timeoutMs, 6000)
  );
  const response = bare.response;
  if (!response) return result; // silence proves nothing
  if (!response.ok && response.status !== 206) {
    return asUnplayable(result, "HEADERS_REQUIRED", url);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const { text } = await readBodyCapped(response, 4096);
  if (looksLikeHtmlErrorPage(text, contentType)) {
    return asUnplayable(result, "HEADERS_REQUIRED", url);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * MPEG-TS (.ts) probe
 * ------------------------------------------------------------------ */

/** Reads at most `maxBytes` of a response body as RAW bytes (no text decode),
 *  then cancels the connection — used for the binary MPEG-TS sync check. */
async function readBytesCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let collected = 0;
  try {
    while (collected < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        const remaining = maxBytes - collected;
        const piece = value.length > remaining ? value.subarray(0, remaining) : value;
        chunks.push(piece);
        collected += piece.length;
      }
    }
  } catch {
    /* a mid-read reset still leaves us with whatever we already collected */
  } finally {
    reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(collected);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** MPEG-TS packets are 188 bytes and each starts with the sync byte 0x47.
 *  Finding a repeating 188-byte sync cadence is a strong signal the feed is
 *  genuine transport-stream media rather than an HTML error page in disguise. */
function looksLikeMpegTs(bytes: Uint8Array): boolean {
  if (bytes.length < 189) return false;
  const scanLimit = Math.min(bytes.length, 188);
  for (let start = 0; start < scanLimit; start++) {
    if (bytes[start] !== 0x47) continue;
    let consecutive = 0;
    for (let p = start; p + 188 <= bytes.length; p += 188) {
      if (bytes[p] === 0x47) consecutive++;
      else break;
    }
    if (consecutive >= 2) return true;
  }
  return false;
}

/**
 * Health check for a raw MPEG-TS / Xtream `.ts` feed. There is no #EXTM3U
 * playlist to parse, so the HLS pipeline above (and its NOT_HLS_PLAYLIST
 * rejection) doesn't apply — without this a perfectly good `.ts` link would be
 * stored "broken" and its channel hidden by the activeStreamCount filter.
 *
 * Deliberately lenient, mirroring the YouTube short-circuit: a reachable feed
 * that answers 200/206 with real transport-stream bytes (or a video/mp2t
 * content-type) is ONLINE. Actual playback resilience against the provider's
 * ~17-18s drops is handled client-side by MpegTsPlayer, not here.
 */
async function probeTsStream(
  url: string,
  options: typeof DEFAULTS & { headers?: Record<string, string> }
): Promise<HlsCheckResult> {
  const startedAt = Date.now();
  const headers = {
    ...buildHeaders(options.headers),
    "User-Agent": "IPTVSmartersPlayer",
    Accept: "*/*",
    Range: "bytes=0-3759", // ~20 TS packets — enough to confirm the sync cadence
  };

  const res = await timedFetch(
    url,
    { method: "GET", headers },
    Math.max(1, Math.min(options.timeoutMs, options.deliveryDeadlineMs))
  );
  if (!res.response) {
    // A `.ts` feed that hands over no bytes inside the budget is exactly the
    // failure mode this check exists for.
    if (res.errorCode === "TIMEOUT" || res.responseTime >= options.deliveryDeadlineMs) {
      return deliveryMiss(options.deliveryDeadlineMs, res.responseTime);
    }
    return baseResult({
      status: "OFFLINE",
      errorCode: res.errorCode || "UNKNOWN_ERROR",
      responseTime: res.responseTime,
      playlistType: null,
      isLive: true,
      error: res.errorMessage,
    });
  }

  const response = res.response;
  const finalUrl = response.url || url;
  // mpegts.js pulls the feed over XHR, so the browser needs the same CORS
  // grant here as it does for an HLS segment.
  const browserCors = siteOrigin()
    ? Boolean(response.headers.get("access-control-allow-origin"))
    : null;

  if (!response.ok && response.status !== 206) {
    const { status, errorCode } = classifyHttpStatus(response.status, url);
    return baseResult({
      status,
      errorCode,
      httpStatus: response.status,
      responseTime: res.responseTime,
      finalUrl,
      playlistType: null,
      isLive: true,
      error: `HTTP ${response.status}`,
    });
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const bytes = await readBytesCapped(response, 3760);

  // Headers are cheap; the feed itself is the point. Bytes that never arrived
  // inside the budget is a miss, not a healthy link.
  if (bytes.length === 0 && Date.now() - startedAt >= options.deliveryDeadlineMs) {
    return deliveryMiss(options.deliveryDeadlineMs, Date.now() - startedAt);
  }

  // An HTML error/forbidden page disguised behind a 200 is still a failure.
  if (bytes.length > 0 && contentType.includes("text/html")) {
    const asText = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 512));
    if (looksLikeHtmlErrorPage(asText, contentType)) {
      return baseResult({
        status: "INVALID",
        errorCode: "HTML_ERROR_PAGE",
        httpStatus: response.status,
        responseTime: res.responseTime,
        finalUrl,
        playlistType: null,
        isLive: true,
        error: "Server returned an HTML error page instead of a transport stream",
      });
    }
  }

  const isTs =
    looksLikeMpegTs(bytes) ||
    contentType.includes("mp2t") ||
    contentType.includes("mpegts") ||
    contentType.includes("octet-stream");

  if (!isTs) {
    return baseResult({
      status: "INVALID",
      errorCode: "NOT_HLS_PLAYLIST",
      httpStatus: response.status,
      responseTime: res.responseTime,
      finalUrl,
      playlistType: null,
      isLive: true,
      error: "Response is not a recognisable MPEG-TS stream",
    });
  }

  return baseResult({
    status: "ONLINE",
    errorCode: "OK",
    httpStatus: response.status,
    responseTime: res.responseTime,
    finalUrl,
    playlistType: null,
    isLive: true,
    video: true,
    audio: true,
    browserCors,
    error: null,
  });
}

/**
 * Full health check with retry/backoff. A single transient blip (one dropped
 * connection, one slow DNS lookup) never immediately condemns a normally
 * healthy stream — only a status that survives `maxAttempts` retries is
 * returned as final. Content-deterministic failures (INVALID, BLOCKED,
 * EXPIRED — an HTML error page or an expired token isn't going to change
 * between retries) are returned immediately without wasting attempts.
 */
export async function checkHlsStream(rawUrl: string, options: ProbeOptions = {}): Promise<HlsCheckResult> {
  // YouTube Live links aren't raw HLS manifests — they're played through
  // YouTube's own IFrame Player API (see YouTubeLivePlayer.tsx), so none of
  // the m3u8/segment checks below apply to them. Every #EXTM3U/segment check
  // would fail against a YouTube page (it's HTML, not a playlist), which
  // would otherwise get a perfectly fine YouTube link marked "broken" and
  // eventually purged by the health checker. Treat it as healthy here and
  // let YouTubeLivePlayer itself report a real playback failure if the
  // broadcast turns out not to be live.
  if (isYouTubeUrl(rawUrl)) {
    return baseResult({
      status: "ONLINE",
      errorCode: "OK",
      httpStatus: 200,
      // 1, not 0 — several places in the UI treat a falsy latency as
      // "unknown" and render a dash instead of a number.
      responseTime: 1,
      finalUrl: rawUrl,
      playlistType: null,
      isLive: true,
      error: null,
    });
  }

  // The browser never sees the stored URL — it sees the one the app builds from
  // it (`normalizeDirectPublicUrl`, used by the watch page's mirror ladder).
  // Judge that address instead: a link the app silently upgrades to HTTPS would
  // otherwise be tested as plain HTTP, which is the opposite of the failure the
  // viewer runs into.
  const url = browserPlaybackUrl(rawUrl);
  const gateApplies = !isRelayedUrl(url);

  if (gateApplies && url.toLowerCase().startsWith("http://")) {
    // Nothing else to test. An HTTPS page may not load this and this app
    // relays no media, so no viewer can play it however happily the origin
    // answers a server-side request.
    return asUnplayable(
      baseResult({ status: "UNKNOWN", finalUrl: url, playlistType: null, isLive: true }),
      "MIXED_CONTENT",
      url
    );
  }

  const merged = { ...DEFAULTS, ...options, headers: options.headers };
  const maxAttempts = Math.max(1, merged.maxAttempts);

  // Raw MPEG-TS / Xtream `.ts` feeds (and anything already routed through the
  // /api/stream proxy) have no #EXTM3U playlist, so the HLS pipeline below
  // would reject them as NOT_HLS_PLAYLIST. Give them their own lenient probe
  // so a working `.ts` link is stored "active" instead of "broken"/hidden.
  const isTsFeed = isMpegTsUrl(url);
  const probeAttempt = () => (isTsFeed ? probeTsStream(url, merged) : probeOnce(url, merged));

  let lastResult: HlsCheckResult | null = null;
  let deliveryMisses = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await probeAttempt();
    lastResult.attempts = attempt;

    if (lastResult.status === "UNDELIVERABLE") {
      deliveryMisses++;
      // Two misses, ~15s apart, is what hides a link. A caller that asked for a
      // single attempt (the hourly re-check) gets exactly that.
      if (deliveryMisses >= DELIVERY_MISSES_TO_CONFIRM || attempt >= maxAttempts) break;
      console.log(
        `[StreamProbe] ${redactUrl(url)} handed over no media inside ${Math.round(
          merged.deliveryDeadlineMs / 1000
        )}s (miss ${deliveryMisses}/${DELIVERY_MISSES_TO_CONFIRM}), re-testing in ${merged.deliveryConfirmDelayMs}ms`
      );
      await sleep(merged.deliveryConfirmDelayMs);
      continue;
    }

    // Media arrived, so whatever the earlier attempts were is settled.
    deliveryMisses = 0;

    // A `.ts` feed keeps its deliberately lenient single pass: nothing but a
    // delivery miss earns it a second look.
    const shouldRetry =
      !isTsFeed && RETRYABLE_STATUSES.includes(lastResult.status) && attempt < maxAttempts;
    if (!shouldRetry) break;

    // 1-2s after the first failure, 2-3s after the second, etc.
    const backoffMs = 1000 + Math.floor(Math.random() * 1000) + (attempt - 1) * 1000;
    console.log(
      `[StreamProbe] ${redactUrl(url)} -> ${lastResult.status} (attempt ${attempt}/${maxAttempts}), retrying in ${backoffMs}ms`
    );
    await sleep(backoffMs);
  }

  const final = lastResult as HlsCheckResult;
  final.deliveryMisses = final.status === "UNDELIVERABLE" ? deliveryMisses : 0;
  return applyBrowserGate(final, url, merged, gateApplies);
}

/**
 * Backward-compatible entry point used by the existing scheduler/API routes.
 * Same signature as before (`url, timeoutMs`), same `{ ok, latency, reason }`
 * shape — plus every extra diagnostic field for callers that want it.
 */
export async function probeStreamUrl(url: string, timeoutMs: number = 5000): Promise<HlsCheckResult> {
  return checkHlsStream(url, { timeoutMs });
}

// Exported for potential reuse/testing elsewhere in the project.
export { redactUrl, resolveUrl, parseM3U8, pickCheapestVariant };
