/**
 * IPTV provider registry + per-channel routing (server-only).
 *
 * IMPORTANT: this module holds provider credentials. It must only ever be
 * imported by server code (the /api/stream route). Never import it from a
 * client component, or the credentials will be bundled into the browser.
 *
 * Two ways to address a stream through /api/stream:
 *   1. Explicit:  ?provider=p1|p2&id=<xtream stream id>
 *   2. By channel: ?channel=<normalizedName>  (uses CHANNEL_STREAMS below)
 *
 * Both build the canonical Xtream live URL
 *   `${baseUrl}/live/${username}/${password}/${streamId}.${ext}`
 * and, per current requirements, use the `.m3u8` (HLS) container for both
 * providers. (Xtream serves the same stream id as both `.ts` and `.m3u8`; the
 * raw-`.ts` path via `?url=` is still handled separately by the route.)
 */

export type ProviderKey = "p1" | "p2";

/** Container a provider serves for `/live/...` streams. */
export type ProviderFormat = "ts" | "m3u8";

export interface ProviderConfig {
  baseUrl: string;
  username: string;
  password: string;
  format: ProviderFormat;
}

export const PROVIDERS: Record<ProviderKey, ProviderConfig> = {
  // Provider 1 (default) — toxicplay.
  p1: {
    baseUrl: "http://toxicplay1.com",
    username: "1Aoen7elp5",
    password: "IgMJ60tmAa",
    format: "m3u8",
  },
  // Provider 2 — BanglaView.
  p2: {
    baseUrl: "http://play.dgix.top:8080",
    username: "sulayman9991",
    password: "01999129991",
    format: "m3u8",
  },
};

/** Provider used when `?provider=` is omitted or unrecognised. */
export const DEFAULT_PROVIDER: ProviderKey = "p1";

/** Normalises a `?provider=` value to a ProviderKey (defaults to p1). */
export function parseProviderKey(value: string | null | undefined): ProviderKey {
  const v = (value || "").trim().toLowerCase();
  if (v === "p2" || v === "provider2") return "p2";
  return DEFAULT_PROVIDER; // p1 / provider1 / anything else
}

export interface ChannelRouting {
  /** Which provider currently serves this channel. */
  active: ProviderKey;
  /** Per-provider Xtream stream ids. Only `active` is used unless switched. */
  providers: Partial<Record<ProviderKey, { streamId: string }>>;
}

/**
 * channel normalizedName -> routing.
 *
 * SCAFFOLD: `tsports` is wired as an example. Replace the placeholder stream ids
 * with the real Xtream ids for each provider, and add more channels the same way:
 *
 *   gtv: { active: "p2", providers: { p1: { streamId: "…" }, p2: { streamId: "…" } } }
 */
export const CHANNEL_STREAMS: Record<string, ChannelRouting> = {
  tsports: {
    active: "p1",
    providers: {
      p1: { streamId: "REPLACE_P1_STREAM_ID" },
      p2: { streamId: "REPLACE_P2_STREAM_ID" },
    },
  },
};

export interface ResolvedChannel {
  providerKey: ProviderKey;
  provider: ProviderConfig;
  streamId: string;
  /** Fully-credentialed upstream URL — never send this to the client. */
  url: string;
  format: ProviderFormat;
}

/** Builds the Xtream live URL for a provider + stream id, in that provider's
 *  container format: `${baseUrl}/live/${user}/${pass}/${streamId}.${ext}`. */
export function buildProviderStreamUrl(provider: ProviderConfig, streamId: string): string {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const ext = provider.format === "m3u8" ? "m3u8" : "ts";
  return `${base}/live/${provider.username}/${provider.password}/${streamId}.${ext}`;
}

/** Resolves a generic channel identifier to the active provider's stream URL.
 *  Returns null when the channel/provider/stream id is unknown or incomplete. */
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

  return {
    providerKey: routing.active,
    provider,
    streamId: entry.streamId,
    url: buildProviderStreamUrl(provider, entry.streamId),
    format: provider.format,
  };
}
