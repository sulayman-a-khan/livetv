/**
 * SoluPlay — Direct HLS Playlist Sync (storage adapter)
 * ==================================================
 * Fetches one playlist source, works out what changed with the pure planner in
 * `playlistSyncPlan.ts`, and applies it to MongoDB (`PlaylistSource`,
 * `PlaylistEntry`, `Channel`, `StreamLink`).
 *
 * Storage rules this file must never break:
 *   - A fetch failure changes nothing except the source's own status fields. No
 *     entry, channel or link is touched, so one dead CDN afternoon cannot empty
 *     the catalogue.
 *   - Channel identity comes from `canonicalChannelKey`, exactly like the manual
 *     ingest, so a re-published URL updates a channel instead of duplicating it.
 *   - Only links this source provided are ever retired; hand-added links and
 *     links owned by another source are left alone.
 *   - A sync never creates a Channel and never changes `isPinned`. New URLs are
 *     added only to channels the admin has already pinned.
 *
 * Playlist sources live in MongoDB by design (the specification requires the
 * configuration and sync state to survive restarts), so this adapter has no
 * in-memory twin — when MongoDB is unreachable it reports that plainly instead
 * of half-syncing into process memory.
 */

import crypto from "crypto";
import type { FilterQuery } from "mongoose";
import { connectToDatabase } from "./db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import PlaylistSource from "@/models/PlaylistSource";
import PlaylistEntry from "@/models/PlaylistEntry";
import { parseM3uContent } from "./m3uParser";
import { canonicalChannelKey, canonicalStreamUrl } from "./channelIdentity";
import { checkHlsStream, redactUrl, type HlsCheckResult } from "./streamProbe";
import { refreshChannelLinks } from "./maintenanceRunner";
import {
  groupPlaylistEntries,
  planPlaylistSync,
  selectProbeUrls,
  type ChannelState,
  type DesiredEntry,
  type PlaylistSyncPlan,
  type StoredEntry,
  type SyncGroup,
} from "./playlistSyncPlan";

/** Thrown for anything that must be recorded as a source problem, not a crash. */
export class PlaylistFetchError extends Error {}

export type PlaylistSyncEvent =
  | { phase: "fetch"; message: string }
  | { phase: "parse"; message: string; total: number }
  | { phase: "unchanged"; message: string }
  | { phase: "probe"; index: number; total: number; name: string; status: string; percent: number }
  | { phase: "apply"; message: string }
  | { phase: "done"; summary: PlaylistSyncSummary }
  | { phase: "error"; error: string };

export interface PlaylistSyncSummary {
  sourceId: string;
  sourceName: string;
  status: "ok" | "unchanged" | "failed";
  changed: boolean;
  entriesParsed: number;
  probesRun: number;
  stats: PlaylistSyncPlan["stats"];
  error: string;
  finishedAt: string;
}

const FETCH_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_CONCURRENCY = 15;

const EMPTY_STATS: PlaylistSyncSummary["stats"] = {
  newEntries: 0,
  updatedUrls: 0,
  entriesRemoved: 0,
  linksAddedActive: 0,
  linksAddedBroken: 0,
  linksRetired: 0,
  linksRevived: 0,
};

/**
 * Browser-like UA: several playlist hosts answer 403 to unknown clients, and the
 * stream probers already use this one.
 */
