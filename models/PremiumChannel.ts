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
   * The line the admin pasted. Served only to an authenticated admin response —
   * a viewer is given an entry point that the delivery layer signs later, so this
   * value must never reach a public route.
   */
  sourceUrl: string;
  /** Per-source request headers, because these feeds check them individually. */
  headers: { userAgent: string; referer: string };
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
    sourceUrl: { type: String, required: true, trim: true },
    headers: { type: PremiumChannelHeadersSchema, default: () => ({}) },
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
