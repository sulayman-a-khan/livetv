/**
 * Stream health rules.
 *
 * `failedAttempts` counts consecutive failed *check days*, not consecutive
 * probes. The catalogue is probed by each scheduled pass (every four hours, plus
 * admin runs), so a probe-level streak would retire a pinned channel inside 12
 * hours — exactly the false failure these rules exist to prevent. One UTC day
 * advances the streak once, whatever else happened in it, so
 * `MAX_CONSECUTIVE_FAILURES` means "3 consecutive daily health checks".
 *
 * On top of that sits the delivery rule, because a link that gives a viewer
 * nothing is as good as gone: every probe attempt that hands over no real media
 * counts as a miss — a 10-second timeout and a connection refused in 400ms are
 * the same answer to "can anyone watch this?" — and two misses hide the link
 * immediately instead of waiting three days. A scheduled pass does not let the
 * first look decide: a link it is about to hide for delivery is probed a second
 * time in the same run, and only a link that fails both looks is hidden. Hidden
 * is not gone — the next pass that gets media shows it again, and every pass
 * works the oldest verdict first, so a hidden link is re-tested inside one
 * scheduled cycle.
 *
 * What a viewer sees is narrower than what is stored. `degraded` means "this
 * link failed a check and is being retried", so the public catalogue lists
 * `active` links only: a tile a viewer can click is a tile that played for the
 * checker last time it looked. A link climbs back into the UI on the first pass
 * that delivers media, with no admin action.
 *
 * Hiding is the last step a bad minute can cause; deletion is held to a longer
 * rule. `DEAD_LINK_PURGE_HOURS` says how long an outage must run, continuously,
 * before the sweep removes the link outright — measured from `firstFailedAt`,
 * which any probe that delivers media resets to null. So recovery anywhere in
 * those three days takes the counter back to zero and the clock starts again,
 * while a link that stayed down the whole time and is still being probed is
 * finally dropped. That is also why the streak alone cannot delete anything:
 * three unlucky daily checks are a hiding, not an eviction.
 */

import type { BrowserBlocker, HlsCheckResult } from "./streamProbe";

export type StoredStreamStatus = "active" | "degraded" | "broken";

/**
 * The state a link is actually in, derived from the stored status plus its
 * streak, latency and admin flags. `StoredStreamStatus` stays the visibility
 * switch the user API gates on; this is the richer view the admin UI and the
 * pass report show.
 */
export type LinkHealthState =
  /** Added but never probed successfully — never shown to a viewer. */
  | "unverified"
  | "healthy"
  /** Working, but measurably slower than the channel's other mirrors. */
  | "slow"
  /** Failed a check and being retried — listed in admin, not to viewers. */
  | "temporarily-failed"
  /** 3 consecutive failed daily checks — hidden from users, still monitored. */
  | "dead"
  /** The origin serves it, but a viewer's browser is never allowed to fetch it. */
  | "unplayable"
  /** Alive but too slow to put media in a player's hands; hidden until a pass delivers. */
  | "delivery-failed"
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
  /** Why the browser cannot fetch this link; null whenever it can. */
  browserBlocker: BrowserBlocker | null;
  /** Delivery misses seen in the probe run behind this decision. */
  deliveryMisses: number;
  /** Hidden for delivery: kept out of the UI until a probe actually delivers. */
  deliveryHidden: boolean;
  /** When a delivery miss last happened — starts the player-report window. */
  lastDeliveryMissAt: Date | null;
}

/**
 * The probe's own words, stored with the link so the admin row can say what it
 * saw — the verdict fields (`status`, `deliveryMisses`) answer "is it listed",
 * this answers "what happened when we tested it, and when". Shared by every
 * caller that probes, so a scheduled batch, a manual batch and a single-link
 * test all leave the same evidence behind.
 */
export function toLastCheckDetail(result: HlsCheckResult) {
  return {
    healthStatus: result.status,
    errorCode: result.errorCode,
    httpStatus: result.httpStatus,
    responseTime: result.responseTime,
    playlistType: result.playlistType,
    isLive: result.isLive,
    segmentCount: result.segmentCount,
    newSegmentDetected: result.newSegmentDetected,
    video: result.video,
    audio: result.audio,
    resolution: result.resolution,
    codec: result.codec,
    fps: result.fps,
    attempts: result.attempts,
    error: result.error,
    checkedAt: result.checkedAt,
    browserCors: result.browserCors,
    browserBlocker: result.browserBlocker,
    deliveryMisses: result.deliveryMisses,
  };
}

