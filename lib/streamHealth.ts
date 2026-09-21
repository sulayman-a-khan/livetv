/**
 * Maps a probe result onto the stored stream status used by the public UI.
 *
 * The catalogue only lists `status === "active"` links, so this mapping is
 * what actually shows or hides a channel. Two rules matter more than a
 * perfect one-shot probe:
 *
 *   1. A playable playlist (ONLINE, or DEGRADED-but-still-serving-media)
 *      becomes active immediately — recover fast, never keep a working
 *      stream hidden.
 *   2. Transient probe failures (timeout, DNS, 5xx) must NOT hide a link
 *      that was already active. IPTV CDNs flake; one slow check is not
 *      evidence the stream is dead. Hard failures (404, expired token,
 *      HTML error page, not HLS) degrade/break faster.
 */

import {
  isPlayableHealthStatus,
  type HlsCheckResult,
  type HlsErrorCode,
  type HlsHealthStatus,
} from "@/lib/streamProbe";

export type StoredStreamStatus = "active" | "degraded" | "broken";

const TRANSIENT_ERROR_CODES: ReadonlySet<HlsErrorCode> = new Set([
  "TIMEOUT",
  "DNS_FAILURE",
  "CONNECTION_REFUSED",
  "TLS_FAILURE",
  "SERVER_ERROR",
  "RATE_LIMITED",
  "UNKNOWN_ERROR",
]);

const TRANSIENT_STATUSES: ReadonlySet<HlsHealthStatus> = new Set(["TIMEOUT", "UNKNOWN"]);

/** Failures that still leave a previously-working stream on the UI. */
export function isTransientProbeFailure(result: HlsCheckResult): boolean {
  return TRANSIENT_STATUSES.has(result.status) || TRANSIENT_ERROR_CODES.has(result.errorCode);
}

/** True when a viewer would almost certainly be able to play this link. */
export function isPlayableProbe(result: HlsCheckResult): boolean {
  return result.ok || isPlayableHealthStatus(result.status, result.errorCode);
}

export interface StreamHealthFields {
  status: StoredStreamStatus;
  latency: number;
  failedAttempts: number;
  firstFailedAt: Date | null;
  lastCheckedAt: Date;
}

export interface HealthDecision extends StreamHealthFields {
  recovered: boolean;
}

const TRANSIENT_KEEP_ACTIVE = 2; // 1st–2nd flake: stay visible
const TRANSIENT_TO_BROKEN = 5; // 5 consecutive flakes → hide
const HARD_TO_BROKEN = 2; // 2 hard failures → hide

export function decideStreamHealth(
  previous: StoredStreamStatus,
  previousFails: number,
  previousFirstFailedAt: Date | null,
  result: HlsCheckResult,
  now: Date = new Date()
): HealthDecision {
  if (isPlayableProbe(result)) {
    return {
      status: "active",
      latency: result.latency || result.responseTime || 0,
      failedAttempts: 0,
      firstFailedAt: null,
      lastCheckedAt: now,
      recovered: previous !== "active",
    };
  }

  const failedAttempts = (previousFails || 0) + 1;
  const firstFailedAt = previousFirstFailedAt || now;
  const transient = isTransientProbeFailure(result);

  let status: StoredStreamStatus;

  if (transient && previous === "active" && failedAttempts <= TRANSIENT_KEEP_ACTIVE) {
    // Last confirmed working — keep showing it while the CDN hiccups.
    status = "active";
  } else if (transient) {
    status = failedAttempts >= TRANSIENT_TO_BROKEN ? "broken" : "degraded";
  } else {
    status = failedAttempts >= HARD_TO_BROKEN ? "broken" : "degraded";
  }

  return {
    status,
    latency: result.latency || result.responseTime || 0,
    failedAttempts,
    firstFailedAt,
    lastCheckedAt: now,
    recovered: false,
  };
}
