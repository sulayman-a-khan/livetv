/**
 * SoluPlay — Channel Maintenance Engine
 * ===================================
 * Implements the four backend invariants as PURE functions over plain records:
 *
 *   1. Auto-merge   — channels whose canonical name matches collapse into one
 *                     entry that owns every server link.
 *   2. Fastest-first— a channel's links are ordered by measured latency, so
 *                     priority 1 ("Server 1") is always the fastest working link.
 *   3. Test cleanup — placeholder/demo links are dropped as soon as the channel
 *                     owns at least one real, working link.
 *   4. Manual wins  — anything an admin edited by hand (`isManuallyEdited`) is
 *                     never overwritten by an automated pass.
 *
 * The planner returns a `MaintenancePlan` describing the mutations. Storage
 * adapters (in-memory / MongoDB) apply the plan. Keeping the rules pure means
 * both backends behave identically and the logic stays unit-testable.
 */

import { canonicalChannelKey, canonicalStreamUrl, isPlaceholderStream } from "./channelIdentity";

export interface MaintChannel {
  _id: string;
  name: string;
  normalizedName?: string;
  logo?: string;
  category?: string;
  subCategory?: string;
  country?: string;
  tags?: string[];
  isPinned?: boolean;
  priorityOrder?: number;
  isManuallyEdited?: boolean;
  createdAt?: Date | string;
}

export interface MaintStream {
  _id: string;
  channelId: string;
  url: string;
  priority: number;
  status: "active" | "degraded" | "broken";
  latency: number;
  failedAttempts?: number;
  lastCheckedAt?: Date | string | null;
}

export interface MaintenancePlan {
  /** Duplicate channel records to remove after their links were moved. */
  channelsToDelete: string[];
  /** Field patches for surviving channels (merged metadata, canonical key). */
  channelPatches: { _id: string; patch: Partial<MaintChannel> }[];
  /** Links that changed owner and/or position. */
  streamPatches: { _id: string; channelId: string; priority: number }[];
  /** Duplicate URLs and purged placeholder links. */
  streamsToDelete: string[];
  stats: {
    channelsMerged: number;
    duplicateLinksRemoved: number;
    placeholderLinksPurged: number;
    channelsReordered: number;
  };
}

/** Links that have never been probed sort last among working links. */
const UNMEASURED_LATENCY = Number.MAX_SAFE_INTEGER;

function effectiveLatency(s: MaintStream): number {
  if (!s.latency || s.latency <= 0) return UNMEASURED_LATENCY;
  return s.latency;
}

/** active → degraded → broken. Lower rank wins. */
function statusRank(status: MaintStream["status"]): number {
  if (status === "active") return 0;
  if (status === "degraded") return 1;
  return 2;
}

/**
 * RULE 2 — Fastest server becomes Server 1.
 * Ordering: working links before failing ones, then fastest first, then real
 * links before placeholders so a demo link can never outrank a real broadcast.
 */
export function sortStreamsBySpeed(streams: MaintStream[]): MaintStream[] {
  return [...streams].sort((a, b) => {
    const rank = statusRank(a.status) - statusRank(b.status);
    if (rank !== 0) return rank;

    const placeholder = Number(isPlaceholderStream(a.url)) - Number(isPlaceholderStream(b.url));
    if (placeholder !== 0) return placeholder;

    return effectiveLatency(a) - effectiveLatency(b);
  });
}

/**
 * RULE 3 — Placeholder purge.
 * Returns the ids of demo/test links that should be dropped, which is only ever
 * the case once the channel owns a real link that is currently working.
 */
export function selectPurgeableTestLinks(streams: MaintStream[]): string[] {
  const hasRealWorkingLink = streams.some(
    (s) => !isPlaceholderStream(s.url) && s.status === "active"
  );
  if (!hasRealWorkingLink) return [];
  return streams.filter((s) => isPlaceholderStream(s.url)).map((s) => s._id);
}

/** Picks which record survives a merge: manual edits win, then most working links, then oldest. */
function pickSurvivor(group: MaintChannel[], streamsByChannel: Map<string, MaintStream[]>): MaintChannel {
  return [...group].sort((a, b) => {
    const manual = Number(Boolean(b.isManuallyEdited)) - Number(Boolean(a.isManuallyEdited));
    if (manual !== 0) return manual;

    const pinned = Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned));
    if (pinned !== 0) return pinned;

    const aActive = (streamsByChannel.get(a._id) || []).filter((s) => s.status === "active").length;
    const bActive = (streamsByChannel.get(b._id) || []).filter((s) => s.status === "active").length;
    if (bActive !== aActive) return bActive - aActive;

    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return aTime - bTime;
  })[0];
}

const GENERIC_VALUES = new Set(["", "general", "others", "global", "all", "undefined", "unknown"]);

function isGeneric(value?: string): boolean {
  return GENERIC_VALUES.has((value || "").trim().toLowerCase());
}