/** The number of consecutive failed DAILY checks required before hiding a link. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * How long a link must stay down, without ever recovering, before the maintenance
 * sweep deletes it. Measured from `firstFailedAt` — the instant the current
 * outage began — so the window is wall-clock, not a count of checks: three daily
 * failures could still be three unlucky hours, and a link that has answered for
 * four straight days is a different claim.
 *
 * A single successful probe zeroes `firstFailedAt` (see `decideStreamHealth`), so
 * the countdown always restarts from the most recent continuous outage. Until the
 * window elapses a dead link is only hidden and keeps being probed, so it can
 * come back on its own.
 */
export const DEAD_LINK_PURGE_HOURS = 72;

/** Convenience form of the purge window for callers that compare in milliseconds. */
export const DEAD_LINK_PURGE_MS = DEAD_LINK_PURGE_HOURS * 60 * 60 * 1000;

/** A working link slower than this is ranked below quicker mirrors, not hidden. */
export const SLOW_LATENCY_MS = 1200;

/**
 * Misses that hide a link for delivery. Two independent windows have to come back
 * with no media, so one bad connection never blanks a channel. A scheduled pass
 * asks a failing link for a second look before it lets a delivery hide land (see
 * `app/api/admin/health-check`); a single-link admin test already has two probe
 * attempts of its own.
 */
export const DELIVERY_MISSES_TO_HIDE = 2;

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
  browserBlocker?: BrowserBlocker | null;
  deliveryHidden?: boolean;
  deliveryMisses?: number | null;
}

/** One line for the admin: what the browser could not do, in plain terms. */
const BLOCKER_LABEL: Record<BrowserBlocker, string> = {
  MIXED_CONTENT: "HTTP origin — an HTTPS page may not load it",
  CORS_BLOCKED: "no CORS grant — the player cannot read it",
  HEADERS_REQUIRED: "needs headers a browser cannot send",
};

export function browserBlockerLabel(blocker: BrowserBlocker | null | undefined): string | null {
  if (!blocker) return null;
  return BLOCKER_LABEL[blocker] || null;
}

/** Maps stored health to the eight admin-facing states. */
export function classifyLinkHealth(link: LinkHealthInput): LinkHealthState {
  if (link.adminDisabled) return "disabled";
  if (link.browserBlocker) return "unplayable";
  // Ahead of `dead` on purpose: a link hidden for delivery is stored `broken`
  // too, and "it would not deliver" is the more useful half of that story — it
  // says the next pass is already working on bringing it back.
  if (link.deliveryHidden || (link.deliveryMisses ?? 0) > 0) return "delivery-failed";
  if (link.status === "broken" || link.failedAttempts >= MAX_CONSECUTIVE_FAILURES) return "dead";
  if (link.failedAttempts > 0 || link.status === "degraded") return "temporarily-failed";
  if (!link.lastCheckedAt) return "unverified";
  if (link.latency > SLOW_LATENCY_MS) return "slow";
  return "healthy";
}

/**
 * The links a viewer may be handed. The catalogue has always required
 * `status === "active"`; this adds the one thing that status can still be
 * carrying a pass late — the "Not delivering" label, which a link wears as soon
 * as it holds an unpaid delivery miss, before the second miss flips the stored
 * status to `broken`. A channel that has another usable mirror keeps showing it
 * either way; a channel whose only candidate is that link stops propping itself
 * up on it. No other state is judged here: healthy, slow, retrying, dead,
 * browser-blocked and disabled links pass or fail exactly as the status gate
 * alone decided.
 *
 * Takes the stored fields that decide delivery and nothing else — the streak and
 * latency the verdict ignores are held at zero inside the classification call.
 */
