import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * A local mirror of the cloud proxy's 24/7 channel list.
 *
 * It holds the smallest possible projection: a key, a name, a category, a logo and
 * when the proxy last listed it. No password, no panel host, no stream id, no
 * token secret — a dump of this collection is not a way into anyone's IPTV account.
 *
 * Why mirror at all, when the proxy is the source of truth? So the homepage still
 * draws something when the proxy is briefly unreachable, and so a slow proxy never
 * decides how long the app's own API takes to answer.
 *
 * A play URL is deliberately NOT stored here: it is a time-boxed capability, and a
 * mirror row that carried one would hand an expired URL to the next viewer.
 */
export interface IProxyChannel extends Document {
  channelKey: string;
  displayName: string;
  category: string;
  logoUrl: string;
  /** Last time the proxy listed this channel, so a removed row can be reaped. */
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ProxyChannelSchema = new Schema<IProxyChannel>(
  {
    channelKey: { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
    displayName: { type: String, required: true, trim: true },
    category: { type: String, default: "", trim: true },
    logoUrl: { type: String, default: "", trim: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: "proxyChannels" }
);

if (mongoose.models && mongoose.models.ProxyChannel) {
  delete mongoose.models.ProxyChannel;
}

const ProxyChannel: Model<IProxyChannel> = mongoose.model<IProxyChannel>("ProxyChannel", ProxyChannelSchema);
export default ProxyChannel;
