/**
 * Stream health rules.
 *
 * `failedAttempts` counts consecutive failed *check days*, not consecutive
 * probes. The catalogue is probed every 6 hours (plus player reports and admin
 * runs), so a probe-level streak would retire a pinned channel inside 18 hours —
 * exactly the false failure these rules exist to prevent. One UTC day advances
 * the streak once, whatever else happened in it, so
 * `MAX_CONSECUTIVE_FAILURES` means "3 consecutive daily health checks".
 */

import type { HlsCheckResult } from "./streamProbe";

export type StoredStreamStatus = "active" | "degraded" | "broken";

/**
 * The state a link is actually in, derived from the stored status plus its
 * streak, latency and admin flags. `StoredStreamStatus` stays the visibility
 * switch the user API gates on; this is the richer view the admin UI and the
 * scheduler log report.
 */
export type LinkHealthState =
  /** Added but never probed successfully — never shown to a viewer. */
  | "unverified"
  | "healthy"
  /** Working, but measurably slower than the channel's other mirrors. */
  | "slow"
  /** Failed today (or sits in the short-streak grace window) — kept visible. */
  | "temporarily-failed"
  /** 3 consecutive failed daily checks — hidden from users, still monitored. */
  | "dead"
  /** Hidden by an admin on purpose; automation never re-enables it. */
  | "disabled";

export interface StreamHealthDecision {
  status: StoredStreamStatus;
  failedAttempts: number;
  firstFailedAt: Date | null;
  lastCheckedAt: Date;
  latency: number;
  /** UTC day (`YYYY-MM-DD`) the streak last advanced — the day gate. */
  lastCountedFailureDay: string | null;
}

/** The number of consecutive failed DAILY checks required before hiding a link. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * How long a link must stay dead — measured in the same daily failures — before
 * it is deleted outright. Until then it is hidden but kept in the catalogue so
 * the checker can bring it back without the URL having to reappear in a source.
 */
export const DEAD_LINK_PURGE_DAYS = 7;

/** A working link slower than this is ranked below quicker mirrors, not hidden. */
export const SLOW_LATENCY_MS = 1200;

/** UTC `YYYY-MM-DD` for a timestamp — the unit the failure streak counts in. */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export interface LinkHealthInput {
  status: StoredStreamStatus;
  failedAttempts: number;
  latency: number;
  lastCheckedAt?: Date | string | null;
  adminDisabled?: boolean;
}

/** Maps stored health to the six admin-facing states. */
export function classifyLinkHealth(link: LinkHealthInput): LinkHealthState {
  if (link.adminDisabled) return "disabled";
  if (link.status === "broken" || link.failedAttempts >= MAX_CONSECUTIVE_FAILURES) return "dead";
  if (link.failedAttempts > 0 || link.status === "degraded") return "temporarily-failed";
  if (!link.lastCheckedAt) return "unverified";
  if (link.latency > SLOW_LATENCY_MS) return "slow";
  return "healthy";
}

/**
 * A probe has its own retries; this persisted streak is a second guard on top.
 * A DEGRADED result verified downloadable media, so it counts as working. A
 * same-day repeat of an already-counted failure leaves the streak alone — that
 * is what keeps 6-hourly checks from maturing a 3-day rule in 18 hours.
 */
export function decideStreamHealth(
  previousStatus: StoredStreamStatus,
  previousFailedAttempts: number,
  previousFirstFailedAt: Date | null | undefined,
  result: HlsCheckResult,
  checkedAt: Date = new Date(),
  previousCountedFailureDay?: string | null
): StreamHealthDecision {
  if (result.ok || result.status === "DEGRADED") {
    return {
      status: "active",
      failedAttempts: 0,
      firstFailedAt: null,
      lastCheckedAt: checkedAt,
      latency: result.latency > 0 ? result.latency : 0,
      lastCountedFailureDay: null,
    };
  }

  const today = utcDayKey(checkedAt);
  const alreadyCountedToday = previousCountedFailureDay === today;
  const failedAttempts = Math.max(0, previousFailedAttempts || 0) + (alreadyCountedToday ? 0 : 1);
  const status: StoredStreamStatus =
    failedAttempts >= MAX_CONSECUTIVE_FAILURES
      ? "broken"
      : previousStatus === "active"
        ? "active"
        : "degraded";

  return {
    status,
    failedAttempts,
    firstFailedAt: previousFirstFailedAt || checkedAt,
    lastCheckedAt: checkedAt,
    latency: 0,
    lastCountedFailureDay: alreadyCountedToday ? (previousCountedFailureDay ?? today) : today,
  };
}

/**
 * Applies the same grace period when a player reports a playback error.
 *
 * A viewer's report is one request from one device, so it may only ever DEMOTE a
 * link to `degraded` — it can advance the daily streak but cannot mark a link
 * dead on its own. Removal needs the server-side checker's confirmation, which
 * is the difference between "this viewer's CDN had a bad minute" and "this link
 * is gone".
 */
export function recordStreamFailure(
  previousStatus: StoredStreamStatus,
  previousFailedAttempts: number,
  previousFirstFailedAt: Date | null | undefined,
  checkedAt: Date = new Date(),
  previousCountedFailureDay?: string | null
): Pick<
  StreamHealthDecision,
  "status" | "failedAttempts" | "firstFailedAt" | "lastCheckedAt" | "lastCountedFailureDay"
> {
  const today = utcDayKey(checkedAt);
  const alreadyCountedToday = previousCountedFailureDay === today;
  const failedAttempts = Math.max(0, previousFailedAttempts || 0) + (alreadyCountedToday ? 0 : 1);

  return {
    status: failedAttempts >= MAX_CONSECUTIVE_FAILURES ? "degraded" : previousStatus === "active" ? "active" : "degraded",
    failedAttempts,
    firstFailedAt: previousFirstFailedAt || checkedAt,
    lastCheckedAt: checkedAt,
    lastCountedFailureDay: alreadyCountedToday ? (previousCountedFailureDay ?? today) : today,
  };
}
