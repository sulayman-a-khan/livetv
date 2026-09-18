import mongoose, { Schema, Document, Model } from "mongoose";

export interface IChannel extends Document {
  name: string;
  normalizedName: string;
  logo: string;
  category: string;
  subCategory?: string;
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
    category: { type: String, default: "General", index: true },
    subCategory: { type: String, default: "Others", index: true },
    country: { type: String, default: "Global", index: true },
    isPinned: { type: Boolean, default: false, index: true },
    priorityOrder: { type: Number, default: 99, index: true },
    /** Free-form admin tags for manual categorisation overrides. */
    tags: { type: [String], default: [] },
    /** True once an admin edits the channel; blocks automated overwrites. */
    isManuallyEdited: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Delete models cache to prevent overwrite model error in hot reload
if (mongoose.models && mongoose.models.Channel) {
  delete mongoose.models.Channel;
}

const Channel: Model<IChannel> = mongoose.model<IChannel>("Channel", ChannelSchema);
export default Channel;
