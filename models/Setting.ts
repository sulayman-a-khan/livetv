import mongoose, { Schema, Document, Model } from "mongoose";

export interface ISetting extends Document {
  key: string;
  value: string;
  updatedAt: Date;
  createdAt: Date;
}

const SettingSchema = new Schema<ISetting>(
  {
    key: { type: String, required: true, unique: true, trim: true, index: true },
    value: { type: String, required: true, trim: true },
  },
  { timestamps: true, collection: "settings" }
);

if (mongoose.models && mongoose.models.Setting) {
  delete mongoose.models.Setting;
}

const Setting: Model<ISetting> = mongoose.model<ISetting>("Setting", SettingSchema);
export default Setting;
