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

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

/** Fine-grained health status — see the project brief for the meaning of each. */
export type HlsHealthStatus =
  | "ONLINE"
  | "DEGRADED"
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
  | "UNKNOWN_ERROR";

export type PlaylistType = "MASTER" | "MEDIA" | null;

export interface HlsCheckResult {
  /**
   * True when the link is playable enough to show on the public UI.
   * ONLINE always; DEGRADED too, except an empty live window
   * (`NO_SEGMENTS_LISTED`) which has nothing to watch.
   */
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
}

/** Kept for backward compatibility with existing imports. */
export type ProbeResult = HlsCheckResult;

export interface ProbeOptions {
  /** Per-request timeout for the playlist/segment fetches. Default 8000ms. */
  timeoutMs?: number;
  /** How many of the most recent segments to sample. Default 1, max 3. */
  segmentSampleSize?: number;
  /** Whether to re-fetch a live playlist after a short delay to confirm it's advancing. Default false. */
  checkLiveRefresh?: boolean;
  /** Delay before the live-refresh re-check, ms. Default 3500. */
  liveRefreshDelayMs?: number;
  /** Whether to attempt an ffprobe decode confirmation when ffmpeg is installed. Default false. */
  useFfprobe?: boolean;
  /** Max attempts for the retry/backoff wrapper. Default 2. */
  maxAttempts?: number;
  /** Extra headers merged over the defaults (User-Agent, Referer, Origin, Authorization, Cookie...). */
  headers?: Record<string, string>;
}

const DEFAULTS = {
  timeoutMs: 8000,
  segmentSampleSize: 1,
  checkLiveRefresh: false,
  liveRefreshDelayMs: 3500,
  useFfprobe: false,
  maxAttempts: 2,
};

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

function buildHeaders(extra?: Record<string, string>, url?: string): Record<string, string> {
  let originHeaders: Record<string, string> = {};
  if (url) {
    try {
      const origin = new URL(url).origin;
      originHeaders = { Referer: `${origin}/`, Origin: origin };
    } catch {
      originHeaders = {};
    }
  }
  return {
    "User-Agent": DEFAULT_USER_AGENT,
    Accept: "*/*",
    ...originHeaders,
    ...extra,
  };
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
  const trimmed = text.trimStart();
  const lower = trimmed.toLowerCase();
  // Real HLS playlists must never be treated as error pages, even when a
  // misconfigured CDN labels them text/html or a comment mentions "forbidden".
  if (lower.startsWith("#extm3u") || lower.startsWith("#ext-x-") || lower.startsWith("#extinf")) {
    return false;
  }
  const structuredHtml =
    lower.startsWith("<!doctype html") ||
    lower.startsWith("<html") ||
    (lower.includes("<html") && lower.includes("</html>")) ||
    (lower.includes("<head") && lower.includes("<body"));
  if (structuredHtml) return true;
  if (contentType.includes("text/html") && (lower.startsWith("<") || lower.length < 32)) {
    return true;
  }
  return false;
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
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trim());
  // #EXTM3U must be the first non-blank line of a real playlist.
  const firstMeaningful = lines.find((l) => l.length > 0);
  const isValidHls = firstMeaningful === "#EXTM3U" || firstMeaningful?.toUpperCase() === "#EXTM3U";

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
}

/** Verifies one media segment is actually downloadable and isn't an HTML error page.
 *  Always uses GET — many IPTV CDNs return HEAD 200 for dead URLs (false online)
 *  or reject HEAD entirely (false offline). Range is preferred; a full GET with
 *  a capped body is the fallback because some CDNs 403 ranged requests. */
