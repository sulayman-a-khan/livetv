/**
 * FreeTV — Channel Identity Layer
 * ================================
 * Single source of truth for deciding whether two channel entries are "the same
 * channel". Every part of the system (M3U ingest, merge pass, admin edit,
 * manual link add) resolves identity through `canonicalChannelKey` so the rules
 * can never drift apart between code paths.
 *
 * Rules:
 *   - Casing is ignored               →  "BANGLA TV" === "bangla tv"
 *   - Separators are ignored          →  "Bangla/TV" === "bangla_tv" === "Bangla TV"
 *   - Quality / mirror noise stripped →  "T Sports HD (Server 2)" === "T Sports"
 *   - Digits are PRESERVED            →  "Star Sports 1" !== "Star Sports 2"
 */

/** Separators that carry no meaning: slashes, underscores, dashes, dots, pipes, spaces. */
const SEPARATORS = /[\s/\\_\-.:+|,~]+/g;

/** Bracketed noise: "(480p)", "[BD Server]", "{backup}". */
const BRACKETED = /\(.*?\)|\[.*?\]|\{.*?\}/g;

/**
 * Quality / mirror tokens that describe *the link*, not *the channel*.
 * Each may be followed by a number ("server 2", "backup3", "1080p").
 */
const NOISE_TOKENS =
  /\b(hd|fhd|uhd|shd|sd|4k|8k|2160p?|1080p?|720p?|576p?|480p?|360p?|240p?|h264|h265|hevc|aac|server|srv|mirror|backup|bkp|alt|alternate|link|source|feed|stream|new|old|test|main)\s*\d*\b/g;

/**
 * Builds the canonical identity key for a channel name.
 * Two names producing the same key are treated as the same channel.
 */
export function canonicalChannelKey(name: string): string {
  if (!name) return "";

  const cleaned = name
    .toLowerCase()
    .replace(BRACKETED, " ")
    .replace(SEPARATORS, " ")
    .replace(NOISE_TOKENS, " ")
    .replace(/[^a-z0-9\u0980-\u09FF ]/g, " ") // keep latin, digits and Bangla
    .replace(/\s+/g, "");

  // If noise-stripping ate the whole name (e.g. a channel literally called
  // "HD"), fall back to a plain alphanumeric squash so it still gets a key.
  if (cleaned) return cleaned;

  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u0980-\u09FF]/g, "")
    .trim();
}

/** True when two channel names refer to the same channel. */
export function isSameChannel(a: string, b: string): boolean {
  const ka = canonicalChannelKey(a);
  const kb = canonicalChannelKey(b);
  return Boolean(ka) && ka === kb;
}

/**
 * Normalizes a stream URL for duplicate detection: protocol and trailing
 * slashes are ignored so http:// and https:// variants of one link collapse.
 */
export function canonicalStreamUrl(url: string): string {
  if (!url) return "";
  return url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/* ------------------------------------------------------------------ *
 * Placeholder / test link detection
 * ------------------------------------------------------------------ */

/** Well-known demo and sample streams that ship with tutorials and seeds. */
const PLACEHOLDER_HOSTS = [
  "test-streams.mux.dev",
  "demo.unified-streaming.com",
  "bitdash-a.akamaihd.net",
  "bitmovin",
  "commondatastorage.googleapis.com",
  "storage.googleapis.com/shaka-demo",
  "devstreaming-cdn.apple.com",
  "sample-videos.com",
  "example.com",
  "example.org",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
];

/** Filenames that give away a demo asset even on an unknown host. */
const PLACEHOLDER_PATTERNS = [
  "bigbuckbunny",
  "big_buck_bunny",
  "sintel",
  "tears-of-steel",
  "tearsofsteel",
  "elephantsdream",
  "x36xhzz",
  "sample",
  "dummy",
  "placeholder",
  "testsrc",
  "/test.m3u8",
  "demo.m3u8",
];

/**
 * True when a link is a seeded demo/test stream rather than a real broadcast.
 * These are tolerated while a channel has nothing else, and purged the moment
 * a genuine working server link exists (see `purgeTestLinks`).
 */
export function isPlaceholderStream(url: string): boolean {
  if (!url) return true;
  const u = url.toLowerCase();
  return (
    PLACEHOLDER_HOSTS.some((h) => u.includes(h)) ||
    PLACEHOLDER_PATTERNS.some((p) => u.includes(p))
  );
}
