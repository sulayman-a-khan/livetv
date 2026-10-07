import mongoose, { Schema, Document, Model } from "mongoose";
import {
  CHANNEL_CATEGORIES,
  DEFAULT_CATEGORY,
  normalizeCategory,
  type ChannelCategory,
} from "@/lib/categories";

export interface IChannel extends Document {
  name: string;
  normalizedName: string;
  logo: string;
  /** Exactly one of the five catalogue categories — no subcategories, no lists. */
  category: ChannelCategory;
  country: string;
  isPinned: boolean;
  priorityOrder: number;
  tags: string[];
  isManuallyEdited: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ChannelSchema = new Schema<IChannel>(
  {
    name: { type: String, required: true, trim: true },
    normalizedName: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
      trim: true,
    },
    logo: { type: String, default: "" },
    category: {
      type: String,
      enum: [...CHANNEL_CATEGORIES],
      default: DEFAULT_CATEGORY,
      index: true,
    },
    country: { type: String, default: "Global", index: true },
    /** Curated switch: only pinned channels reach the user-facing app. */
    isPinned: { type: Boolean, default: false, index: true },
    priorityOrder: { type: Number, default: 99, index: true },
    /** Free-form admin tags for manual categorisation overrides. */
    tags: { type: [String], default: [] },
    /** True once an admin edits the channel; blocks automated overwrites. */
    isManuallyEdited: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/**
 * Collapses anything a legacy document, an M3U group title or an admin form
 * stores into one of the five values. It runs before validation so the enum
 * check can never reject data that simply predates the five-category model.
 */
ChannelSchema.pre("validate", function collapseCategory() {
  const doc = this as any;
  doc.category = normalizeCategory(doc.category, doc.name, doc.country);
});

// The public catalogue always reads pinned-first, then priority, then name.
// Without this compound index MongoDB sorts the whole collection in memory.
ChannelSchema.index({ isPinned: -1, priorityOrder: 1, name: 1 });
// The scheduled health passes ask for "pinned channels in these categories".
ChannelSchema.index({ isPinned: 1, category: 1 });

// Delete models cache to prevent overwrite model error in hot reload
if (mongoose.models && mongoose.models.Channel) {
  delete mongoose.models.Channel;
}

const Channel: Model<IChannel> = mongoose.model<IChannel>("Channel", ChannelSchema);
export default Channel;