const PLAYLIST_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Downloads a playlist and rejects anything that is not a channel playlist. */
async function fetchPlaylistContent(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let body = "";
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": PLAYLIST_USER_AGENT, Accept: "application/x-mpegurl, text/plain, */*" },
    });
    if (!res.ok) {
      throw new PlaylistFetchError(`Playlist fetch failed: HTTP ${res.status} ${res.statusText}`);
    }
    body = await res.text();
  } catch (err: any) {
    if (err instanceof PlaylistFetchError) throw err;
    const reason =
      err?.name === "AbortError"
        ? `No response after ${FETCH_TIMEOUT_MS / 1000}s`
        : err?.cause?.code || err?.message || "Network error";
    throw new PlaylistFetchError(`Could not reach the playlist (${reason})`);
  } finally {
    clearTimeout(timer);
  }

  const text = (body || "").trim();
  if (!text) throw new PlaylistFetchError("Playlist came back empty — keeping the last synced data");
  // An HTML login/error page or a bare HLS master playlist is not a channel list.
  // Treating either as "an empty playlist" would wipe entries, so it is a failure.
  if (!/^#EXTM3U/m.test(text) && !/#EXTINF:/i.test(text)) {
    throw new PlaylistFetchError("No #EXTINF entries found — this is not a channel playlist");
  }
  return text;
}

function hashContent(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Playlist lines → the desired entries, deduped on (identity, URL). */
function toDesiredEntries(parsed: ReturnType<typeof parseM3uContent>): DesiredEntry[] {
  const seen = new Set<string>();
  const out: DesiredEntry[] = [];
  for (const item of parsed) {
    const channelKey = canonicalChannelKey(item.name);
    const canonicalUrl = canonicalStreamUrl(item.streamUrl);
    if (!channelKey || !canonicalUrl) continue;
    const dedupe = `${channelKey}\u0000${canonicalUrl}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      channelKey,
      name: item.name,
      url: item.streamUrl,
      canonicalUrl,
      logo: item.logo,
      category: item.category,
    });
  }
  return out;
}

async function loadChannelStates(
  keys: string[],
  storedEntries: StoredEntry[]
): Promise<ChannelState[]> {
  const channels = await Channel.find({ normalizedName: { $in: keys } })
    .select("_id name normalizedName isManuallyEdited isPinned")
    .lean();
  if (channels.length === 0) return [];

  const links = await StreamLink.find({
    channelId: { $in: channels.map((c) => c._id) },
  }).lean();

  // canonical url -> the entry rows this source wrote for it
  const providedByUrl = new Map(storedEntries.map((e) => [e.canonicalUrl, e]));

  return channels.map((channel) => {
    const owned = links.filter((l) => String(l.channelId) === String(channel._id));
    const sourceLinkIds = owned
      .filter((l) => providedByUrl.has(canonicalStreamUrl(l.url)))
      .map((l) => String(l._id));
    return {
      channelKey: channel.normalizedName,
      channelId: String(channel._id),
      isManuallyEdited: Boolean(channel.isManuallyEdited),
      isPinned: channel.isPinned === true,
      links: owned.map((l) => ({
        _id: String(l._id),
        url: l.url,
        canonicalUrl: canonicalStreamUrl(l.url),
        status: l.status,
        latency: l.latency || 0,
        failedAttempts: l.failedAttempts || 0,
        firstFailedAt: l.firstFailedAt || null,
        lastCountedFailureDay: l.lastCountedFailureDay ?? null,
        manual: Boolean(l.manual),
        adminDisabled: Boolean(l.adminDisabled),
      })),
      sourceLinkIds,
    };
  });
}

/** Probes with the same batching the health checker uses, reporting as it goes. */
async function probeUrls(
  urlByCanonical: Map<string, string>,
  namesByCanonical: Map<string, string>,
  onEvent?: (evt: PlaylistSyncEvent) => void
): Promise<Map<string, HlsCheckResult>> {
  const targets = Array.from(urlByCanonical.keys());
  const results = new Map<string, HlsCheckResult>();
  let index = 0;

  for (let i = 0; i < targets.length; i += PROBE_CONCURRENCY) {
    const batch = targets.slice(i, i + PROBE_CONCURRENCY);
    await Promise.all(
      batch.map(async (canonical) => {
        const url = urlByCanonical.get(canonical) || "";
        try {
          const result = await checkHlsStream(url, {
            timeoutMs: PROBE_TIMEOUT_MS,
            maxAttempts: 2,
            checkLiveRefresh: false,
            useFfprobe: false,
          });
          results.set(canonical, result);
        } catch (err: any) {
          onEvent?.({
            phase: "probe",
            index: ++index,
            total: targets.length,
            name: namesByCanonical.get(canonical) || redactUrl(url),
            status: "probe-error",
            percent: Math.round((index / targets.length) * 100),
          });
          return;
        }
        const result = results.get(canonical)!;
        onEvent?.({
          phase: "probe",
          index: ++index,
          total: targets.length,
          name: namesByCanonical.get(canonical) || redactUrl(url),
          status: result.ok || result.status === "DEGRADED" ? "active" : "unavailable",
          percent: Math.round((index / targets.length) * 100),
        });
      })
    );
  }

  return results;
}

/** Records a fetch/sync problem and nothing else. Existing data stays untouched. */
async function recordFailure(
  sourceId: string,
  sourceName: string,
  message: string,
  startedAt: Date
): Promise<PlaylistSyncSummary> {
  await PlaylistSource.updateOne(
    { _id: sourceId },
    {
      $set: { lastCheckedAt: startedAt, lastStatus: "failed", lastError: message },
      $inc: { consecutiveFetchFailures: 1 },
    }
  );
  return {
    sourceId,
    sourceName,
    status: "failed",
    changed: false,
    entriesParsed: 0,
    probesRun: 0,
    stats: { ...EMPTY_STATS },
    error: message,
    finishedAt: new Date().toISOString(),
  };
}

export interface SyncOptions {
  /** Skip the "playlist is byte-identical" short-circuit. */
  force?: boolean;
  onEvent?: (evt: PlaylistSyncEvent) => void;
  now?: Date;
}

/**
 * Runs one source's sync end to end. Safe to call repeatedly: an unchanged
 * playlist costs a single fetch, and every write is keyed on (source, URL) or
 * (channel, URL), so an interrupted run resumes without duplicating anything.
 */
export async function syncPlaylistSource(
  sourceId: string,
  options: SyncOptions = {}
): Promise<PlaylistSyncSummary> {
  const now = options.now || new Date();
  const onEvent = options.onEvent;

  const conn = await connectToDatabase();
  if (!conn) {
    throw new Error("MongoDB is unreachable — playlist sources need the database to sync");
  }

  const source = await PlaylistSource.findById(sourceId).lean();
  if (!source) throw new Error("Playlist source not found");

  const sourceName = source.name;

  let content: string;
  onEvent?.({ phase: "fetch", message: `Downloading ${source.url} …` });
  try {
    content = await fetchPlaylistContent(source.url);
  } catch (err: any) {
    const message = err?.message || "Playlist fetch failed";
    onEvent?.({ phase: "error", error: message });
    return recordFailure(sourceId, sourceName, message, now);
  }

  const hash = hashContent(content);
  const storedCount = await PlaylistEntry.countDocuments({ sourceId });

  if (!options.force && source.contentHash === hash && storedCount > 0) {
    await PlaylistSource.updateOne(
      { _id: sourceId },
      {
        $set: {
          lastCheckedAt: now,
          lastSyncAt: now,
          lastStatus: "unchanged",
          lastError: "",
          consecutiveFetchFailures: 0,
        },
      }
    );
    const summary: PlaylistSyncSummary = {
      sourceId,
      sourceName,
      status: "unchanged",
      changed: false,
      entriesParsed: storedCount,
      probesRun: 0,
      stats: { ...EMPTY_STATS },
      error: "",
      finishedAt: now.toISOString(),
    };
    onEvent?.({
      phase: "unchanged",
      message: `Playlist unchanged since the last check (${storedCount} entries kept as they are).`,
    });
    onEvent?.({ phase: "done", summary });
    return summary;
  }

  const parsed = parseM3uContent(content);
  onEvent?.({
    phase: "parse",
    total: parsed.length,
    message: `Parsed ${parsed.length} playlist entries.`,
  });

  const desired = toDesiredEntries(parsed);

  const storedEntries: StoredEntry[] = (
    await PlaylistEntry.find({ sourceId }).lean()
  ).map((entry) => ({
    _id: String(entry._id),
    channelKey: entry.channelKey,
    name: entry.name,
    url: entry.url,
    canonicalUrl: entry.canonicalUrl,
    status: entry.status,
  }));

  const keys = Array.from(
    new Set([...desired.map((d) => d.channelKey), ...storedEntries.map((e) => e.channelKey)])
  );
  const channels = await loadChannelStates(keys, storedEntries);

  const groups: SyncGroup[] = groupPlaylistEntries({ desired, storedEntries, channels });
  const probeTargets = selectProbeUrls(groups);

  const urlByCanonical = new Map<string, string>();
  const namesByCanonical = new Map<string, string>();
  for (const entry of desired) {
    urlByCanonical.set(entry.canonicalUrl, entry.url);
    namesByCanonical.set(entry.canonicalUrl, entry.name);
  }
  for (const entry of storedEntries) {
    if (!urlByCanonical.has(entry.canonicalUrl)) {
      urlByCanonical.set(entry.canonicalUrl, entry.url);
      namesByCanonical.set(entry.canonicalUrl, entry.name || "");
    }
  }

  const onlyProbe = new Map<string, string>();
  for (const canonical of probeTargets) {
    const url = urlByCanonical.get(canonical);
    if (url) onlyProbe.set(canonical, url);
  }

  const probes = await probeUrls(onlyProbe, namesByCanonical, onEvent);
  const plan = planPlaylistSync(groups, probes, now);

  onEvent?.({
    phase: "apply",
    message: `Applying ${plan.linksToCreate.length} link(s) to pinned channels, ${plan.linksToDelete.length} retirement(s).`,
  });

  await applyPlan(sourceId, plan);

  // Entries the playlist still lists, that needed no change, only need a fresh
  // "still here" timestamp. Runs after the patches so vanished entries (already
  // flipped to `missing`) are not touched by it.
  await PlaylistEntry.updateMany({ sourceId, status: "present" }, { $set: { lastSeenAt: now } });

  const changed =
    plan.linksToCreate.length > 0 ||
    plan.linksToDelete.length > 0 ||
    plan.entryPatches.length > 0 ||
    plan.entriesToCreate.length > 0 ||
    plan.linkPatches.length > 0;

  await PlaylistSource.updateOne(
    { _id: sourceId },
    {
      $set: {
        contentHash: hash,
        lastCheckedAt: now,
        lastSyncAt: now,
        ...(changed ? { lastChangeAt: now } : {}),
        lastStatus: changed ? "ok" : "unchanged",
        lastError: "",
        consecutiveFetchFailures: 0,
        lastSummary: { ...plan.stats, entriesParsed: desired.length },
      },
    }
  );

  const summary: PlaylistSyncSummary = {
    sourceId,
    sourceName,
    status: changed ? "ok" : "unchanged",
    changed,
    entriesParsed: desired.length,
    probesRun: probes.size,
    stats: plan.stats,
    error: "",
    finishedAt: now.toISOString(),
  };
  onEvent?.({ phase: "done", summary });
  return summary;
}

/** Writes a plan to MongoDB. Order matters: links, then entries. */
async function applyPlan(sourceId: string, plan: PlaylistSyncPlan): Promise<void> {
  // The planner only ever links a channel that already exists and is pinned, so
  // the identity → id map comes straight from the groups; nothing is created here.
  const idByKey = new Map<string, string>();
  for (const group of plan.groups) {
    if (group.channelId) idByKey.set(group.channelKey, group.channelId);
  }

  for (const patch of plan.linkPatches) {
    await StreamLink.updateOne({ _id: patch._id }, { $set: patch.patch });
  }

  for (const create of plan.linksToCreate) {
    const channelId = idByKey.get(create.channelKey);
    if (!channelId) continue;
    const pinned = plan.groups.find((g) => g.channelKey === create.channelKey)?.isPinned;
    if (!pinned) continue;
    const count = await StreamLink.countDocuments({ channelId });
    await StreamLink.create({
      channelId,
      url: create.url,
      priority: count + 1,
      status: create.status,
      latency: create.latency,
      failedAttempts: create.failedAttempts,
      firstFailedAt: create.firstFailedAt,
      lastCheckedAt: create.lastCheckedAt,
    });
  }

  if (plan.linksToDelete.length > 0) {
    await StreamLink.deleteMany({ _id: { $in: plan.linksToDelete } });
  }

  for (const patch of plan.entryPatches) {
    await PlaylistEntry.updateOne({ _id: patch._id, sourceId }, { $set: patch.patch });
  }

  for (const create of plan.entriesToCreate) {
    try {
      await PlaylistEntry.create({
        sourceId,
        channelKey: create.channelKey,
        name: create.name,
        url: create.url,
        canonicalUrl: create.canonicalUrl,
        status: "present",
        firstSeenAt: create.firstSeenAt,
        lastSeenAt: create.lastSeenAt,
        lastProbe: create.lastProbe,
      });
    } catch (err: any) {
      // Unique (sourceId, canonicalUrl): the row already exists, so refresh it.
      if (err?.code !== 11000) throw err;
      await PlaylistEntry.updateOne(
        { sourceId, canonicalUrl: create.canonicalUrl },
        {
          $set: {
            status: "present",
            name: create.name,
            url: create.url,
            lastSeenAt: create.lastSeenAt,
            lastMissingAt: null,
            ...(create.lastProbe ? { lastProbe: create.lastProbe } : {}),
          },
        }
      );
    }
  }

  // Keep every touched channel's server order and placeholder cleanup correct.
  const touched = new Set<string>();
  plan.linksToCreate.forEach((l) => {
    const id = idByKey.get(l.channelKey);
    if (id) touched.add(id);
  });
  plan.linkPatches.forEach((p) => {
    const group = plan.groups.find((g) => g.links.some((l) => l._id === p._id));
    if (group?.channelId) touched.add(group.channelId);
  });
  for (const channelId of touched) {
    try {
      await refreshChannelLinks(channelId);
    } catch (err: any) {
      console.error(`[playlistSync] link refresh failed for ${channelId}:`, err?.message || err);
    }
  }
}

export interface SyncAllOptions {
  /** Sync every active source, ignoring the schedule slot and its retry window. */
  force?: boolean;
  /** Re-sync sources whose last fetch failed at least this long ago. */
  failedRetryBefore?: Date;
  onEvent?: (evt: PlaylistSyncEvent & { sourceId?: string }) => void;
}

/** Convenience for the monitor and the admin routes. */
export async function syncAllDueSources(
  dueBefore: Date,
  options: SyncAllOptions = {}
): Promise<PlaylistSyncSummary[]> {
  const conn = await connectToDatabase();
  if (!conn) throw new Error("MongoDB is unreachable — playlist sources need the database to sync");

  const due: FilterQuery<any>[] = [{ lastCheckedAt: null }, { lastCheckedAt: { $lt: dueBefore } }];
  if (options.failedRetryBefore) {
    // A source that could not be fetched is retried inside the day instead of
    // losing a whole schedule slot; the retry only looks at fetch failures.
    due.push({ lastStatus: "failed", lastCheckedAt: { $lt: options.failedRetryBefore } });
  }

  const sources = await PlaylistSource.find({
    active: true,
    monitored: true,
    ...(options.force ? {} : { $or: due }),
  }).lean();

  const summaries: PlaylistSyncSummary[] = [];
  // Sources run one at a time: each one can probe hundreds of streams, and
  // overlapping two of them would only make both slower.
  for (const source of sources) {
    try {
      const summary = await syncPlaylistSource(String(source._id), {
        force: options.force,
        onEvent: options.onEvent && ((evt) => options.onEvent!({ ...evt, sourceId: String(source._id) })),
      });
      summaries.push(summary);
    } catch (err: any) {
      console.error(
        `[playlistSync] ${source.name} failed:`,
        err?.message || err
      );
    }
  }
  return summaries;
}
