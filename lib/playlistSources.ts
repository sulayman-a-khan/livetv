/**
 * SoluPlay — Direct HLS playlist source records
 * ============================================
 * Shared validation and dashboard payload for the playlist source admin routes,
 * so `POST`, `PATCH` and `GET` cannot disagree about what a source is.
 *
 * A playlist source is exactly the same "source" concept used by Secure HLS per
 * card: it is a provider of stream URLs, and any number of channels can come out
 * of one of them. Nothing here makes a source global — the playlist only feeds
 * the channels named inside it.
 */

import mongoose from "mongoose";
import { connectToDatabase } from "./db";
import PlaylistSource, {
  PLAYLIST_SOURCE_TYPES,
  type PlaylistSourceType,
} from "@/models/PlaylistSource";
import PlaylistEntry from "@/models/PlaylistEntry";
import { canonicalStreamUrl } from "./channelIdentity";
import {
  FAILED_RETRY_MS,
  getPlaylistMonitorStatus,
  lastScheduledSyncAt,
  nextScheduledSyncAt,
} from "./playlistMonitor";

export interface PlaylistSourceInput {
  name: string;
  url: string;
  sourceType: PlaylistSourceType;
  active: boolean;
  monitored: boolean;
}

export interface SourceValidation {
  value: Partial<PlaylistSourceInput>;
  errors: string[];
}

/** True when the URL is something we can actually download. */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url);
}

function toBool(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

/**
 * Validates a create (all fields considered) or a patch (only keys that were
 * sent). Mirrors how the Secure HLS source registry validates its input.
 */
export function validateSourceInput(
  body: Record<string, unknown>,
  creating: boolean
): SourceValidation {
  const value: Partial<PlaylistSourceInput> = {};
  const errors: string[] = [];
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (creating || has("name")) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) errors.push("Source name is required");
    else if (name.length > 120) errors.push("Source name must be 120 characters or fewer");
    else value.name = name;
  }

  if (creating || has("url")) {
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) errors.push("Playlist URL is required");
    else if (!isHttpUrl(url)) errors.push("Playlist URL must be a valid http(s) URL");
    else if (url.length > 2048) errors.push("Playlist URL is too long");
    else value.url = url;
  }

  if (creating || has("sourceType")) {
    const rawType = typeof body.sourceType === "string" ? body.sourceType.trim().toLowerCase() : "";
    if (!rawType) {
      if (creating) value.sourceType = "m3u";
    } else if (!(PLAYLIST_SOURCE_TYPES as readonly string[]).includes(rawType)) {
      errors.push(`sourceType must be one of: ${PLAYLIST_SOURCE_TYPES.join(", ")}`);
    } else {
      value.sourceType = rawType as PlaylistSourceType;
    }
  }

  if (creating || has("active")) value.active = toBool(body.active, true);
  if (creating || has("monitored")) value.monitored = toBool(body.monitored, true);

  return { value, errors };
}

/** Throws when MongoDB is down — playlist sources have no in-memory fallback. */
async function requireDatabase() {
  const conn = await connectToDatabase();
  if (!conn) {
    const err: Error & { status?: number } = new Error(
      "MongoDB is unreachable. Playlist sources and their sync state are stored in MongoDB, so this feature needs the database."
    );
    err.status = 503;
    throw err;
  }
  return conn;
}

export interface SourcePayload {
  _id: string;
  name: string;
  url: string;
  sourceType: string;
  active: boolean;
  monitored: boolean;
  lastStatus: string;
  lastError: string;
  consecutiveFetchFailures: number;
  lastCheckedAt: string | null;
  lastSyncAt: string | null;
  lastChangeAt: string | null;
  entriesParsed: number;
  summary: Record<string, number>;
  counts: { entries: number; present: number; missing: number; channels: number };
  /** When the daily monitor will look at this source again. */
  nextCheckAt: string | null;
  dueNow: boolean;
}

