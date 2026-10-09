"use client";

import {
  browserBlockerLabel,
  classifyLinkHealth,
  type LinkHealthState,
} from "@/lib/streamHealth";
import type { BrowserBlocker } from "@/lib/streamProbe";

/** Colour and one-word label per health state — the admin's view of the rules in `lib/streamHealth.ts`. */
const PRESENTATION: Record<LinkHealthState, { label: string; dot: string; text: string }> = {
  healthy: { label: "Healthy", dot: "bg-emerald-400", text: "text-emerald-400" },
  slow: { label: "Slow", dot: "bg-lime-400", text: "text-lime-400" },
  unverified: { label: "Unverified", dot: "bg-slate-400", text: "text-slate-400" },
  "temporarily-failed": { label: "Retrying", dot: "bg-amber-400", text: "text-amber-400" },
  "delivery-failed": { label: "Not delivering", dot: "bg-orange-500", text: "text-orange-400" },
  dead: { label: "Dead", dot: "bg-red-400", text: "text-red-400" },
  "unplayable": { label: "Not playable", dot: "bg-rose-500", text: "text-rose-400" },
  disabled: { label: "Disabled", dot: "bg-slate-600", text: "text-slate-500" },
};

export function linkHealthLabel(state: LinkHealthState): string {
  return PRESENTATION[state].label;
}

/** The probe's own last report, stored on the link by every check that runs. */
export interface LinkProbeDetail {
  healthStatus?: string | null;
  errorCode?: string | null;
  responseTime?: number | null;
  checkedAt?: string | Date | null;
}

export interface LinkHealthInput {
  status: "active" | "degraded" | "broken";
  failedAttempts?: number;
  latency?: number;
  lastCheckedAt?: string | Date | null;
  manual?: boolean;
  adminDisabled?: boolean;
  browserBlocker?: string | null;
  deliveryHidden?: boolean;
  deliveryMisses?: number | null;
  lastCheck?: LinkProbeDetail | null;
}

/** "checked 12m ago" — so a row can show that a run actually reached this link. */
function checkedAgo(at: string | Date | null | undefined): string | null {
  if (!at) return null;
  const ms = Date.now() - new Date(at).getTime();
  if (!Number.isFinite(ms)) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "checked just now";
  if (mins < 60) return `checked ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `checked ${hours}h ago`;
  return `checked ${Math.round(hours / 24)}d ago`;
}

/**
 * The dot + label for one link, plus a tooltip carrying the detail a badge has
 * no room for: the last probe's own verdict and when it ran, the daily failure
 * streak, and whether the admin added the link by hand.
 */
export default function LinkHealthBadge({ link }: { link: LinkHealthInput }) {
  const state = classifyLinkHealth({
    status: link.status,
    failedAttempts: link.failedAttempts || 0,
    latency: link.latency || 0,
    lastCheckedAt: link.lastCheckedAt ?? null,
    adminDisabled: link.adminDisabled,
    browserBlocker: (link.browserBlocker ?? null) as BrowserBlocker | null,
    deliveryHidden: link.deliveryHidden,
    deliveryMisses: link.deliveryMisses,
  });
  const view = PRESENTATION[state];
  const streak = link.failedAttempts || 0;
  const probe = link.lastCheck?.healthStatus
    ? `last probe: ${link.lastCheck.healthStatus}${
        link.lastCheck.errorCode && link.lastCheck.errorCode !== "OK"
          ? `/${link.lastCheck.errorCode}`
          : ""
      }`
    : null;
  const title = [
    view.label,
    browserBlockerLabel(link.browserBlocker as BrowserBlocker | null),
    link.deliveryHidden
      ? "No media inside 10 seconds, twice — hidden; the hourly re-check brings it back when it delivers"
      : "",
    checkedAgo(link.lastCheckedAt ?? link.lastCheck?.checkedAt),
    probe,
    streak > 0 ? `${streak} failed daily check(s)` : "",
    link.manual ? "added by admin — never auto-deleted" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide ${view.text}`}
      title={title}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${view.dot}`} />
      {view.label}
    </span>
  );
}
