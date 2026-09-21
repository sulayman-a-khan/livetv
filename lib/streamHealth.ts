import type { HlsCheckResult } from "./streamProbe";

export type StoredStreamStatus = "active" | "degraded" | "broken";

export interface StreamHealthDecision {
  status: StoredStreamStatus;
  failedAttempts: number;
  firstFailedAt: Date | null;
  lastCheckedAt: Date;
  latency: number;
}

/** The number of independent failed checks required before hiding a link. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Centralize stream visibility transitions. A probe has its own retries; this
 * persisted streak is an extra guard against short CDN/network blips. A
 * DEGRADED result has verified downloadable media, so keep it available.
 */
export function decideStreamHealth(
  previousStatus: StoredStreamStatus,
  previousFailedAttempts: number,
  previousFirstFailedAt: Date | null | undefined,
  result: HlsCheckResult,
  checkedAt: Date = new Date()
): StreamHealthDecision {
  if (result.ok || result.status === "DEGRADED") {
    return {
      status: "active",
      failedAttempts: 0,
      firstFailedAt: null,
      lastCheckedAt: checkedAt,
      latency: result.latency > 0 ? result.latency : 0,
    };
  }

  const failedAttempts = Math.max(0, previousFailedAttempts || 0) + 1;
  const firstFailedAt = previousFirstFailedAt || checkedAt;
  const status: StoredStreamStatus =
    failedAttempts >= MAX_CONSECUTIVE_FAILURES
      ? "broken"
      : previousStatus === "active"
        ? "active"
        : "degraded";

  return { status, failedAttempts, firstFailedAt, lastCheckedAt: checkedAt, latency: 0 };
}

/** Applies the same grace period when a player reports a playback error. */
export function recordStreamFailure(
  previousStatus: StoredStreamStatus,
  previousFailedAttempts: number,
  previousFirstFailedAt: Date | null | undefined,
  checkedAt: Date = new Date()
): Pick<StreamHealthDecision, "status" | "failedAttempts" | "firstFailedAt" | "lastCheckedAt"> {
  const failedAttempts = Math.max(0, previousFailedAttempts || 0) + 1;
  return {
    status: failedAttempts >= MAX_CONSECUTIVE_FAILURES
      ? "broken"
      : previousStatus === "active" ? "active" : "degraded",
    failedAttempts,
    firstFailedAt: previousFirstFailedAt || checkedAt,
    lastCheckedAt: checkedAt,
  };
}
