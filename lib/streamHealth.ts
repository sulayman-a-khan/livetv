/**
 * Stream health rules.
 *
 * `failedAttempts` counts consecutive failed *check days*, not consecutive
 * probes. The catalogue is probed every 6 hours (plus player reports and admin
 * runs), so a probe-level streak would retire a pinned channel inside 18 hours —
 * exactly the false failure these rules exist to prevent. One UTC day advances
 * the streak once, whatever else happened in it, so
 * `MAX_CONSECUTIVE_FAILURES` means "3 consecutive daily health checks".
 *
 * On top of that sits the delivery rule, because a link that answers slowly is
 * as good as gone for anyone who pressed play: a probe gets 10 seconds to hand
 * over real media, and a miss confirmed by a second attempt ~15 seconds later
 * hides the link immediately instead of waiting three days. Hidden is not gone —
 * the hourly re-check (`runDeliveryRecheck`) shows it again as soon as it
 * delivers.
 */

import type { BrowserBlocker, HlsCheckResult } from "./streamProbe";

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
  /** The origin serves it, but a viewer's browser is never allowed to fetch it. */
  | "unplayable"
  /** Alive but too slow to put media in a player's hands; hidden pending re-check. */
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

/**
 * Misses that hide a link for delivery. The probe confirms a miss with a second
 * attempt ~15 seconds later, and a player's report counts the same way, so two
 * is "this link cannot serve a viewer right now" — never one bad connection.
 */
export const DELIVERY_MISSES_TO_HIDE = 2;

/** Player reports this close together count as the same failing stream. */
export const DELIVERY_MISS_WINDOW_MS = 2 * 60 * 1000;

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
  // says the hourly re-check is already working on bringing it back.
  if (link.deliveryHidden || (link.deliveryMisses ?? 0) > 0) return "delivery-failed";
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
 *
 * `previousDeliveryHidden` carries the delivery verdict forward: a link hidden
 * for not delivering stays hidden until something actually delivers, even if the
 * next probe fails for a different reason.
 */
export function decideStreamHealth(
  previousStatus: StoredStreamStatus,
  previousFailedAttempts: number,
  previousFirstFailedAt: Date | null | undefined,
  result: HlsCheckResult,
  checkedAt: Date = new Date(),
  previousCountedFailureDay?: string | null,
  previousDeliveryHidden?: boolean
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
    // parked at the hiding threshold rather than inflated, so the 7-day purge
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
  // rather than waiting three more days for the streak to mature.
  const deliveryMisses = Math.max(0, result.deliveryMisses || 0);
  const missedDelivery = deliveryMisses >= DELIVERY_MISSES_TO_HIDE;
  const deliveryHidden = missedDelivery || previousDeliveryHidden === true;
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
    lastDeliveryMissAt: deliveryMisses > 0 ? checkedAt : null,
  };
}

/** What a player report did to a link's delivery tally. */
export interface DeliveryMissRecord {
  deliveryMisses: number;
  lastDeliveryMissAt: Date;
  deliveryHidden: boolean;
}

/**
 * Counts a viewer-side miss: the watch page gave up on this server link before
 * it showed a frame. Reports from one viewing session only count while they keep
 * arriving inside `DELIVERY_MISS_WINDOW_MS`; once that lapses the count restarts,
 * so a channel-switching viewer cannot condemn a link on its own.
 */
export function recordDeliveryMiss(
  previousDeliveryMisses: number | undefined | null,
  previousLastDeliveryMissAt: Date | string | null | undefined,
  at: Date = new Date()
): DeliveryMissRecord {
  const lastAt = previousLastDeliveryMissAt ? new Date(previousLastDeliveryMissAt).getTime() : 0;
  const inWindow = Number.isFinite(lastAt) && lastAt > 0 && at.getTime() - lastAt <= DELIVERY_MISS_WINDOW_MS;
  const deliveryMisses = (inWindow ? Math.max(0, previousDeliveryMisses || 0) : 0) + 1;
  return {
    deliveryMisses,
    lastDeliveryMissAt: at,
    deliveryHidden: deliveryMisses >= DELIVERY_MISSES_TO_HIDE,
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
  previousCountedFailureDay?: string | null,
  previousDelivery?: {
    deliveryMisses?: number | null;
    lastDeliveryMissAt?: Date | string | null;
    deliveryHidden?: boolean;
  }
): Pick<
  StreamHealthDecision,
  | "status"
  | "failedAttempts"
  | "firstFailedAt"
  | "lastCheckedAt"
  | "lastCountedFailureDay"
  | "deliveryMisses"
  | "lastDeliveryMissAt"
  | "deliveryHidden"
> {
  const today = utcDayKey(checkedAt);
  const alreadyCountedToday = previousCountedFailureDay === today;
  const failedAttempts = Math.max(0, previousFailedAttempts || 0) + (alreadyCountedToday ? 0 : 1);
  const miss = recordDeliveryMiss(previousDelivery?.deliveryMisses, previousDelivery?.lastDeliveryMissAt, checkedAt);
  const deliveryHidden = miss.deliveryHidden || previousDelivery?.deliveryHidden === true;

  let status: StoredStreamStatus;
  if (deliveryHidden) status = "broken";
  // A viewer's report can never be the reason a hidden link comes back.
  else if (previousStatus === "broken") status = "broken";
  else if (previousStatus === "active" && failedAttempts < MAX_CONSECUTIVE_FAILURES) status = "active";
  else status = "degraded";

  return {
    // The streak can never retire a link on a viewer's word alone, but a player
    // that went dark twice inside two minutes is the delivery evidence the
    // hourly re-check is built to answer, so that alone hides it.
    status,
    failedAttempts,
    firstFailedAt: previousFirstFailedAt || checkedAt,
    lastCheckedAt: checkedAt,
    lastCountedFailureDay: alreadyCountedToday ? (previousCountedFailureDay ?? today) : today,
    deliveryMisses: miss.deliveryMisses,
    lastDeliveryMissAt: miss.lastDeliveryMissAt,
    deliveryHidden,
  };
}
