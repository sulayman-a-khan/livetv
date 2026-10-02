/**
 * IPTV provider registry + per-channel routing (server-only).
 *
 * IMPORTANT: this module holds provider credentials. It must only ever be
 * imported by server code (the /api/stream route). Never import it from a
 * client component, or the credentials will be bundled into the browser.
 *
 * A "channel" is identified by its normalizedName (e.g. "tsports"). Each channel
 * maps to one or more providers, each with its own Xtream stream id, plus which
 * provider is currently `active`. The proxy resolves `?channel=<id>` to a
 * concrete, credentialed stream URL for the active provider only (no automatic
 * cross-provider fallback).
 *
 * Providers differ in the container they serve for live streams:
 *   - provider1 (toxicplay1) -> raw MPEG-TS (`.ts`), piped as video/mp2t
 *   - provider2 (BanglaView)  -> HLS (`.m3u8`), proxied + playlist-rewritten
 */

export type ProviderKey = "provider1" | "provider2";

/** Container a provider serves for `/live/...` streams. */
export type ProviderFormat = "ts" | "m3u8";

export interface ProviderConfig {
  baseUrl: string;
  username: string;
  password: string;
  format: ProviderFormat;
}

export const PROVIDERS: Record<ProviderKey, ProviderConfig> = {
  provider1: {
    baseUrl: "http://toxicplay1.com",
    username: "1Aoen7elp5",
    password: "IgMJ60tmAa",
    format: "ts",
  },
  provider2: {
    baseUrl: "http://play.dgix.top:8080",
    username: "sulayman9991",
    password: "01999129991",
    format: "m3u8",
  },
};

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
 *   gtv: { active: "provider2", providers: { provider1: {...}, provider2: {...} } }
 */
export const CHANNEL_STREAMS: Record<string, ChannelRouting> = {
  tsports: {
    active: "provider1",
    providers: {
      provider1: { streamId: "REPLACE_PROVIDER1_STREAM_ID" },
      provider2: { streamId: "REPLACE_PROVIDER2_STREAM_ID" },
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
