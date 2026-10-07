/**
 * Free Public Portal Service (lib/freeChannelService.ts)
 *
 * Dedicated service for public M3U8, GitHub/IPTV-org streams, and YouTube Live feeds.
 *
 * Key Architectural Rules:
 * 1. ZERO Backend Overhead: Completely bypasses /api/stream proxy, encryption, and token generation.
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

/**
 * Normalizes direct public stream URLs without wrapping them into security proxies.
 * Upgrades http:// to https:// when running in secure browser environments.
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

  // Upgrades HTTP to HTTPS on production/browsers to avoid Mixed Content errors
  const isBrowserHttps = typeof window !== "undefined" && window.location.protocol === "https:";
  const isPublicDomain =
    !url.includes("localhost") &&
    !url.includes("127.0.0.1") &&
    !url.includes("192.168.") &&
    !url.includes("10.");

  if (url.startsWith("http://") && (isBrowserHttps || isPublicDomain)) {
    const isRawIP = /^http:\/\/\d+\.\d+\.\d+\.\d+/.test(url);
    if (!isRawIP) {
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