export function isUsableViewerLink(link: {
  status?: string;
  adminDisabled?: boolean;
  deliveryHidden?: boolean;
  deliveryMisses?: number | null;
}): boolean {
  // Asked only of links the status gate already accepted, so a browser-blocked
  // one is never seen here — it is stored `broken`. The streak and latency the
  // delivery verdict ignores are held at zero inside the classification.
  if (link.status !== "active") return false;
  return (
    classifyLinkHealth({
      status: "active",
      failedAttempts: 0,
      latency: 0,
      adminDisabled: link.adminDisabled,
      browserBlocker: null,
      deliveryHidden: link.deliveryHidden,
      deliveryMisses: link.deliveryMisses,
    }) !== "delivery-failed"
  );
}

/**
 * A probe has its own retries; this persisted streak is a second guard on top.
 * A DEGRADED result verified downloadable media, so it counts as working. A
 * same-day repeat of an already-counted failure leaves the streak alone — that
 * is what keeps same-day passes from maturing a 3-day rule in an afternoon.
 *
 * `previousDelivery` carries the delivery evidence forward: a link hidden for
 * not delivering stays hidden until something actually delivers, even if the
 * next probe fails for a different reason, and a pass that gets no media adds
 * its misses to the ones it never cleared rather than resetting them.
 */
export function decideStreamHealth(
  previousStatus: StoredStreamStatus,
  previousFailedAttempts: number,
  previousFirstFailedAt: Date | null | undefined,
  result: HlsCheckResult,
  checkedAt: Date = new Date(),
  previousCountedFailureDay?: string | null,
  previousDelivery?: {
    deliveryHidden?: boolean;
    deliveryMisses?: number | null;
    lastDeliveryMissAt?: Date | string | null;
  }
): StreamHealthDecision {
  if (result.ok || result.status === "DEGRADED") {
    return {
      status: "active",
      failedAttempts: 0,
      firstFailedAt: null,
      lastCheckedAt: checkedAt,
      latency: result.latency > 0 ? result.latency : 0,
      lastCountedFailureDay: null,
      browserBlocker: null,
      deliveryMisses: 0,
      deliveryHidden: false,
      lastDeliveryMissAt: null,
    };
  }

  if (result.browserBlocker) {
    // Structural, not a bad minute at the CDN: hiding it behind three daily
    // checks would keep serving a link no viewer can ever play. The streak is
    // parked at the hiding threshold rather than inflated, so the 72-hour purge
    // still has to earn its own evidence before deleting anything.
    return {
      status: "broken",
      failedAttempts: Math.max((previousFailedAttempts || 0) + 1, MAX_CONSECUTIVE_FAILURES),
      firstFailedAt: previousFirstFailedAt || checkedAt,
      lastCheckedAt: checkedAt,
      latency: 0,
      lastCountedFailureDay: utcDayKey(checkedAt),
      browserBlocker: result.browserBlocker,
      deliveryMisses: 0,
      deliveryHidden: false,
      lastDeliveryMissAt: null,
    };
  }

  const today = utcDayKey(checkedAt);
  const alreadyCountedToday = previousCountedFailureDay === today;
  const failedAttempts = Math.max(0, previousFailedAttempts || 0) + (alreadyCountedToday ? 0 : 1);

  // The probe confirms a delivery miss with a second attempt ~15s later, so two
  // of them is a link that cannot put media in a player's hands — hide it now
  // rather than waiting three more days for the streak to mature. Misses from
  // earlier passes count too: an origin that already gave no media at the last
  // pass is not evidence of health.
  const runMisses = Math.max(0, result.deliveryMisses || 0);
  const deliveryMisses = Math.max(0, previousDelivery?.deliveryMisses || 0) + runMisses;
  const missedDelivery = deliveryMisses >= DELIVERY_MISSES_TO_HIDE;
  const deliveryHidden = missedDelivery || previousDelivery?.deliveryHidden === true;
  const status: StoredStreamStatus =
    deliveryHidden || failedAttempts >= MAX_CONSECUTIVE_FAILURES
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
    browserBlocker: null,
    deliveryMisses,
    deliveryHidden,
    lastDeliveryMissAt:
      runMisses > 0
        ? checkedAt
        : previousDelivery?.lastDeliveryMissAt
        ? new Date(previousDelivery.lastDeliveryMissAt)
        : null,
  };
}

