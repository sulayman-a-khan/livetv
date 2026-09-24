/**
 * Server-side YouTube Live → HLS resolver.
 *
 * Finds the raw HLS master-manifest URL (.m3u8) YouTube generates for a live
 * broadcast, so the stream can be fed into the app's own HlsPlayer instead of
 * YouTube's IFrame embed. Playback from the browser still goes through
 * /api/youtube/proxy/* (googlevideo.com sends no CORS headers), which serves
 * the manifest and segments fetched here.
 *
 * Manifest URLs expire after a few hours, so results are cached briefly and
 * evicted when the proxy reports the URL has gone stale.
 */

const INNERTUBE_ENDPOINT = "https://www.youtube.com/youtubei/v1/player";
const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"; // public web key baked into youtube.com

const CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  manifestUrl: string;
  expiresAt: number;
}

const manifestCache = new Map<string, CacheEntry>();
/** Reverse lookup so the proxy can evict a cache entry from a manifest URL. */
const urlToVideoId = new Map<string, string>();

function cachePut(videoId: string, manifestUrl: string) {
  if (manifestCache.size > 500) {
    const oldest = manifestCache.keys().next().value;
    if (oldest) {
      const entry = manifestCache.get(oldest);
      if (entry) urlToVideoId.delete(entry.manifestUrl);
      manifestCache.delete(oldest);
    }
  }
  manifestCache.set(videoId, { manifestUrl, expiresAt: Date.now() + CACHE_TTL_MS });
  urlToVideoId.set(manifestUrl, videoId);
}

export function getCachedManifest(videoId: string): string | null {
  const entry = manifestCache.get(videoId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    urlToVideoId.delete(entry.manifestUrl);
    manifestCache.delete(videoId);
    return null;
  }
  return entry.manifestUrl;
}

/** Called by the proxy when googlevideo rejects a cached URL (token expired). */
export function evictManifest(manifestUrl: string) {
  const videoId = urlToVideoId.get(manifestUrl);
  if (videoId) {
    manifestCache.delete(videoId);
    urlToVideoId.delete(manifestUrl);
  }
}

/* ------------------------------------------------------------------ */

interface InnertubeClient {
  userAgent: string;
  /** Innertube "X-YouTube-Client-Name" id: 3=ANDROID, 5=IOS, 1=WEB */
  clientNameId: string;
  context: Record<string, unknown>;
}

// Innertube rejects client versions that are too old ("Precondition check
// failed") — keep these roughly current. Verified working 2026-09.
const CLIENTS: InnertubeClient[] = [
  {
    // ANDROID reliably returns hlsManifestUrl for live broadcasts.
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
    clientNameId: "3",
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "20.10.38",
        androidSdkVersion: 34,
        osName: "Android",
        osVersion: "14",
        platform: "MOBILE",
        hl: "en",
        gl: "US",
      },
    },
  },
  {
    userAgent:
      "com.google.ios.youtube/20.10.4 (iPhone14,3; U; CPU iOS 18_3_1 like Mac OS X;)",
    clientNameId: "5",
    context: {
      client: {
        clientName: "IOS",
        clientVersion: "20.10.4",
        deviceModel: "iPhone14,3",
        osName: "iPhone",
        osVersion: "18.3.1.22D82",
        platform: "MOBILE",
        hl: "en",
        gl: "US",
      },
    },
  },
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    clientNameId: "1",
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20250923.01.00",
        hl: "en",
        gl: "US",
      },
    },
  },
  {
    // The embed client is the most lenient toward datacenter IPs (Vercel etc.)
    // and usually skips the "sign in to confirm you're not a bot" gate.
    userAgent:
      "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
    clientNameId: "85",
    context: {
      client: {
        clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
        clientVersion: "2.0",
        hl: "en",
        gl: "US",
        thirdParty: { embedUrl: "https://www.google.com" },
      },
    },
  },
];

/**
 * Extracts the manifest URL from a player response. Verdicts differ per
 * client (WEB may say UNPLAYABLE where ANDROID is OK), so a non-OK status
 * just means "try the next client" — but surface the reason in logs/errors,
 * since on hosted IPs it's usually YouTube's bot gate
 * ("Sign in to confirm you're not a bot").
 */
