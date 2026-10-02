/**
 * IPTV provider registry + per-channel routing (server-only).
 *
 * IMPORTANT: this module holds provider credentials. It must only ever be
 * imported by server code (the /api/stream route). Never import it from a
 * client component, or the credentials will be bundled into the browser.
 *
 * Two ways to address a stream through /api/stream:
 *   1. Explicit:  ?provider=p1|p2&id=<stream id>
 *   2. By channel: ?channel=<normalizedName>  (uses CHANNEL_STREAMS below)
 *
 * The two live providers do NOT share a URL scheme (verified against each
 * panel's own player_api.php / get.php on 2026-10-02):
 *
 *   p1 — toxicplay (STAR-NETWORK), a classic Xtream Codes panel.
 *        allowed_output_formats = ["ts"] ONLY; `.m3u8` returns HTTP 405.
 *        Streams live at `${base}/live/${user}/${pass}/${streamId}.ts` and the
 *        `id` is the numeric Xtream stream_id from get_live_streams.
 *
 *   p2 — BanglaView, an XUI-One 1.5.5 panel. It does NOT serve the classic
 *        `/live/user/pass/id.*` path at all (every id 404s). Its real playback
 *        URLs are tokenized — `https://<mediaHost>/play/<token>/ts` — and are
 *        only discoverable from the panel's `get.php` export playlist, where
 *        each entry carries `xui-id="<streamId>"`. So for p2 the `id` is the
 *        xui-id (e.g. 3 = LIVE CRICKET 1) and we resolve it to the tokenized
 *        URL at request time (see resolveXuiTokenUrl).
 *
 * Both resolve to a transport stream (.ts), piped straight through by the
 * proxy as video/mp2t and played by MpegTsPlayer. The `.m3u8` rewrite path in
 * the route is still there for plain HLS links stored via `?url=`.
 */

export type ProviderKey = "p1" | "p2";

/** Container a provider's resolved stream ends up being. Both are `ts` today. */
export type ProviderFormat = "ts" | "m3u8";

/** How a provider turns a stream id into a playable URL. */
export type ProviderScheme =
  /** Classic Xtream: `${base}/live/${user}/${pass}/${id}.${ext}`. */
  | "xtream"
  /** XUI-One: resolve `xui-id=${id}` to a tokenized `/play/<token>/ts` URL via get.php. */
  | "xui-token";

export interface ProviderConfig {
  baseUrl: string;
  username: string;
  password: string;
  format: ProviderFormat;
  scheme: ProviderScheme;
}

export const PROVIDERS: Record<ProviderKey, ProviderConfig> = {
  // Provider 1 (default) — toxicplay / STAR-NETWORK. TS only.
  p1: {
    baseUrl: "http://toxicplay1.com",
    username: "1Aoen7elp5",
    password: "IgMJ60tmAa",
    format: "ts",
    scheme: "xtream",
  },
  // Provider 2 — BanglaView (XUI-One). Tokenized /play/<token>/ts via get.php.
  p2: {
    baseUrl: "http://play.dgix.top:8080",
    username: "sulayman9991",
    password: "01999129991",
    format: "ts",
    scheme: "xui-token",
  },
};

/** Provider used when `?provider=` is omitted or unrecognised. */
export const DEFAULT_PROVIDER: ProviderKey = "p1";

/** Normalises a `?provider=` value to a ProviderKey (defaults to p1). */
export function parseProviderKey(value: string | null | undefined): ProviderKey {
  const v = (value || "").trim().toLowerCase();
  if (v === "p2" || v === "provider2" || v === "banglaview") return "p2";
  return DEFAULT_PROVIDER; // p1 / provider1 / anything else
}

export interface ChannelRouting {
  /** Which provider currently serves this channel. */
  active: ProviderKey;
  /** Per-provider stream ids (p1 = Xtream stream_id, p2 = xui-id). */
  providers: Partial<Record<ProviderKey, { streamId: string }>>;
}

/**
 * channel normalizedName -> routing.
 *
 * SCAFFOLD: replace the placeholder ids with real ones and add channels the
 * same way. Remember p1 ids are Xtream stream_ids and p2 ids are xui-ids:
 *
 *   tsports:  { active: "p1", providers: { p1: { streamId: "661238" } } }
 *   cricket1: { active: "p2", providers: { p2: { streamId: "3" } } }
 */
export const CHANNEL_STREAMS: Record<string, ChannelRouting> = {
  tsports: {
    active: "p1",
    providers: {
      p1: { streamId: "REPLACE_P1_STREAM_ID" },
      p2: { streamId: "REPLACE_P2_XUI_ID" },
    },
  },
};

/** Builds the classic Xtream live URL for a provider + stream id. */
export function buildProviderStreamUrl(provider: ProviderConfig, streamId: string): string {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const ext = provider.format === "m3u8" ? "m3u8" : "ts";
  return `${base}/live/${provider.username}/${provider.password}/${streamId}.${ext}`;
}

