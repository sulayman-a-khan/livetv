/**
 * SoluPlay — Channel Maintenance Engine
 * ===================================
 * Implements the four backend invariants as PURE functions over plain records:
 *
 *   1. Auto-merge   — channels whose canonical name matches collapse into one
 *                     entry that owns every server link.
 *   2. Reliable first— a channel's links are ordered by what a viewer can actually
 *                     play, so priority 1 ("Server 1") is always the mirror the
 *                     viewer would be handed. See `compareStreamRank`.
 *   3. Test cleanup — placeholder/demo links are dropped as soon as the channel
 *                     owns at least one real, working link.
 *   4. Manual wins  — anything an admin edited by hand (`isManuallyEdited`) is
 *                     never overwritten by an automated pass, and a `manual`
 *                     link is never deleted by automation. In a merge the
 *                     curated (pinned) record is always the survivor, so a
 *                     duplicate can never delete a channel the admin pinned.
 *   5. Dead purge   — a link that fails the daily health check for
 *                     `DEAD_LINK_PURGE_DAYS` straight days, is not hand-added and
 *                     is no longer listed by any source is deleted; until then it
 *                     is only hidden, so it can recover on its own.
 *
 * The planner returns a `MaintenancePlan` describing the mutations. Storage
 * adapters (in-memory / MongoDB) apply the plan. Keeping the rules pure means
 * both backends behave identically and the logic stays unit-testable.
 */

import { canonicalChannelKey, canonicalStreamUrl, isPlaceholderStream } from "./channelIdentity";
import {
  DEAD_LINK_PURGE_DAYS,
  MAX_CONSECUTIVE_FAILURES,
  isUsableViewerLink,
} from "./streamHealth";

export interface MaintChannel {
  _id: string;
  name: string;
  normalizedName?: string;
  logo?: string;
  category?: string;
  tags?: string[];
  isPinned?: boolean;
  priorityOrder?: number;
  isManuallyEdited?: boolean;
  createdAt?: Date | string;
}

/**
 * The fields the ranking rule reads. A stored `StreamLink` (Mongo lean row or
 * in-memory record) and the public API's projected mirror both satisfy it, so the
 * order the maintenance pass writes and the order a viewer is served come from the
 * same comparator instead of two rules that can drift apart.
 */
export interface RankableStream {
  _id?: unknown;
  url?: string;
  priority?: number;
  status?: string;
  latency?: number;
  failedAttempts?: number;
  deliveryHidden?: boolean;
  deliveryMisses?: number | null;
  adminDisabled?: boolean;
}

export interface MaintStream extends RankableStream {
  _id: string;
  channelId: string;
  url: string;
  priority: number;
  status: "active" | "degraded" | "broken";
  latency: number;
  failedAttempts?: number;
  lastCheckedAt?: Date | string | null;
  /** Day the streak last moved — see `streamHealth.ts`. Gates the dead purge. */
  lastCountedFailureDay?: string | null;
  /** Hand-added link: never deleted by the automated dead-link purge. */
  manual?: boolean;
  /** Admin-disabled link: ranked last, never purged, never auto-restored. */
  adminDisabled?: boolean;
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
    deadLinksPurged: number;
    channelsReordered: number;
  };
}

/**
 * RULE 2 — The most reliable working server becomes Server 1.
 *
 * The order is decided by three questions, asked in this order:
 *
 *   1. Can a viewer be handed this link at all? `isUsableViewerLink` is the very
 *      gate the public catalogue uses, so a broken, retrying or "Not delivering"
 *      link can never be ranked as though it played. "Server 1" therefore always
 *      means the mirror a viewer would actually get, on web and on Android TV
 *      alike, because both are served this order.
 *   2. Has it been failing? A link whose last check delivered media outranks one
 *      still carrying a failure streak, however quick the streaked link answers.
 *   3. How quick was it, roughly? Latency only separates links already tied on
 *      health, and only in bands — a mirror that happens to answer 40ms faster on
 *      one pass does not take Server 1 away from the one before it.
 *
 * Still tied, a link keeps the number it already has; a channel whose ladder is
 * unchanged is therefore reproduced unchanged, so re-ranking costs no writes and
 * viewers see no shuffling. `_id` breaks anything left, which makes the whole
 * pass deterministic.
 */

