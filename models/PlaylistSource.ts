import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * Playlist kinds a Direct HLS source can be. Kept as one exported list so the
 * API validation and the admin dropdown can never drift apart, and so a future
 * source type is a single addition here.
 */
export const PLAYLIST_SOURCE_TYPES = ["github-raw", "m3u", "m3u8", "other"] as const;

export type PlaylistSourceType = (typeof PLAYLIST_SOURCE_TYPES)[number];

export type PlaylistSyncStatus = "ok" | "unchanged" | "failed";

export interface IPlaylistSyncSummary {
  entriesParsed: number;
  channelsCreated: number;
  /** URLs the playlist newly lists, for a channel this source already knows. */
  newEntries: number;
  /** A channel kept its identity but got a different URL. */
  updatedUrls: number;
  entriesRemoved: number;
  linksAddedActive: number;
  linksAddedBroken: number;
  /** Dead URLs that left the playlist and were replaced by a working link. */
  linksRetired: number;
  linksRevived: number;
}

export interface IPlaylistSource extends Document {
  name: string;
  url: string;
  sourceType: PlaylistSourceType;
  /** Admin switch: an inactive source is never probed or synchronised. */
  active: boolean;
  /** Admin switch: when false the source only syncs when triggered by hand. */
  monitored: boolean;
  /** Hash of the last playlist body we fully processed — drives the "unchanged" skip. */
  contentHash: string;
  lastStatus: PlaylistSyncStatus;
  lastError: string;
  /** Failed fetches in a row. Existing data is only ever marked, never deleted. */
  consecutiveFetchFailures: number;
  lastCheckedAt: Date | null;
  /** Last run that completed without error, whether or not anything changed. */
  lastSyncAt: Date | null;
  /** Last run that actually found a difference in the playlist. */
  lastChangeAt: Date | null;
  lastSummary: IPlaylistSyncSummary;
  createdAt: Date;
  updatedAt: Date;
}

const PlaylistSyncSummarySchema = new Schema(
  {
    entriesParsed: { type: Number, default: 0 },
    channelsCreated: { type: Number, default: 0 },
    newEntries: { type: Number, default: 0 },
    updatedUrls: { type: Number, default: 0 },
    entriesRemoved: { type: Number, default: 0 },
    linksAddedActive: { type: Number, default: 0 },
    linksAddedBroken: { type: Number, default: 0 },
    linksRetired: { type: Number, default: 0 },
    linksRevived: { type: Number, default: 0 },
  },
  { _id: false }
);

const PlaylistSourceSchema = new Schema<IPlaylistSource>(
  {
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    sourceType: {
      type: String,
      enum: PLAYLIST_SOURCE_TYPES,
      default: "m3u",
      index: true,
    },
    active: { type: Boolean, default: true, index: true },
    monitored: { type: Boolean, default: true },
    contentHash: { type: String, default: "" },
    lastStatus: {
      type: String,
      enum: ["ok", "unchanged", "failed"],
      default: "ok",
    },
    lastError: { type: String, default: "" },
    consecutiveFetchFailures: { type: Number, default: 0 },
    lastCheckedAt: { type: Date, default: null },
    lastSyncAt: { type: Date, default: null },
    lastChangeAt: { type: Date, default: null },
    lastSummary: { type: PlaylistSyncSummarySchema, default: () => ({}) },
  },
  { timestamps: true, collection: "playlistsources" }
);

if (mongoose.models && mongoose.models.PlaylistSource) {
  delete mongoose.models.PlaylistSource;
}

const PlaylistSource: Model<IPlaylistSource> = mongoose.model<IPlaylistSource>(
  "PlaylistSource",
  PlaylistSourceSchema
);
export default PlaylistSource;