/** Merges metadata from duplicates into the survivor without clobbering manual edits. */
function mergeMetadata(survivor: MaintChannel, others: MaintChannel[]): Partial<MaintChannel> {
  const patch: Partial<MaintChannel> = {
    normalizedName: canonicalChannelKey(survivor.name),
  };

  // A hand-edited record is authoritative — only its canonical key is refreshed.
  if (survivor.isManuallyEdited) return patch;

  for (const other of others) {
    if (!survivor.logo && other.logo) patch.logo = other.logo;
    if (isGeneric(survivor.category) && !isGeneric(other.category)) patch.category = other.category;
    if (isGeneric(survivor.subCategory) && !isGeneric(other.subCategory))
      patch.subCategory = other.subCategory;
    if (isGeneric(survivor.country) && !isGeneric(other.country)) patch.country = other.country;

    if (other.tags?.length) {
      patch.tags = Array.from(new Set([...(survivor.tags || []), ...(patch.tags || []), ...other.tags]));
    }
    // A pin anywhere in the group survives the merge.
    if (other.isPinned && !survivor.isPinned) {
      patch.isPinned = true;
      patch.priorityOrder = other.priorityOrder ?? survivor.priorityOrder ?? 99;
    }
  }

  return patch;
}

/**
 * Builds the full maintenance plan. Idempotent: running it on an already-clean
 * dataset produces an empty plan.
 */
export function planMaintenance(
  channels: MaintChannel[],
  streams: MaintStream[]
): MaintenancePlan {
  const plan: MaintenancePlan = {
    channelsToDelete: [],
    channelPatches: [],
    streamPatches: [],
    streamsToDelete: [],
    stats: {
      channelsMerged: 0,
      duplicateLinksRemoved: 0,
      placeholderLinksPurged: 0,
      channelsReordered: 0,
    },
  };

  // Index links by owner
  const streamsByChannel = new Map<string, MaintStream[]>();
  for (const s of streams) {
    if (!streamsByChannel.has(s.channelId)) streamsByChannel.set(s.channelId, []);
    streamsByChannel.get(s.channelId)!.push(s);
  }

  // ---- RULE 1: group by canonical identity ----
  const groups = new Map<string, MaintChannel[]>();
  for (const ch of channels) {
    const key = canonicalChannelKey(ch.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ch);
  }

  for (const group of Array.from(groups.values())) {
    const survivor = pickSurvivor(group, streamsByChannel);
    const duplicates = group.filter((c) => c._id !== survivor._id);

    // Gather every link the merged channel will own
    const owned: MaintStream[] = [...(streamsByChannel.get(survivor._id) || [])];
    for (const dup of duplicates) {
      owned.push(...(streamsByChannel.get(dup._id) || []));
    }

    // Drop links that point at the same URL twice, keeping the healthiest copy
    const seenUrls = new Map<string, MaintStream>();
    const kept: MaintStream[] = [];
    for (const s of sortStreamsBySpeed(owned)) {
      const key = canonicalStreamUrl(s.url);
      if (!key) {
        plan.streamsToDelete.push(s._id);
        continue;
      }
      if (seenUrls.has(key)) {
        plan.streamsToDelete.push(s._id);
        plan.stats.duplicateLinksRemoved++;
        continue;
      }
      seenUrls.set(key, s);
      kept.push(s);
    }

    // ---- RULE 3: purge demo links once a real working link exists ----
    const purgeIds = new Set(selectPurgeableTestLinks(kept));
    if (purgeIds.size > 0) {
      plan.streamsToDelete.push(...Array.from(purgeIds));
      plan.stats.placeholderLinksPurged += purgeIds.size;
    }
    const survivingLinks = kept.filter((s) => !purgeIds.has(s._id));

    // ---- RULE 2: renumber so the fastest working link is Server 1 ----
    const ordered = sortStreamsBySpeed(survivingLinks);
    let reordered = false;
    ordered.forEach((s, index) => {
      const priority = index + 1;
      if (s.channelId !== survivor._id || s.priority !== priority) {
        plan.streamPatches.push({ _id: s._id, channelId: survivor._id, priority });
        reordered = true;
      }
    });
    if (reordered) plan.stats.channelsReordered++;

    // ---- Metadata merge + duplicate removal ----
    const patch = mergeMetadata(survivor, duplicates);
    if (Object.keys(patch).length > 0) {
      plan.channelPatches.push({ _id: survivor._id, patch });
    }
    if (duplicates.length > 0) {
      plan.channelsToDelete.push(...duplicates.map((d) => d._id));
      plan.stats.channelsMerged += duplicates.length;
    }
  }

  // Orphaned links whose channel no longer exists
  const validChannelIds = new Set(channels.map((c) => c._id));
  for (const s of streams) {
    if (!validChannelIds.has(s.channelId) && !plan.streamsToDelete.includes(s._id)) {
      plan.streamsToDelete.push(s._id);
    }
  }

  return plan;
}

/**
 * Convenience wrapper for a single channel: used after a manual link add or a
 * link delete, where a full-catalogue pass would be wasteful.
 */
export function planChannelLinkRefresh(
  channelId: string,
  streams: MaintStream[]
): { streamPatches: MaintenancePlan["streamPatches"]; streamsToDelete: string[] } {
  const owned = streams.filter((s) => s.channelId === channelId);
  const purge = new Set(selectPurgeableTestLinks(owned));
  const ordered = sortStreamsBySpeed(owned.filter((s) => !purge.has(s._id)));

  const streamPatches = ordered
    .map((s, i) => ({ _id: s._id, channelId, priority: i + 1 }))
    .filter((p, i) => ordered[i].priority !== p.priority);

  return { streamPatches, streamsToDelete: Array.from(purge) };
}