async function checkSegment(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<SegmentCheckOutcome> {
  const tryGet = async (extraHeaders: Record<string, string>) => {
    const get = await timedFetch(url, { method: "GET", headers: { ...headers, ...extraHeaders } }, timeoutMs);
    if (!get.response) return { ok: false as const, status: null, bytesRead: 0, retryWithoutRange: false };
    const status = get.response.status;
    if (!get.response.ok && status !== 206) {
      const retryWithoutRange = status === 403 || status === 416 || status === 405 || status === 501;
      return { ok: false as const, status, bytesRead: 0, retryWithoutRange };
    }
    const contentType = (get.response.headers.get("content-type") || "").toLowerCase();
    const { text, bytesRead } = await readBodyCapped(get.response, 4096);
    if (bytesRead === 0) return { ok: false as const, status, bytesRead: 0, retryWithoutRange: false };
    if (looksLikeHtmlErrorPage(text, contentType)) {
      return { ok: false as const, status, bytesRead, retryWithoutRange: false };
    }
    return { ok: true as const, status, bytesRead, retryWithoutRange: false };
  };

  const ranged = await tryGet({ Range: "bytes=0-4096" });
  if (ranged.ok) return { ok: true, status: ranged.status, bytesRead: ranged.bytesRead };
  if (ranged.retryWithoutRange) {
    const full = await tryGet({});
    return { ok: full.ok, status: full.status, bytesRead: full.bytesRead };
  }
  return { ok: false, status: ranged.status, bytesRead: ranged.bytesRead };
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

/** Playable for the public UI: healthy, or degraded-but-still-serving-media. */
export function isPlayableHealthStatus(status: HlsHealthStatus, errorCode: HlsErrorCode): boolean {
  if (status === "ONLINE") return true;
  if (status === "DEGRADED" && errorCode !== "NO_SEGMENTS_LISTED") return true;
  return false;
}

function baseResult(overrides: Partial<HlsCheckResult>): HlsCheckResult {
  const status = overrides.status || "UNKNOWN";
  const errorCode = overrides.errorCode || "UNKNOWN_ERROR";
  const playable = isPlayableHealthStatus(status, errorCode);
  return {
    ok: playable,
    latency: overrides.responseTime ?? 0,
    reason: playable ? undefined : overrides.error || status,
    status,
    errorCode,
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

async function probeOnce(
  url: string,
  options: typeof DEFAULTS & { headers?: Record<string, string> }
): Promise<HlsCheckResult> {
  const headers = buildHeaders(options.headers, url);

  // ---- STEP 1: HTTP request for the playlist itself ----
  const playlistFetch = await timedFetch(url, { method: "GET", headers }, options.timeoutMs);

  if (!playlistFetch.response) {
    return baseResult({
      status: playlistFetch.errorCode === "TIMEOUT" ? "TIMEOUT" : "OFFLINE",
      errorCode: playlistFetch.errorCode || "UNKNOWN_ERROR",
      responseTime: playlistFetch.responseTime,
      error: playlistFetch.errorMessage,
    });
  }

  const response = playlistFetch.response;
  const finalUrl = response.url || url;

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

    for (const variant of orderedVariants.slice(0, 5)) {
      const variantUrl = resolveUrl(variant.uri, finalUrl);
      if (!variantUrl) continue;

      const variantFetch = await timedFetch(variantUrl, { method: "GET", headers }, options.timeoutMs);
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
      break;
    }

    if (!resolvedOk) {
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
      error: "Playlist parsed but currently lists no media segments",
    });
  }

  const sampleSize = Math.max(1, Math.min(3, options.segmentSampleSize));
  const sampledSegments = mediaParsed.segments.slice(-sampleSize);
  const segmentResults: SegmentCheckOutcome[] = [];
  for (const seg of sampledSegments) {
    const segUrl = resolveUrl(seg.uri, mediaPlaylistUrl);
    if (!segUrl) {
      segmentResults.push({ ok: false, status: null, bytesRead: 0 });
      continue;
    }
    segmentResults.push(await checkSegment(segUrl, headers, Math.min(options.timeoutMs, 6000)));
  }

  const okSegments = segmentResults.filter((s) => s.ok).length;
  const latestSegment = mediaParsed.segments[mediaParsed.segments.length - 1]?.uri || null;

  if (okSegments === 0) {
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

  // One reachable segment is enough to call the stream playable. Extra
  // sampled segments that 404 are a quality signal, not a hide-this-channel
  // signal — IPTV CDNs routinely drop the oldest chunk in the window.

  // ---- STEP 5: For live playlists, confirm the segment window is advancing ----
  let newSegmentDetected: boolean | null = null;
  if (mediaParsed.isLive && options.checkLiveRefresh) {
    await sleep(options.liveRefreshDelayMs);
    const refetch = await timedFetch(mediaPlaylistUrl, { method: "GET", headers }, options.timeoutMs);
    if (refetch.response && (refetch.response.ok || refetch.response.status === 206)) {
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

  if (options.useFfprobe && (await isFfprobeAvailable())) {
    const probeTarget =
      resolveUrl(sampledSegments[sampledSegments.length - 1]?.uri || "", mediaPlaylistUrl) || mediaPlaylistUrl;
    const ff = await runFfprobe(probeTarget, headers, Math.min(options.timeoutMs + 2000, 8000));
    video = ff.video;
    audio = ff.audio;
    resolution = ff.resolution;
    codec = ff.codec;
    fps = ff.fps;
    // Never hide a stream because ffprobe is missing, slow, or can't decode
    // an encrypted/fMP4 rendition the browser player handles fine.
  }

  // Playlist + at least one media segment are reachable.
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
    resolution,
    codec,
    fps,
    error: null,
  });
}

/** Retry only flakes — a 404/expired token/HTML page will not change on retry. */
const RETRYABLE_ERROR_CODES: HlsErrorCode[] = [
  "TIMEOUT",
  "DNS_FAILURE",
  "CONNECTION_REFUSED",
  "TLS_FAILURE",
  "SERVER_ERROR",
  "UNKNOWN_ERROR",
];

/**
 * Full health check with retry/backoff. A single transient blip (one dropped
 * connection, one slow DNS lookup) never immediately condemns a normally
 * healthy stream — only a status that survives `maxAttempts` retries is
 * returned as final. Content-deterministic failures (INVALID, BLOCKED,
 * EXPIRED — an HTML error page or an expired token isn't going to change
 * between retries) are returned immediately without wasting attempts.
 */
export async function checkHlsStream(url: string, options: ProbeOptions = {}): Promise<HlsCheckResult> {
  const merged = { ...DEFAULTS, ...options, headers: options.headers };
  const maxAttempts = Math.max(1, merged.maxAttempts);

  let lastResult: HlsCheckResult | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await probeOnce(url, merged);
    lastResult.attempts = attempt;

    const shouldRetry =
      attempt < maxAttempts &&
      (lastResult.status === "TIMEOUT" ||
        lastResult.status === "UNKNOWN" ||
        RETRYABLE_ERROR_CODES.includes(lastResult.errorCode));
    if (!shouldRetry) break;

    // 1-2s after the first failure, 2-3s after the second, etc.
    const backoffMs = 1000 + Math.floor(Math.random() * 1000) + (attempt - 1) * 1000;
    console.log(
      `[StreamProbe] ${redactUrl(url)} -> ${lastResult.status} (attempt ${attempt}/${maxAttempts}), retrying in ${backoffMs}ms`
    );
    await sleep(backoffMs);
  }

  return lastResult as HlsCheckResult;
}

/**
 * Backward-compatible entry point used by the existing scheduler/API routes.
 * Same signature as before (`url, timeoutMs`), same `{ ok, latency, reason }`
 * shape — plus every extra diagnostic field for callers that want it.
 */
export async function probeStreamUrl(url: string, timeoutMs: number = 8000): Promise<HlsCheckResult> {
  return checkHlsStream(url, {
    timeoutMs,
    checkLiveRefresh: false,
    useFfprobe: false,
    maxAttempts: 2,
    segmentSampleSize: 1,
  });
}

// Exported for potential reuse/testing elsewhere in the project.
export { redactUrl, resolveUrl, parseM3U8, pickCheapestVariant };
