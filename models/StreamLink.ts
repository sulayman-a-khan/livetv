import mongoose, { Schema, Document, Model } from "mongoose";

export interface IStreamLink extends Document {
  channelId: mongoose.Types.ObjectId;
  url: string;
  priority: number;
  status: "active" | "degraded" | "broken";
  failedAttempts: number;
  /**
   * Start of the current continuous outage. Set by the first probe that finds the
   * link down and cleared by any probe that delivers media, so the maintenance
   * sweep can ask one question of it: has this link been down, without recovery,
   * for `DEAD_LINK_PURGE_HOURS`? (see `lib/streamHealth.ts`).
   */
  firstFailedAt: Date | null;
  lastCheckedAt: Date | null;
  latency: number;
  /**
   * UTC day (`YYYY-MM-DD`) the failure streak last advanced. `failedAttempts`
   * counts consecutive failed check DAYS, so repeated probes inside one day
   * (the scheduled GitHub pass, player reports, admin runs) move this marker at
   * most once. Reset to null when a probe succeeds.
   */
  lastCountedFailureDay: string | null;
  /**
   * Why a viewer's browser cannot fetch this link even though the origin serves
   * it (`mixed content`, no CORS grant, headers a browser may not send). Null
   * when the link is reachable in a browser, or before anything has proved
   * otherwise — automation sets it, an admin clearing it is a deliberate act.
   */
  browserBlocker: string | null;
  /**
   * Delivery misses: probe runs (or pairs of player reports) that gave this link
   * 10 seconds to hand over media and got none. Zero whenever a check delivers.
   */
  deliveryMisses: number;
  lastDeliveryMissAt: Date | null;
  /**
   * Hidden because it would not deliver in time — not because it is dead. Every
   * pass works the oldest verdict first, so these come up again quickly and the
   * link shows itself the moment it serves media inside the budget.
   */
  deliveryHidden: boolean;
  /** Hand-added by an admin: automation may test and rank it, never delete it. */
  manual: boolean;
  /** Admin took this link out of service: hidden, and automation won't restore it. */
  adminDisabled: boolean;
  headers?: Record<string, string>;
  lastCheck?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const StreamLinkSchema = new Schema<IStreamLink>(
  {
    channelId: { type: Schema.Types.ObjectId, ref: "Channel", required: true, index: true },
    url: { type: String, required: true, trim: true },
    priority: { type: Number, default: 1 },
    status: {
      type: String,
      enum: ["active", "degraded", "broken"],
      default: "active",
      index: true,
    },
    failedAttempts: { type: Number, default: 0 },
    firstFailedAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    latency: { type: Number, default: 0 },
    lastCountedFailureDay: { type: String, default: null },
    browserBlocker: { type: String, default: null },
    deliveryMisses: { type: Number, default: 0 },
    lastDeliveryMissAt: { type: Date, default: null },
    deliveryHidden: { type: Boolean, default: false, index: true },
    manual: { type: Boolean, default: false },
    adminDisabled: { type: Boolean, default: false },
    // Some providers require a Referer or Origin; retain it for probes.
    headers: { type: Schema.Types.Mixed, default: undefined },
    // Flexible diagnostics from the last health check.
    lastCheck: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true }
);

// Mirrors are fetched as "this channel's usable links, ranked" — the stored
// `priority` leads and a tie is broken by `_id`, so `latency` stays in this index
// only as the tail it already is; no sort asks for it. Its {channelId} and
// {channelId,status} prefixes cover the unranked lookups too.
StreamLinkSchema.index({ channelId: 1, status: 1, priority: 1, latency: 1 });
// The health checker picks the least-recently-probed links; without this index
// that query is a collection scan plus an in-memory sort.
StreamLinkSchema.index({ lastCheckedAt: 1 });

if (mongoose.models && mongoose.models.StreamLink) {
  delete mongoose.models.StreamLink;
}

const StreamLink: Model<IStreamLink> = mongoose.model<IStreamLink>("StreamLink", StreamLinkSchema);
export default StreamLink;