function manifestFromPlayerResponse(pr: any, clientLabel: string, diag?: string[]): string | null {
  const status = pr?.playabilityStatus?.status;
  const reason = pr?.playabilityStatus?.reason;
  if (status && status !== "OK") {
    const note = `${clientLabel}: ${status}${reason ? ` — ${reason}` : ""}`;
    console.warn(`[ytResolver] ${note}`);
    diag?.push(note);
  }
  return pr?.streamingData?.hlsManifestUrl || null;
}

async function tryInnertube(videoId: string, client: InnertubeClient, diag?: string[]): Promise<string | null> {
  const clientName = (client.context.client as { clientName: string }).clientName;
  const res = await fetch(`${INNERTUBE_ENDPOINT}?key=${INNERTUBE_KEY}&prettyPrint=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": client.userAgent,
      "X-YouTube-Client-Name": client.clientNameId,
      Origin: "https://www.youtube.com",
    },
    body: JSON.stringify({
      context: client.context,
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      // NOTE: no playbackContext here — the ANDROID client rejects it with a
      // 400 "Precondition check failed".
    }),
  });
  if (!res.ok) {
    console.warn(`[ytResolver] ${clientName}: innertube HTTP ${res.status}`);
    diag?.push(`${clientName}: innertube HTTP ${res.status}`);
    return null;
  }
  const pr = await res.json();
  return manifestFromPlayerResponse(pr, clientName, diag);
}

/** Fallback: scrape ytInitialPlayerResponse out of the public watch page. */
async function tryWatchPage(videoId: string, diag?: string[]): Promise<string | null> {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en&bpctr=9999999999&has_verified=1`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: "CONSENT=YES+cb; SOCS=CAI",
    },
  });
  if (!res.ok) {
    diag?.push(`watch-page: HTTP ${res.status}`);
    return null;
  }
  const html = await res.text();
  const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\})\s*;\s*(?:var\s|<\/script>)/);
  if (!match) {
    diag?.push("watch-page: no ytInitialPlayerResponse found (bot wall?)");
    return null;
  }
  try {
    return manifestFromPlayerResponse(JSON.parse(match[1]), "watch-page", diag);
  } catch {
    return null;
  }
}

/** Error carrying per-client diagnostics so the API can surface WHY
 *  extraction failed (usually YouTube's bot gate on datacenter IPs). */
export class YouTubeResolveError extends Error {
  diagnostics: string[];
  constructor(message: string, diagnostics: string[]) {
    super(message);
    this.name = "YouTubeResolveError";
    this.diagnostics = diagnostics;
  }
}

/**
 * Resolves a YouTube video ID to its live HLS master-manifest URL.
 * Pass `forceRefresh` to bypass the cache (e.g. the cached URL just failed —
 * YouTube tokens rotate and hls.js retries would replay the dead one).
 * Throws when the video isn't a playable live broadcast (offline, private,
 * embed-restricted, VOD without HLS, or YouTube refused this server's IP).
 */
export async function resolveYouTubeHls(videoId: string, forceRefresh = false): Promise<string> {
  if (forceRefresh) {
    const cached = manifestCache.get(videoId);
    if (cached) urlToVideoId.delete(cached.manifestUrl);
    manifestCache.delete(videoId);
  }

  const cached = getCachedManifest(videoId);
  if (cached) return cached;

  const diag: string[] = [];

  for (const client of CLIENTS) {
    try {
      const url = await tryInnertube(videoId, client, diag);
      if (url) {
        cachePut(videoId, url);
        return url;
      }
    } catch (err) {
      const clientName = (client.context.client as { clientName: string }).clientName;
      const msg = err instanceof Error ? err.message : String(err);
      diag.push(`${clientName}: ${msg}`);
      console.warn(`[ytResolver] ${clientName} threw: ${msg}`);
    }
  }

  try {
    const url = await tryWatchPage(videoId, diag);
    if (url) {
      cachePut(videoId, url);
      return url;
    }
  } catch (err) {
    diag.push(`watch-page: ${err instanceof Error ? err.message : String(err)}`);
  }

  throw new YouTubeResolveError(
    "No HLS manifest found — this YouTube link may not be a live broadcast right now",
    diag
  );
}
