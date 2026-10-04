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

export interface FreeChannel {
  _id: string;
  name: string;
  logo: string;
  category: string;
  subCategory?: string;
  country: string;
  streams: FreeStreamMirror[];
  isPinned?: boolean;
  priorityOrder?: number;
  activeStreamCount?: number;
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

/**
 * Client-side fetch helper for free channel catalog.
 */
export async function fetchFreeChannels(): Promise<FreeChannel[]> {
  try {
    const res = await fetch(`/api/channels?_t=${Date.now()}`, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const rawList = Array.isArray(data)
      ? data
      : Array.isArray(data?.channels)
      ? data.channels
      : Array.isArray(data?.data)
      ? data.data
      : [];

    return rawList.map((ch: any) => {
      const primary = ch.streamUrl || (ch.streams && ch.streams[0]?.url) || "";
      const backups = Array.isArray(ch.backupStreamUrls)
        ? ch.backupStreamUrls
        : Array.isArray(ch.streams)
        ? ch.streams.slice(1).map((s: any) => s.url)
        : [];

      return {
        _id: ch._id || ch.id || "",
        name: ch.name || "Unknown Channel",
        logo: ch.logo || "",
        category: ch.category || "General Broadcast",
        subCategory: ch.subCategory || "",
        country: ch.country || "Global",
        streams: buildFreeStreamLadder(primary, backups, ch._id || "ch"),
        isPinned: Boolean(ch.isPinned),
        priorityOrder: ch.priorityOrder ?? 99,
        activeStreamCount: ch.activeStreamCount ?? (primary ? 1 : 0),
      };
    });
  } catch (err) {
    console.error("[FreeChannelService] fetchFreeChannels failed:", err);
    return [];
  }
}

/**
 * Client-side fetch helper for single free channel details.
 */
export async function fetchFreeChannelById(channelId: string): Promise<FreeChannel | null> {
  if (!channelId) return null;
  try {
    const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}?_t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success || !data.channel) return null;

    const ch = data.channel;
    const primary = ch.streamUrl || (ch.streams && ch.streams[0]?.url) || "";
    const backups = Array.isArray(ch.backupStreamUrls)
      ? ch.backupStreamUrls
      : Array.isArray(ch.streams)
      ? ch.streams.slice(1).map((s: any) => s.url)
      : [];

    return {
      _id: ch._id || channelId,
      name: ch.name || "Channel",
      logo: ch.logo || "",
      category: ch.category || "General Broadcast",
      subCategory: ch.subCategory || "",
      country: ch.country || "Global",
      streams: buildFreeStreamLadder(primary, backups, channelId),
      isPinned: Boolean(ch.isPinned),
      priorityOrder: ch.priorityOrder ?? 99,
      activeStreamCount: ch.activeStreamCount ?? 1,
    };
  } catch (err) {
    console.error(`[FreeChannelService] fetchFreeChannelById(${channelId}) error:`, err);
    return null;
  }
}
