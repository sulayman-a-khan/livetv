import type { HlsErrorCode, HlsHealthStatus } from "@/lib/streamProbe";

/**
 * Whether a probe result is evidence about a viewer's browser at all.
 *
 * A link that was rate-limited (HTTP 429) learned nothing about CORS: the edge
 * refused the probe before the origin's playlist headers were ever seen, and a
 * 429 almost never carries an `Access-Control-Allow-Origin`. Filing that as
 * "the browser is blocked" would hide a working link from the website until a
 * later probe happened to get through. It stays a health verdict only.
 *
 * Kept apart from the probe itself so the rule can be tested without a network
 * or the probe's transport.
 */
export function browserGateApplies(
  status: HlsHealthStatus,
  errorCode: HlsErrorCode
): boolean {
  if (status !== "ONLINE" && status !== "DEGRADED") return false;
  return errorCode !== "RATE_LIMITED";
}