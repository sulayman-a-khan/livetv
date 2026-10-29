import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * A box the site has learned the address of.
 *
 * One row per box, keyed by the box's own id, so a box that restarts with a new address
 * replaces its own row rather than adding another one. The newest row is the box the site
 * is using — the site has one stream box, and the last one that said where it is.
 */
export interface IProxyBox extends Document {
  /** The box's own name. A label, not a credential. */
  boxId: string;
  /** The address the site must reach the box at. */
  baseUrl: string;
  /** When the box said so. */
  registeredAt: Date;
}

const ProxyBoxSchema = new Schema<IProxyBox>(
  {
    boxId: { type: String, required: true, trim: true, index: true },
    baseUrl: { type: String, required: true, trim: true },
    registeredAt: { type: Date, required: true, index: true },
  },
  { timestamps: true, collection: "proxyboxes" }
);

if (mongoose.models && mongoose.models.ProxyBox) {
  delete mongoose.models.ProxyBox;
}

const ProxyBox: Model<IProxyBox> = mongoose.model<IProxyBox>("ProxyBox", ProxyBoxSchema);
export default ProxyBox;
