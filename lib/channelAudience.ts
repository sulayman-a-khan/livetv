/**
 * Who is asking for a channel.
 *
 * `web` is a browser on an HTTPS page: it may only be handed HTTPS stream URLs.
 * A browser refuses to fetch HTTP media from a secure page (mixed content), so
 * publishing one would be publishing a source known to fail.
 *
 * `native` is the Android app and Android TV client. It plays both protocols
 * and has no mixed-content rule, so it gets every usable link.
 */
export type ChannelAudience = "web" | "native";

/**
 * Whether a stream may leave the server for this audience.
 *
 * The native app takes every link. A web viewer gets only links a browser can
 * actually fetch: HTTPS (an HTTP URL is blocked as mixed content) and clear of
 * any `browserBlocker` the probe recorded (withheld CORS grant, or headers a
 * browser is forbidden to send). The scheme is matched case-insensitively
 * because M3U sources are not required to lowercase it.
 */
export function isStreamExposedToAudience(
  url: string | null | undefined,
  audience: ChannelAudience,
  browserBlocker?: string | null
): boolean {
  if (!url) return false;
  if (audience === "native") return true;
  return /^https:\/\//i.test(url.trim()) && !browserBlocker;
}