/** Everything the admin section needs: config, sync state, and entry counts. */
export async function getSourcesPayload() {
  await requireDatabase();

  const sources = await PlaylistSource.find().sort({ name: 1 }).lean();

  // One grouped query for every source instead of a count per source.
  const byStatus = await PlaylistEntry.aggregate<{
    _id: { source: mongoose.Types.ObjectId; status: "present" | "missing" };
    n: number;
  }>([
    { $group: { _id: { source: "$sourceId", status: "$status" }, n: { $sum: 1 } } },
  ]);

  const stats = new Map<string, { present: number; missing: number }>();
  for (const row of byStatus) {
    const key = String(row._id.source);
    const current = stats.get(key) || { present: 0, missing: 0 };
    current[row._id.status] = row.n;
    stats.set(key, current);
  }

  // Same schedule the monitor itself uses: the daily slot, plus the short retry
  // window for a source whose last fetch failed.
  const now = new Date();
  const slotPassedMs = lastScheduledSyncAt(now).getTime();
  const nextSlotMs = nextScheduledSyncAt(now).getTime();
  const retryDueBeforeMs = now.getTime() - FAILED_RETRY_MS;
  const payload: SourcePayload[] = [];

  for (const source of sources) {
    const id = String(source._id);
    const entryStats = stats.get(id) || { present: 0, missing: 0 };
    // Distinct channel identities this source currently provides — how many
    // separate channels the playlist feeds, never a global setting.
    const channels = await PlaylistEntry.distinct("channelKey", {
      sourceId: source._id,
      status: "present",
    });

    const lastCheckedMs = source.lastCheckedAt ? new Date(source.lastCheckedAt).getTime() : 0;
    const fetchFailed = source.lastStatus === "failed" && lastCheckedMs < retryDueBeforeMs;
    const dueNow =
      source.active &&
      source.monitored &&
      (!lastCheckedMs || lastCheckedMs < slotPassedMs || fetchFailed);
    // A failed source is retried inside the day, so it shows that retry time;
    // otherwise the next daily slot is when it is looked at.
    const nextCheckMs = fetchFailed
      ? Math.min(nextSlotMs, lastCheckedMs + FAILED_RETRY_MS)
      : nextSlotMs;

    payload.push({
      _id: id,
      name: source.name,
      url: source.url,
      sourceType: source.sourceType,
      active: Boolean(source.active),
      monitored: Boolean(source.monitored),
      lastStatus: source.lastStatus,
      lastError: source.lastError || "",
      consecutiveFetchFailures: source.consecutiveFetchFailures || 0,
      lastCheckedAt: source.lastCheckedAt ? new Date(source.lastCheckedAt).toISOString() : null,
      lastSyncAt: source.lastSyncAt ? new Date(source.lastSyncAt).toISOString() : null,
      lastChangeAt: source.lastChangeAt ? new Date(source.lastChangeAt).toISOString() : null,
      entriesParsed: source.lastSummary?.entriesParsed || 0,
      summary: {
        newEntries: source.lastSummary?.newEntries || 0,
        updatedUrls: source.lastSummary?.updatedUrls || 0,
        entriesRemoved: source.lastSummary?.entriesRemoved || 0,
        linksAddedActive: source.lastSummary?.linksAddedActive || 0,
        linksAddedBroken: source.lastSummary?.linksAddedBroken || 0,
        linksRetired: source.lastSummary?.linksRetired || 0,
        linksRevived: source.lastSummary?.linksRevived || 0,
      },
      counts: {
        entries: entryStats.present + entryStats.missing,
        present: entryStats.present,
        missing: entryStats.missing,
        channels: channels.length,
      },
      nextCheckAt: new Date(nextCheckMs).toISOString(),
      dueNow,
    });
  }

  return {
    sources: payload,
    monitor: getPlaylistMonitorStatus(),
    totals: {
      sources: payload.length,
      active: payload.filter((s) => s.active).length,
      monitored: payload.filter((s) => s.active && s.monitored).length,
      due: payload.filter((s) => s.dueNow).length,
      entries: payload.reduce((sum, s) => sum + s.counts.present, 0),
    },
  };
}

export async function createSource(value: PlaylistSourceInput) {
  await requireDatabase();

  const clash = await PlaylistSource.findOne({
    url: { $in: [value.url, `${value.url}/`] },
  }).lean();
  if (clash) {
    const err: Error & { status?: number } = new Error(
      `A source for this playlist URL already exists (${clash.name})`
    );
    err.status = 409;
    throw err;
  }

  const doc = await PlaylistSource.create({
    name: value.name,
    url: value.url,
    sourceType: value.sourceType || "m3u",
    active: value.active !== false,
    monitored: value.monitored !== false,
  });
  return PlaylistSource.findById(doc._id).lean();
}

/**
 * Patches a source. A URL change clears the content hash and entry rows for the
 * source: it is a different playlist, so the previous diff has no meaning — but
 * the channels and stream links it already provided are left untouched, because
 * those are catalogue data other sources and manual edits may share.
 */
export async function updateSource(id: string, value: Partial<PlaylistSourceInput>) {
  await requireDatabase();
  if (!mongoose.isValidObjectId(id)) {
    const err: Error & { status?: number } = new Error("Unknown playlist source");
    err.status = 404;
    throw err;
  }

  const existing = await PlaylistSource.findById(id).lean();
  if (!existing) {
    const err: Error & { status?: number } = new Error("Unknown playlist source");
    err.status = 404;
    throw err;
  }

  const patch: Record<string, unknown> = { ...value };
  const urlChanged =
    Boolean(value.url) && canonicalStreamUrl(value.url || "") !== canonicalStreamUrl(existing.url);
  if (urlChanged) {
    patch.contentHash = "";
    patch.lastStatus = "ok";
    patch.lastError = "";
    patch.consecutiveFetchFailures = 0;
    patch.lastCheckedAt = null;
  }

  await PlaylistSource.updateOne({ _id: id }, { $set: patch });
  if (urlChanged) {
    await PlaylistEntry.deleteMany({ sourceId: id });
  }

  return PlaylistSource.findById(id).lean();
}

/**
 * Removes a source and its entry rows. Channels and stream links it created stay
 * in the catalogue — deleting the playlist must not delete the library.
 */
export async function deleteSource(id: string) {
  await requireDatabase();
  if (!mongoose.isValidObjectId(id)) {
    const err: Error & { status?: number } = new Error("Unknown playlist source");
    err.status = 404;
    throw err;
  }
  const removed = await PlaylistSource.deleteOne({ _id: id });
  if (removed.deletedCount === 0) {
    const err: Error & { status?: number } = new Error("Unknown playlist source");
    err.status = 404;
    throw err;
  }
  const entries = await PlaylistEntry.deleteMany({ sourceId: id });
  return { entriesRemoved: entries.deletedCount || 0 };
}

export async function loadSourceById(id: string) {
  await requireDatabase();
  if (!mongoose.isValidObjectId(id)) return null;
  return PlaylistSource.findById(id).lean();
}
