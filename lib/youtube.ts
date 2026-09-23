/**
 * YouTube URL helpers.
 *
 * These only ever produce a `videoId` for use with YouTube's own IFrame
 * Player API (https://developers.google.com/youtube/iframe_api_reference).
 * Nothing here extracts, resolves, or proxies a raw .m3u8 manifest — that
 * would bypass YouTube's player (and its ads/branding), which violates
 * YouTube's Terms of Service and isn't something this app does.
 */

/** True if the given stream URL points at YouTube (youtube.com or youtu.be). */
export function isYouTubeUrl(url: string): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    const host = hostname.replace(/^www\./, "").toLowerCase();
    return (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtu.be" ||
      host === "music.youtube.com"
    );
  } catch {
    return false;
  }
}

/**
 * Extracts a concrete video ID directly from a URL, when the URL already
 * names one — e.g.:
 *   https://www.youtube.com/watch?v=VIDEOID
 *   https://youtu.be/VIDEOID
 *   https://www.youtube.com/live/VIDEOID
 *   https://www.youtube.com/embed/VIDEOID
 *
 * Returns null for a "channel live" style URL (e.g. youtube.com/@handle/live
 * or youtube.com/channel/UCxxxx/live) that doesn't include one — those need
 * to be resolved server-side against YouTube's Data API instead, since the
 * "currently live" video for a channel changes over time.
 */
export function extractYouTubeVideoId(url: string): string | null {
  if (!isYouTubeUrl(url)) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtu.be") {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return id || null;
    }

    const vParam = parsed.searchParams.get("v");
    if (vParam) return vParam;

    const segments = parsed.pathname.split("/").filter(Boolean);
    const liveIdx = segments.indexOf("live");
    if (liveIdx !== -1 && segments[liveIdx + 1]) return segments[liveIdx + 1];

    const embedIdx = segments.indexOf("embed");
    if (embedIdx !== -1 && segments[embedIdx + 1]) return segments[embedIdx + 1];

    const shortsIdx = segments.indexOf("shorts");
    if (shortsIdx !== -1 && segments[shortsIdx + 1]) return segments[shortsIdx + 1];

    return null;
  } catch {
    return null;
  }
}

/**
 * True for a channel-style "live" URL that names a channel/handle rather
 * than a specific video — these have no fixed video ID and must be resolved
 * against YouTube's Data API server-side to find whatever is live right now.
 */
export function isYouTubeChannelLiveUrl(url: string): boolean {
  if (!isYouTubeUrl(url)) return false;
  if (extractYouTubeVideoId(url)) return false;
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.includes("live") || segments.includes("streams");
  } catch {
    return false;
  }
}
