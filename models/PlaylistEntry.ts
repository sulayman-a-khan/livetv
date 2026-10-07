import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * One stream URL as it appears in one playlist source.
 *
 * This table exists to keep *channel identity* separate from *stream URL*:
 * `channelKey` is the canonical name (see `lib/channelIdentity.ts`) while `url`
 * is whatever the playlist currently points at. When a provider republishes
 * "ESPN HD" on a new URL, the planner sees a second entry under the same
 * `channelKey` instead of creating a second channel.
 */
export type PlaylistEntryStatus = "present" | "missing";

export interface IPlaylistEntryLastProbe {
  ok: boolean;
  status: string;
  latency: number;
  reason: string;
  checkedAt: string;
}

export interface IPlaylistEntry extends Document {
  sourceId: mongoose.Types.ObjectId;
  channelKey: string;
  /** Display name from the playlist line this URL was read from. */
  name: string;
  url: string;
  /** Protocol/case/slash-insensitive form — the duplicate-URL guard. */
  canonicalUrl: string;
  status: PlaylistEntryStatus;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Set when the URL disappeared from the playlist; kept for recovery. */
  lastMissingAt: Date | null;
  lastProbe?: IPlaylistEntryLastProbe;
  createdAt: Date;
  updatedAt: Date;
}

const PlaylistEntrySchema = new Schema<IPlaylistEntry>(
  {
    sourceId: { type: Schema.Types.ObjectId, ref: "PlaylistSource", required: true, index: true },
    channelKey: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, default: "" },
    url: { type: String, required: true, trim: true },
    canonicalUrl: { type: String, required: true, trim: true, lowercase: true },
    status: {
      type: String,
      enum: ["present", "missing"],
      default: "present",
      index: true,
    },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    lastMissingAt: { type: Date, default: null },
    lastProbe: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true, collection: "playlistentries" }
);

PlaylistEntrySchema.index({ sourceId: 1, canonicalUrl: 1 }, { unique: true });
PlaylistEntrySchema.index({ sourceId: 1, channelKey: 1 });

if (mongoose.models && mongoose.models.PlaylistEntry) {
  delete mongoose.models.PlaylistEntry;
}

const PlaylistEntry: Model<IPlaylistEntry> = mongoose.model<IPlaylistEntry>(
  "PlaylistEntry",
  PlaylistEntrySchema
);
export default PlaylistEntry;
