import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * One viewer's saved channel list, as the site keeps it.
 *
 * The app has no accounts, so the key a list travels under IS the list's
 * identity: the device writes a key, shows it to the viewer, and the same key
 * on another device is the same list. The row therefore holds no name, no
 * address and no credential — only the channels the viewer picked.
 */
export interface IFavouriteList extends Document {
  /** The eight characters the list travels under. */
  key: string;
  /** The channel ids on the list, in the order the viewer marked them. */
  ids: string[];
  createdAt: Date;
  updatedAt: Date;
}

const FavouriteListSchema = new Schema<IFavouriteList>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
      uppercase: true,
      trim: true,
    },
    ids: { type: [String], default: [] },
  },
  { timestamps: true, collection: "favouritelists" }
);

// Delete models cache to prevent overwrite model error in hot reload
if (mongoose.models && mongoose.models.FavouriteList) {
  delete mongoose.models.FavouriteList;
}

const FavouriteList: Model<IFavouriteList> = mongoose.model<IFavouriteList>(
  "FavouriteList",
  FavouriteListSchema
);
export default FavouriteList;