/* ------------------------------------------------------------------ *
 * XUI-One (p2) tokenized URL resolution via get.php
 * ------------------------------------------------------------------ */

const UPSTREAM_HEADERS: Record<string, string> = {
  "User-Agent": "IPTVSmartersPlayer",
  Accept: "*/*",
};

/** How long to reuse a fetched get.php playlist before refetching. The panel
 *  only allows one concurrent media connection, but playlist exports are cheap
 *  and the tokens inside are stable for a while — 5 minutes is a safe cache. */
const PLAYLIST_CACHE_TTL_MS = 5 * 60 * 1000;

interface PlaylistCacheEntry {
  text: string;
  expires: number;
}

const playlistCache = new Map<ProviderKey, PlaylistCacheEntry>();

function getPhpUrl(provider: ProviderConfig): string {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const user = encodeURIComponent(provider.username);
  const pass = encodeURIComponent(provider.password);
  return `${base}/get.php?username=${user}&password=${pass}&type=m3u_plus`;
}

async function fetchPlaylist(providerKey: ProviderKey, provider: ProviderConfig): Promise<string | null> {
  const cached = playlistCache.get(providerKey);
  if (cached && cached.expires > Date.now()) return cached.text;

  try {
    const res = await fetch(getPhpUrl(provider), {
      headers: UPSTREAM_HEADERS,
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || !text.includes("#EXTM3U")) return null;
    playlistCache.set(providerKey, { text, expires: Date.now() + PLAYLIST_CACHE_TTL_MS });
    return text;
  } catch {
    return null;
  }
}

/**
 * Finds the tokenized playback URL for an XUI-One `xui-id` inside a get.php
 * export playlist. Entries look like:
 *
 *   #EXTINF:-1 xui-id="3" tvg-name="LIVE CRICKET 1" ...,LIVE CRICKET 1
 *   https://play.dgix.top:443/play/<token>/ts
 *
 * so we locate the `#EXTINF` line whose `xui-id` matches exactly, then take the
 * next non-blank, non-comment line as the URL.
 */
export function findXuiTokenUrl(playlist: string, xuiId: string): string | null {
  const lines = playlist.split(/\r?\n/);
  const idAttr = `xui-id="${xuiId}"`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("#EXTINF")) continue;
    if (!line.includes(idAttr)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate) continue;
      if (candidate.startsWith("#")) break; // malformed entry — stop
      return candidate;
    }
  }
  return null;
}

async function resolveXuiTokenUrl(providerKey: ProviderKey, provider: ProviderConfig, streamId: string): Promise<string | null> {
  const playlist = await fetchPlaylist(providerKey, provider);
  if (!playlist) return null;
  return findXuiTokenUrl(playlist, streamId);
}

/* ------------------------------------------------------------------ *
 * Public resolution
 * ------------------------------------------------------------------ */

export interface ResolvedStream {
  /** Fully-credentialed (or tokenized) upstream URL — never send to the client. */
  url: string;
  format: ProviderFormat;
}

/**
 * Resolves a provider + stream id to the actual upstream URL to fetch.
 *   - `xtream`    -> built synchronously (`.ts` for both today).
 *   - `xui-token` -> resolved via the cached get.php playlist.
 * Returns null when the id can't be resolved (unknown xui-id, panel down, or an
 * unedited scaffold placeholder).
 */
export async function resolveProviderStreamUrl(
  providerKey: ProviderKey,
  provider: ProviderConfig,
  streamId: string
): Promise<ResolvedStream | null> {
  const id = (streamId || "").trim();
  if (!id || /^REPLACE_/i.test(id)) return null;

  if (provider.scheme === "xui-token") {
    const url = await resolveXuiTokenUrl(providerKey, provider, id);
    // The tokenized URL is a transport stream regardless of its `/ts` suffix.
    return url ? { url, format: "ts" } : null;
  }

  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return { url: buildProviderStreamUrl(provider, id), format: provider.format };
}

export interface ResolvedChannel {
  providerKey: ProviderKey;
  provider: ProviderConfig;
  streamId: string;
}

/** Maps a generic channel identifier to its active provider + stream id.
 *  Returns null when the channel/active provider/stream id is unknown or is an
 *  unedited scaffold placeholder. The caller resolves the URL via
 *  resolveProviderStreamUrl (which may need to hit the panel for p2). */
export function resolveChannel(channel: string): ResolvedChannel | null {
  const key = (channel || "").trim().toLowerCase();
  if (!key) return null;
  const routing = CHANNEL_STREAMS[key];
  if (!routing) return null;

  const provider = PROVIDERS[routing.active];
  const entry = routing.providers[routing.active];
  if (!provider || !entry || !entry.streamId) return null;
  // Guard against an unedited scaffold placeholder reaching the network.
  if (/^REPLACE_/i.test(entry.streamId)) return null;

  return { providerKey: routing.active, provider, streamId: entry.streamId };
}
