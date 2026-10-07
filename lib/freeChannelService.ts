/**
 * Free Public Portal Service (lib/freeChannelService.ts)
 *
 * Dedicated service for public M3U8, GitHub/IPTV-org streams, and YouTube Live feeds.
 *
 * Key Architectural Rules:
 * 1. DIRECT PLAYBACK ONLY. The player loads the origin's own URL. No manifest
 *    and no video segment ever transits this app's serverless functions —
 *    Vercel hands out URLs and config and carries zero media bandwidth.
 * 2. Multi-Server Fallback Ladder: Automatically builds direct candidate mirrors and handles multi-tier failovers.
 * 3. YouTube Integration: Direct YouTube Live feed detection and embed routing.
 */

export interface FreeStreamMirror {
  _id: string;
  url: string;
  priority: number;
  status: "active" | "degraded" | "broken";
  latency: number;
  isYouTube?: boolean;
}

/**
 * Checks if a URL points to a YouTube video/live broadcast.
 */
export function isYouTubeStream(url?: string): boolean {
  if (!url || typeof url !== "string") return false;
  const clean = url.trim().toLowerCase();
  return (
    clean.includes("youtube.com") ||
    clean.includes("youtu.be") ||
    clean.includes("youtube-nocookie.com")
  );
}

/** Loopback / LAN host: reachable only from the viewer's own machine. */
function isPrivateHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
    const octets = host.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return false;
    }
    const [a, b] = octets;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 169;
  } catch {
    return false;
  }
}

/**
 * Normalizes a public stream URL for DIRECT playback — the browser talks to the
 * origin itself, never to us. An https:// page may not request an http://
 * origin (mixed content), so such a feed simply cannot play in a secure browser;
 * it is left alone rather than relayed through our own server.
 */
export function normalizeDirectPublicUrl(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  let url = rawUrl.trim();
  if (!url) return "";

  // If someone passed an /api/stream?url=... wrapper, extract the raw underlying URL
  if (url.includes("/api/stream?url=") || url.includes("/api/stream?ref=")) {
    try {
      const parsed = new URL(url, "http://localhost");
      const targetParam = parsed.searchParams.get("url");
      if (targetParam && /^https?:\/\//i.test(targetParam)) {
        url = targetParam;
      }
    } catch {
      // ignore
    }
  }

  // No relay, ever: this URL is played exactly as the origin is addressed. The
  // one thing still worth trying is TLS on the same host — but only for a
  // public hostname. A bare IP or LAN target has no TLS to upgrade to and must
  // keep the stored URL, which is also what the app's WebView needs.
  if (url.startsWith("http://") && !isYouTubeStream(url) && !isPrivateHost(url)) {
    const host = url.slice(7).split(/[/?#:]/)[0];
    if (host && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && !/^\[.*\]$/.test(host)) {
      url = "https://" + url.slice(7);
    }
  }

  return url;
}

/**
 * Builds a multi-server fallback ladder for free public streams.
 * Guarantees direct URL playback without proxy encapsulation.
 */
export function buildFreeStreamLadder(
  primaryUrl: string,
  backupUrls: string[] = [],
  channelId: string = "channel"
): FreeStreamMirror[] {
  const ladder: FreeStreamMirror[] = [];
  const normalizedPrimary = normalizeDirectPublicUrl(primaryUrl);

  if (normalizedPrimary) {
    ladder.push({
      _id: `free_${channelId}_server_1`,
      url: normalizedPrimary,
      priority: 1,
      status: "active",
      latency: 20,
      isYouTube: isYouTubeStream(normalizedPrimary),
    });
  }

  backupUrls.forEach((backup, idx) => {
    const normalizedBackup = normalizeDirectPublicUrl(backup);
    if (normalizedBackup && normalizedBackup !== normalizedPrimary) {
      ladder.push({
        _id: `free_${channelId}_server_${ladder.length + 1}`,
        url: normalizedBackup,
        priority: ladder.length + 1,
        status: "active",
        latency: 35 + idx * 15,
        isYouTube: isYouTubeStream(normalizedBackup),
      });
    }
  });

  return ladder;
}

/** A mirror doc as returned by /api/channels and /api/channels/[id]. */
export interface RawStreamMirror {
  _id?: unknown;
  url?: string;
  priority?: number;
  status?: string;
  latency?: number;
}

/**
 * Builds the playback ladder from the mirrors the API already ranked.
 *
 * The real StreamLink id MUST survive this step: players report a dead link to
 * /api/streams/report-broken by id, and a synthetic id matches no document —
 * the failure would never reach the backend, so the link would keep being
 * served to every other viewer.
 */
export function buildLadderFromMirrors(
  mirrors: RawStreamMirror[] | null | undefined,
  directUrl?: string,
  channelId = "channel"
): FreeStreamMirror[] {
  const ladder: FreeStreamMirror[] = [];
  const seenUrls = new Set<string>();

  for (const mirror of Array.isArray(mirrors) ? mirrors : []) {
    const url = normalizeDirectPublicUrl(mirror?.url);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    const status = mirror.status;
    ladder.push({
      _id: mirror._id ? String(mirror._id) : `mirror_${channelId}_${ladder.length + 1}`,
      url,
      priority: typeof mirror.priority === "number" ? mirror.priority : ladder.length + 1,
      status: status === "degraded" || status === "broken" ? status : "active",
      latency: typeof mirror.latency === "number" ? mirror.latency : 0,
      isYouTube: isYouTubeStream(url),
    });
  }

  if (ladder.length === 0) {
    const fallback = normalizeDirectPublicUrl(directUrl);
    if (fallback) {
      ladder.push({
        _id: `direct_${channelId}`,
        url: fallback,
        priority: 1,
        status: "active",
        latency: 100,
        isYouTube: isYouTubeStream(fallback),
      });
    }
  }

  return ladder.sort((a, b) => a.priority - b.priority);
}
