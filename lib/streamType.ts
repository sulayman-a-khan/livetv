/**
 * Stream-type helpers.
 *
 * The app plays three kinds of source, each through its own player:
 *   - YouTube Live  -> YouTubeLivePlayer (YouTube's IFrame Player API)
 *   - HLS (.m3u8)   -> HlsPlayer (hls.js dual-slot ping-pong)
 *   - MPEG-TS (.ts) -> MpegTsPlayer (mpegts.js)
 *
 * Nothing here fetches media — it only classifies a stored URL so the watch
 * page / admin test player can pick the right component, and recovers the
 * origin URL from a link that an older build stored behind our own proxy.
 */

/** Path of the /api/stream media relay. The direct catalogue never routes
 *  through it — those feeds play from the origin's own URL. Only the
 *  secured/forwarded Live Sports Arena path uses it. It lives here so a link
 *  stored in that wrapped form is still recognised, by the classifier below and
 *  by toDirectStreamUrl, which reads it back to the origin it wrapped. */
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
      // A proxy URL wrapping an m3u8 is still HLS — check the inner target.
      const inner = u.searchParams.get("url");
      if (inner) {
        try {
          const innerPath = new URL(inner).pathname.toLowerCase();
          if (innerPath.endsWith(".m3u8")) return false; // HLS, not MPEG-TS
        } catch {
          /* ignore malformed inner url */
        }
      }
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
 * Returns the origin URL to load directly.
 *
 * Links stored while the relay existed (`/api/stream?url=<origin>`, relative or
 * absolute) are read back to the origin they wrapped; anything else is already
 * a direct URL and comes back untouched. An opaque `?ref=` child link cannot be
 * reversed in the browser and is left alone.
 */
export function toDirectStreamUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl, "http://_local.invalid");
    if (!u.pathname.endsWith(STREAM_PROXY_PATH)) return rawUrl;
    const inner = u.searchParams.get("url");
    return inner && /^https?:\/\//i.test(inner) ? inner : rawUrl;
  } catch {
    return rawUrl;
  }
}