/** Response times this far apart rank as equally quick. */
const LATENCY_BAND_MS = 500;

/**
 * Lower wins. Usable links first (clean record, then one still streaked), then the
 * links a viewer is never offered — retrying before dead — and an admin-disabled
 * link last of all, because only an admin puts it back in service.
 */
function reliabilityTier(s: RankableStream): number {
  if (s.adminDisabled) return 4;
  if (s.status === "active" && isUsableViewerLink(s)) {
    return (s.failedAttempts || 0) > 0 ? 1 : 0;
  }
  // `degraded` is one failed check that is still being retried; `broken`, and an
  // `active` link the catalogue refuses for delivery, are both further away from
  // playing, so they share the tier below it.
  if (s.status === "degraded") return 2;
  return 3;
}

function latencyBand(s: RankableStream): number {
  const ms = s.latency || 0;
  // 0 means "no successful check has ever timed this link", which is the absence
  // of evidence, not the fastest possible answer — so it ranks last in its tier.
  if (ms <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.floor(ms / LATENCY_BAND_MS);
}

export function compareStreamRank(a: RankableStream, b: RankableStream): number {
  const tier = reliabilityTier(a) - reliabilityTier(b);
  if (tier !== 0) return tier;

  const placeholder =
    Number(isPlaceholderStream(a.url || "")) - Number(isPlaceholderStream(b.url || ""));
  if (placeholder !== 0) return placeholder;

  const band = latencyBand(a) - latencyBand(b);
  if (band !== 0) return band;

  const priority = (a.priority || 99) - (b.priority || 99);
  if (priority !== 0) return priority;

  const aKey = String(a._id ?? a.url ?? "");
  const bKey = String(b._id ?? b.url ?? "");
  if (aKey === bKey) return 0;
  return aKey < bKey ? -1 : 1;
}

/** Ranked copy of a channel's ladder: Server 1 first, unusable links last. */
export function rankStreams<T extends RankableStream>(streams: T[]): T[] {
  return [...streams].sort(compareStreamRank);
}

/**
 * Did a fresh verdict move where this link belongs? Only its tier and its speed
 * band are asked: a probe that leaves both alone cannot change the order, so a
 * health pass re-ranks just the channels it really affected instead of writing
 * priorities for every link it happened to look at.
 */
export function rankingShifted(before: RankableStream, after: RankableStream): boolean {
  return (
    reliabilityTier(before) !== reliabilityTier(after) ||
    latencyBand(before) !== latencyBand(after)
  );
}

/**
 * The priority numbers a ranked ladder implies, skipping every link that already
 * holds the right one. A pass that changes nothing writes nothing.
 */
function priorityPatches(
  ordered: MaintStream[],
  ownerId: string
): MaintenancePlan["streamPatches"] {
  const patches: MaintenancePlan["streamPatches"] = [];
  ordered.forEach((s, index) => {
    const priority = index + 1;
    if (s.channelId !== ownerId || s.priority !== priority) {
      patches.push({ _id: s._id, channelId: ownerId, priority });
    }
  });
  return patches;
}

/**
 * RULE 5 — Dead-link removal.
 * A link is deleted only after `DEAD_LINK_PURGE_DAYS` consecutive failed daily
 * checks, and only when nothing protects it:
 *   - `manual` links are the admin's, automation never deletes them;
 *   - `adminDisabled` links are deliberately out of service;
 *   - a URL a playlist source still lists is left alone, because the row is the
 *     only record that this source owns that link (deleting it would silently
 *     drop the mapping until the provider changes the URL again);
 *   - a streak built without a `lastCountedFailureDay` marker came from the old
 *     probe-level counter, which could mature 3 "days" in an afternoon, so it is
 *     not trusted as evidence for a deletion. Such a link has to fail under the
 *     daily rules afresh before it can go.
 * Until all of that holds, a dead link is simply hidden and keeps being probed,
 * so it can come back on its own.
 */
export function selectPurgeableDeadLinks(
  streams: MaintStream[],
  listedCanonicalUrls: Set<string> | null
): string[] {
  // An empty set means no playlist source is configured at all, not that every
  // URL is unlisted. Without that evidence nothing may be deleted.
  if (!listedCanonicalUrls || listedCanonicalUrls.size === 0) return [];
  return streams
    .filter(
      (s) =>
        s.status === "broken" &&
        !s.manual &&
        !s.adminDisabled &&
        Boolean(s.lastCountedFailureDay) &&
        (s.failedAttempts || 0) >= Math.max(MAX_CONSECUTIVE_FAILURES, DEAD_LINK_PURGE_DAYS) &&
        !listedCanonicalUrls.has(canonicalStreamUrl(s.url))
    )
    .map((s) => s._id);
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

/**
 * Picks which record survives a merge.
 *
 * The pinned (curated) record wins first: it is the one users see, the one whose
 * category an admin verified, and the one whose link history the health engine
 * built, so losing it would silently undo curation. Hand-editing then working
 * links, then age.
 */
function pickSurvivor(group: MaintChannel[], streamsByChannel: Map<string, MaintStream[]>): MaintChannel {
  return [...group].sort((a, b) => {
    const pinned = Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned));
    if (pinned !== 0) return pinned;

    const manual = Number(Boolean(b.isManuallyEdited)) - Number(Boolean(a.isManuallyEdited));
    if (manual !== 0) return manual;

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
    // A curated (pinned) channel's category is the one an admin confirmed, so a
    // duplicate never rewrites it; otherwise a blank record borrows a filled one.
    if (
      !survivor.isPinned &&
      isGeneric(survivor.category) &&
      !isGeneric(other.category)
    ) {
      patch.category = other.category;
    }
    if (other.tags?.length) {
      patch.tags = Array.from(new Set([...(survivor.tags || []), ...(patch.tags || []), ...other.tags]));
    }
    // A pin anywhere in the group survives the merge, keeping the record that
    // carries it (and its board position) rather than the duplicate's.
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
  streams: MaintStream[],
  listedCanonicalUrls: Set<string> | null = null
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
      deadLinksPurged: 0,
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

    // Unpinned records are the admin's staging shelf: a group where nothing is
    // pinned is left exactly as it is, because automation may not delete a
    // channel nobody has curated yet. Only a pinned survivor absorbs duplicates.
    if (duplicates.length > 0 && !survivor.isPinned) continue;

    // Gather every link the merged channel will own
    const owned: MaintStream[] = [...(streamsByChannel.get(survivor._id) || [])];
    for (const dup of duplicates) {
      owned.push(...(streamsByChannel.get(dup._id) || []));
    }

    // Drop links that point at the same URL twice, keeping the healthiest copy
    const seenUrls = new Map<string, MaintStream>();
    const kept: MaintStream[] = [];
    for (const s of rankStreams(owned)) {
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

    // ---- RULE 5: delete links that stayed dead across the daily window ----
    const deadIds = new Set(selectPurgeableDeadLinks(survivingLinks, listedCanonicalUrls));
    if (deadIds.size > 0) {
      plan.streamsToDelete.push(...Array.from(deadIds));
      plan.stats.deadLinksPurged += deadIds.size;
    }
    const orderedLinks = survivingLinks.filter((s) => !deadIds.has(s._id));

    // ---- RULE 2: renumber so the most reliable working link is Server 1 ----
    const ordered = rankStreams(orderedLinks);
    const patches = priorityPatches(ordered, survivor._id);
    plan.streamPatches.push(...patches);
    if (patches.length > 0) plan.stats.channelsReordered++;

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
  const ordered = rankStreams(owned.filter((s) => !purge.has(s._id)));

  return {
    streamPatches: priorityPatches(ordered, channelId),
    streamsToDelete: Array.from(purge),
  };
}
