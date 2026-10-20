/**
 * Stream URL Resolution & Normalization Helper
 *
 * Ensures:
 * 1. Strike-Safe Dynamic Domain Fallback: Automatically rewrites forwarder (/live/...) streams
 *    to the active Stream Base URL stored in MongoDB (or configured in env).
 * 2. Protocol: Upgrades http:// to https:// on production or for public domains to prevent Mixed Content security blocks.
 * 3. Forwarder Port: Aligns localhost forwarder to Port 5001 (Forwarder) and never Port 5000 (Admin API).
 */

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
