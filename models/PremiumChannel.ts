import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * A premium (admin-supplied) channel. Its own collection, deliberately not a
 * `Channel` row: the Direct HLS catalogue, its ranking pass and its maintenance
 * sweep all read `Channel`/`StreamLink`, and this tier must never enter them.
 */
export interface IPremiumChannel extends Document {
  name: string;
  /** Free-text grouping for the premium rail, e.g. "Sports" or "Movies". */
  category: string;
  logoUrl: string;
  /**
   * Legacy: the line an admin pasted before the box held the credentials. It is no longer
   * written and never read for playback, but rows that already carry one are left exactly as
   * they are. A viewer-facing route must never use this field.
   */
  sourceUrl: string;
  /** Per-source request headers, because these feeds check them individually. */
  headers: { userAgent: string; referer: string };
  /**
   * The handle this channel's stream is registered under on the proxy box, which is where
   * the real source lives. This row deliberately keeps no URL: a leak of this database —
   * or of any route that reads it — then carries nothing watchable. Empty means the admin
   * has not pushed a source yet, and a viewer is told so instead of being handed a dead player.
   */
  proxyChannelKey: string;
  /** When the source was last pushed to the box, so a panel run leaves visible evidence. */
  proxyPushedAt: Date | null;
  /** Admin switch: an inactive channel is hidden from the rail. */
  active: boolean;
  /** Rail position. The admin's own order, like a pinned channel's. */
  sortOrder: number;
  note: string;
  createdAt: Date;
  updatedAt: Date;
}

const PremiumChannelHeadersSchema = new Schema(
  {
    userAgent: { type: String, default: "" },
    referer: { type: String, default: "" },
  },
  { _id: false }
);

const PremiumChannelSchema = new Schema<IPremiumChannel>(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, default: "Premium", trim: true },
    logoUrl: { type: String, default: "", trim: true },
    sourceUrl: { type: String, default: "", trim: true },
    headers: { type: PremiumChannelHeadersSchema, default: () => ({}) },
    proxyChannelKey: { type: String, default: "", trim: true, index: true },
    proxyPushedAt: { type: Date, default: null },
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 99 },
    note: { type: String, default: "", trim: true },
  },
  { timestamps: true, collection: "premiumchannels" }
);

if (mongoose.models && mongoose.models.PremiumChannel) {
  delete mongoose.models.PremiumChannel;
}

const PremiumChannel: Model<IPremiumChannel> = mongoose.model<IPremiumChannel>(
  "PremiumChannel",
  PremiumChannelSchema
);
export default PremiumChannel;
