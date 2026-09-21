import mongoose, { Schema, Document, Model } from "mongoose";

export interface IStreamLink extends Document {
  channelId: mongoose.Types.ObjectId;
  url: string;
  priority: number;
  status: "active" | "degraded" | "broken";
  failedAttempts: number;
  firstFailedAt: Date | null;
  lastCheckedAt: Date | null;
  latency: number;
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
    // Some providers require a Referer or Origin; retain it for probes.
    headers: { type: Schema.Types.Mixed, default: undefined },
    // Flexible diagnostics from the last health check.
    lastCheck: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true }
);

// Ensure index on channelId and status for fast queries
StreamLinkSchema.index({ channelId: 1, status: 1 });

if (mongoose.models && mongoose.models.StreamLink) {
  delete mongoose.models.StreamLink;
}

const StreamLink: Model<IStreamLink> = mongoose.model<IStreamLink>("StreamLink", StreamLinkSchema);
export default StreamLink;
