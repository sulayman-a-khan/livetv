import mongoose, { Schema, Document, Model } from "mongoose";

export const SPORTS_EVENT_STATUSES = ["scheduled", "live", "ended"] as const;
export type SportsEventStatus = (typeof SPORTS_EVENT_STATUSES)[number];

/** Maximum number of fallback HLS URLs per event card. */
export const MAX_BACKUP_URLS = 10;

/** True for absolute http(s) URLs only (blocks javascript:, file:, data: …). */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export interface ISportsEvent extends Document {
  matchTitle: string;
  sportType: string;
  startTime: Date;
  endTime: Date;
  status: SportsEventStatus;
  /** Local origin / encoder HLS URL (usually the forwarder URL of the PC server). */
  primaryStreamUrl: string;
  /** Fallback HLS URLs, tried in order when the primary fails. */
  backupStreamUrls: string[];
  /** Whether the local PC origin node is currently online. */
  isLocalServerActive: boolean;
  /** Display rank — lower numbers are shown first. */
  priorityOrder: number;

  /* ---- sync bookkeeping (written by the local PC server) ---- */
  /** `<sourceNode>:<localEventId>` — idempotency key used by the one-click sync. */
  externalId?: string;
  /** Identifier of the local PC node that owns this card (absent = created via the admin API). */
  sourceNode?: string;
  /** Last time the owning node reported in via /api/sports/health-check (or a sync). */
  lastHeartbeatAt?: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

const SportsEventSchema = new Schema<ISportsEvent>(
  {
    matchTitle: { type: String, required: [true, "matchTitle is required"], trim: true, maxlength: 200 },
    sportType: { type: String, required: [true, "sportType is required"], trim: true, maxlength: 60, index: true },
    startTime: { type: Date, required: [true, "startTime is required"], index: true },
    endTime: { type: Date, required: [true, "endTime is required"] },
    status: {
      type: String,
      enum: { values: SPORTS_EVENT_STATUSES as unknown as string[], message: "status must be scheduled, live or ended" },
      default: "scheduled",
      index: true,
    },
    primaryStreamUrl: {
      type: String,
      required: [true, "primaryStreamUrl is required"],
      trim: true,
      maxlength: 2048,
      validate: { validator: isHttpUrl, message: "primaryStreamUrl must be an absolute http(s) URL" },
    },
    backupStreamUrls: {
      type: [String],
      default: [],
      validate: [
        {
          validator: (arr: string[]) => arr.length <= MAX_BACKUP_URLS,
          message: `backupStreamUrls can hold at most ${MAX_BACKUP_URLS} URLs`,
        },
        {
          validator: (arr: string[]) => arr.every((u) => typeof u === "string" && u.length <= 2048 && isHttpUrl(u)),
          message: "every backupStreamUrls entry must be an absolute http(s) URL",
        },
      ],
    },
    isLocalServerActive: { type: Boolean, default: false },
    priorityOrder: { type: Number, default: 99, min: 0, max: 9999, index: true },

    externalId: { type: String, trim: true, maxlength: 200, unique: true, sparse: true },
    sourceNode: { type: String, trim: true, maxlength: 100, index: true },
    lastHeartbeatAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "sportsevents" }
);

// End must come after start.
SportsEventSchema.pre("validate", function (next) {
  if (this.startTime && this.endTime && this.endTime.getTime() <= this.startTime.getTime()) {
    this.invalidate("endTime", "endTime must be later than startTime");
  }
  next();
});

// Serves GET /api/sports/events: status filter + priorityOrder/startTime sort.
SportsEventSchema.index({ status: 1, priorityOrder: 1, startTime: 1 });

// Delete models cache to prevent overwrite model error in hot reload (same pattern as Channel/StreamLink).
if (mongoose.models && mongoose.models.SportsEvent) {
  delete mongoose.models.SportsEvent;
}

const SportsEvent: Model<ISportsEvent> = mongoose.model<ISportsEvent>("SportsEvent", SportsEventSchema);
export default SportsEvent;
