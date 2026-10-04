/**
 * Stream URL Resolution & Normalization Helper
 *
 * Ensures:
 * 1. Strike-Safe Dynamic Domain Fallback: Automatically rewrites forwarder (/live/...) streams
 *    to the active Stream Base URL stored in MongoDB (or configured in env).
 * 2. Protocol: Upgrades http:// to https:// on production or for public domains to prevent Mixed Content security blocks.
 * 3. Forwarder Port: Aligns localhost forwarder to Port 5001 (Forwarder) and never Port 5000 (Admin API).
 * 4. Dynamic Fallback: Builds candidate mirrors with direct URL + dynamic /api/stream proxy fallback.
 */

export interface ResolvedStreamMirror {
  _id: string;
  url: string;
  priority: number;
  status: "active" | "degraded" | "broken";
  latency: number;
}

/**
 * Rewrites a forwarder stream URL (/live/...) to the active base URL.
 * Handles localhost, stale trycloudflare domains, or custom streaming proxy domains.
 */
export function rewriteToActiveBaseUrl(url: string, activeBaseUrl: string): string {
  if (!url || typeof url !== "string" || !activeBaseUrl) return url;
  const cleanBase = activeBaseUrl.trim().replace(/\/+$/, "");
  if (!cleanBase) return url;

  // Match /live/<streamId> (with optional sub-path and extension)
  const liveMatch = url.match(/\/live\/([A-Za-z0-9_-]+(?:\.m3u8|\/[^?#]+)?)/);
  if (liveMatch) {
    const searchMatch = url.match(/(\?[^#]*)/);
    const search = searchMatch ? searchMatch[1] : "";
    return `${cleanBase}${liveMatch[0]}${search}`;
  }
  return url;
}

/**
 * Normalizes a stream URL:
 * - Dynamically rewrites /live/... forwarder URLs to the active public Base URL (from MongoDB settings or env).
 * - Upgrades http:// to https:// on production / HTTPS environments.
 * - Ensures port 5001 is used rather than port 5000 for local test links.
 */
export function resolveStreamUrl(rawUrl?: string, customBaseUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  let url = rawUrl.trim();
  if (!url) return "";

  // Preferred public base URL from DB or env
  const publicBase = (
    customBaseUrl ||
    process.env.NEXT_PUBLIC_STREAM_BASE_URL ||
    process.env.PUBLIC_STREAM_BASE_URL ||
    ""
  )
    .trim()
    .replace(/\/+$/, "");

  const isLocalHost =
    url.includes("localhost:5000") ||
    url.includes("localhost:5001") ||
    url.includes("127.0.0.1:5000") ||
    url.includes("127.0.0.1:5001");

  const hasForwarderPath = url.includes("/live/");
  const isTryCloudflare = url.includes(".trycloudflare.com");

  // 1. If this is a forwarder stream (/live/...) and we have an active publicBase,
  // rewrite it so that old/struck/banned domains or local URLs immediately use the active tunnel/domain
  if (publicBase && (isLocalHost || hasForwarderPath || isTryCloudflare)) {
    url = rewriteToActiveBaseUrl(url, publicBase);
  } else if (isLocalHost) {
    // If no publicBase is configured, guarantee port 5001 (Forwarder) rather than 5000 (Admin API)
    url = url.replace(/(?:localhost|127\.0\.0\.1):5000/, "localhost:5001");
  }

  // 2. HTTPS enforcement to prevent Mixed Content security blocks
  const isBrowserHttps = typeof window !== "undefined" && window.location.protocol === "https:";
  const isVercel = Boolean(process.env.VERCEL || process.env.NEXT_PUBLIC_VERCEL_ENV);
  const isPublicDomain =
    url.includes(".trycloudflare.com") ||
    url.includes(".vercel.app") ||
    (!url.includes("localhost") && !url.includes("127.0.0.1") && !url.includes("192.168.") && !url.includes("10."));

  if (url.startsWith("http://")) {
    const isRawIP = /^http:\/\/\d+\.\d+\.\d+\.\d+/.test(url);
    if (!isRawIP && (isBrowserHttps || isVercel || isPublicDomain)) {
      url = "https://" + url.slice(7);
    }
  }

  return url;
}

/**
 * Determines whether a stream requires security proxying (/api/stream, tokenization, AES proxy).
 *
 * Requirements:
 * - Sports Arena streams (live sports events, matches, sports categories) MUST remain 100% secured & proxied.
 * - Local PC Server / Forwarder streams (/live/..., trycloudflare, localhost/port 5001, Xtream CDN) MUST remain secured & proxied.
 * - Public Free Categories (News, Entertainment, General, Bangladeshi TV, Indian TV, Pakistani TV, Global TV, GitHub/IPTV-org)
 *   bypass the proxy and use direct URL playback for 0 backend overhead.
 * - CRITICAL: Never base this logic solely on file extension (.m3u8). Sports Arena streams also use .m3u8.
 */
export function isSecuredOrSportsStream(
  url?: string,
  categoryOrSource?: string,
  isSportsEvent?: boolean
): boolean {
  if (isSportsEvent) return true;

  const cat = (categoryOrSource || "").toLowerCase();
  if (
    cat.includes("sport") ||
    cat.includes("arena") ||
    cat === "live sports" ||
    cat === "sports-tv" ||
    cat === "cricket" ||
    cat === "football"
  ) {
    return true;
  }

  if (!url || typeof url !== "string") return false;
  const cleanUrl = url.toLowerCase();

  // Local PC Server / Forwarder / Cloudflare tunnel sources
  const isLocalOrTunnel =
    cleanUrl.includes("localhost") ||
    cleanUrl.includes("127.0.0.1") ||
    cleanUrl.includes(".trycloudflare.com") ||
    cleanUrl.includes("/live/") ||
    cleanUrl.includes("/api/stream");

  // Xtream CDN / Provider sources
  const isXtreamOrProvider =
    cleanUrl.includes("player_api.php") ||
    cleanUrl.includes("get.php") ||
    cleanUrl.includes("/play/") ||
    cleanUrl.endsWith(".ts") ||
    cleanUrl.includes(".ts?") ||
    cleanUrl.includes("/ts/");

  return isLocalOrTunnel || isXtreamOrProvider;
}

/**
 * Builds candidate stream mirrors for the HLS player.
 * - For Public Free Categories: returns DIRECT URLs for instant playback without backend overhead.
 * - For Sports Arena / Local PC Server / Xtream CDN: includes direct stream plus dynamic /api/stream proxy fallback.
 */
export function buildStreamCandidates(
  primaryUrl: string,
  backupUrls: string[] = [],
  id: string = "event",
  customBaseUrl?: string,
  categoryOrSource?: string,
  isSportsEvent?: boolean
): ResolvedStreamMirror[] {
  const resolvedPrimary = resolveStreamUrl(primaryUrl, customBaseUrl);
  const candidates: ResolvedStreamMirror[] = [];

  if (resolvedPrimary) {
    // Primary direct connection (lowest latency)
    candidates.push({
      _id: `stream_${id}_direct`,
      url: resolvedPrimary,
      priority: 1,
      status: "active",
      latency: 25,
    });

    const requiresSecurity = isSecuredOrSportsStream(resolvedPrimary, categoryOrSource, isSportsEvent);

    // Dynamic URL fallback through /api/stream proxy ONLY for Sports Arena / Local PC / Xtream CDN
    if (requiresSecurity && !resolvedPrimary.startsWith("/") && !resolvedPrimary.includes("/api/stream")) {
      candidates.push({
        _id: `stream_${id}_proxy`,
        url: `/api/stream?url=${encodeURIComponent(resolvedPrimary)}`,
        priority: 2,
        status: "active",
        latency: 60,
      });
    }
  }

  // Any additional backup stream URLs
  backupUrls.forEach((bUrl, idx) => {
    const resolvedBackup = resolveStreamUrl(bUrl, customBaseUrl);
    if (resolvedBackup && resolvedBackup !== resolvedPrimary) {
      candidates.push({
        _id: `stream_${id}_backup_${idx + 1}`,
        url: resolvedBackup,
        priority: candidates.length + 1,
        status: "active",
        latency: 40,
      });
    }
  });

  return candidates;
}
