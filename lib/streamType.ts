/**
 * Stream-type helpers.
 *
 * The app plays three kinds of source, each through its own player:
 *   - YouTube Live  -> YouTubeLivePlayer (YouTube's IFrame Player API)
 *   - HLS (.m3u8)   -> HlsPlayer (hls.js dual-slot ping-pong)
 *   - MPEG-TS (.ts) -> MpegTsPlayer (mpegts.js via the /api/stream proxy)
 *
 * Nothing here fetches media — it only classifies a stored URL so the watch
 * page / admin test player can pick the right component, and builds the
 * proxy URL that lets a raw .ts feed be played from the browser.
 */

/** The server-side passthrough proxy that adds the IPTV headers + CORS a raw
 *  .ts feed needs. See app/api/stream/route.ts. */
export const STREAM_PROXY_PATH = "/api/stream";

/** True if the URL is (or points at) a raw MPEG-TS / Xtream .ts feed.
 *  Matches a direct `.ts` path and anything already routed through the
 *  `/api/stream` proxy. Never matches an HLS `.m3u8` playlist or YouTube. */
export function isMpegTsUrl(url: string): boolean {
  if (!url) return false;
  try {
    // Relative URLs (e.g. an already-built "/api/stream?url=...") are allowed.
    const u = new URL(url, "http://_local.invalid");
    const path = u.pathname.toLowerCase();

    if (path.endsWith(".ts")) return true;

    if (path.endsWith(STREAM_PROXY_PATH) || path.includes(`${STREAM_PROXY_PATH}?`)) {
      return true;
    }

    // A proxy URL whose inner target is a .ts feed.
    const inner = u.searchParams.get("url");
    if (inner) {
      try {
        const innerPath = new URL(inner).pathname.toLowerCase();
        if (innerPath.endsWith(".ts")) return true;
      } catch {
        /* ignore malformed inner url */
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Returns the URL the <video>/mpegts.js element should actually load for a
 * raw .ts feed: routed through our proxy so the browser gets CORS headers and
 * the upstream provider gets the `User-Agent: IPTVSmartersPlayer` it expects.
 *
 * Absolute proxy URLs (http://.../api/stream?...) and already-proxied links
 * are passed through untouched.
 */
export function buildStreamProxyUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl, "http://_local.invalid");
    const path = u.pathname.toLowerCase();
    // Already going through the proxy — leave it alone.
    if (path.endsWith(STREAM_PROXY_PATH)) return rawUrl;
  } catch {
    /* fall through and wrap whatever we were given */
  }
  return `${STREAM_PROXY_PATH}?url=${encodeURIComponent(rawUrl)}`;
}
