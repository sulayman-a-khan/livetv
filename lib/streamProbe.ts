/**
 * FreeTV Stream Probe Utility
 * Performs deep inspection of stream links (HLS manifests, video/audio payloads)
 * to verify if a stream is genuinely playable vs returning HTML error pages or 200 OK stubs.
 */

export interface ProbeResult {
  ok: boolean;
  latency: number;
  reason?: string;
}

export async function probeStreamUrl(
  url: string,
  timeoutMs: number = 5000
): Promise<ProbeResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        Range: "bytes=0-4096",
      },
    });

    clearTimeout(timeoutId);
    const latency = Date.now() - start;

    if (!response.ok && response.status !== 206) {
      return { ok: false, latency, reason: `HTTP status ${response.status}` };
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();

    // Read initial body snippet to detect HTML error/landing pages
    const textSnippet = (await response.text()).slice(0, 2048).toLowerCase();

    // 1. Explicit HTML document rejection (error pages returned as 200 OK)
    if (
      contentType.includes("text/html") ||
      textSnippet.includes("<!doctype html") ||
      textSnippet.includes("<html") ||
      textSnippet.includes("<head") ||
      textSnippet.includes("access denied") ||
      textSnippet.includes("404 not found") ||
      textSnippet.includes("cloudflare") ||
      textSnippet.includes("error 404") ||
      textSnippet.includes("stream offline") ||
      textSnippet.includes("forbidden")
    ) {
      return { ok: false, latency, reason: "Returned HTML error page instead of media stream" };
    }

    // 2. Positive check for HLS manifest tags or media headers
    const hasHlsTag =
      textSnippet.includes("#extm3u") ||
      textSnippet.includes("#ext-x-") ||
      textSnippet.includes("#extinf") ||
      textSnippet.includes("#ext-x-stream-inf");

    const isMediaContentType =
      contentType.includes("mpegurl") ||
      contentType.includes("video/") ||
      contentType.includes("audio/") ||
      contentType.includes("octet-stream") ||
      contentType.includes("application/x-mpegurl") ||
      contentType.includes("application/vnd.apple.mpegurl");

    const hasStreamExtension = url.includes(".m3u8") || url.includes(".ts") || url.includes(".mpd");

    if (hasHlsTag || isMediaContentType || (hasStreamExtension && !textSnippet.includes("<"))) {
      return { ok: true, latency };
    }

    return { ok: false, latency, reason: "Unrecognized stream format or missing HLS manifest headers" };
  } catch (err: any) {
    clearTimeout(timeoutId);
    return { ok: false, latency: 0, reason: err?.message || "Connection timeout or network failure" };
  }
}
