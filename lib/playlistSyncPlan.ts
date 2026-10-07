/**
 * SoluPlay — Direct HLS Playlist Sync Planner
 * ==========================================
 * PURE rules over plain records, exactly like `channelMaintenance.ts`: this file
 * decides what a changed playlist means, it never touches MongoDB or the
 * in-memory store. `lib/playlistSync.ts` is the storage adapter.
 *
 * The whole point is that a channel's *identity* and its *stream URL* are
 * separate. Identity is `canonicalChannelKey(name)` (the same key the ingest,
 * the merge pass and the admin editor already use); the URL is an attribute of
 * that identity, so "ESPN HD moved to a new URL" updates one channel instead of
 * creating a second one.
 *
 * Availability rules (the four cases the daily check has to get right):
 *   A  old works, new works   → keep both, both stay active
 *   B  old dead,  new works   → new link serves the channel, the old URL is
 *                               retired only when it has also left the playlist
 *   C  old works, new dead    → keep the working URL, add the new one as a
 *                               broken candidate for the next check
 *   D  old dead,  new dead    → nothing is deleted, both links are marked and
 *                               the channel can recover on a later run
 * A playlist that cannot be fetched never reaches this planner at all.
 *
 * Pin gate: cases A–D only ever apply to a channel the admin has *pinned*. The
 * catalogue is curated by hand, so a sync may add or retire links on a pinned
 * channel but must never create a channel, never pin one and never touch an
 * unpinned one — an unpinned entry still gets its `PlaylistEntry` row kept
 * accurate, so the admin can see that the source lists it.
 */

import { decideStreamHealth, type StoredStreamStatus } from "./streamHealth";
import type { HlsCheckResult } from "./streamProbe";

/** One `#EXTINF` + URL pair as it appears in the playlist right now. */
export interface DesiredEntry {
  channelKey: string;
  name: string;
  url: string;
  canonicalUrl: string;
  logo?: string;
  category?: string;
}

/** A `PlaylistEntry` row already stored for this source. */
export interface StoredEntry {
  _id: string;
  channelKey: string;
  name?: string;
  url: string;
  canonicalUrl: string;
  status: "present" | "missing";
}

/** A `StreamLink` row already attached to the resolved channel. */
export interface ChannelLink {
  _id: string;
  url: string;
  canonicalUrl: string;
  status: StoredStreamStatus;
  latency: number;
  failedAttempts?: number;
  firstFailedAt?: Date | null;
  lastCountedFailureDay?: string | null;
  /** Hand-added link: this source may not retire it. */
  manual?: boolean;
  /** Taken out of service by an admin: this source may not re-enable it. */
  adminDisabled?: boolean;
}

/** The channel record (if any) that a canonical key resolves to. */
export interface ChannelState {
  channelKey: string;
  channelId: string | null;
  isManuallyEdited?: boolean;
  /** Curated by the admin — the only channels a playlist may add links to. */
  isPinned?: boolean;
  links: ChannelLink[];
  /** Links this source previously supplied — the only retirement candidates. */
  sourceLinkIds: string[];
}

export interface SyncGroup {
  channelKey: string;
  channelId: string | null;
  isManuallyEdited: boolean;
  isPinned: boolean;
  links: ChannelLink[];
  sourceLinkIds: string[];
  desired: DesiredEntry[];
  storedPresent: StoredEntry[];
  storedMissing: StoredEntry[];
  /** Desired URLs with no stored entry for this source (new channel or new URL). */
  newEntries: DesiredEntry[];
  /** Stored present entries the playlist no longer lists. */
  vanishedEntries: StoredEntry[];
  /** New entries whose URL was seen before and has come back. */
  returningEntries: DesiredEntry[];
  changed: boolean;
}

export interface PlaylistSyncPlan {
  groups: SyncGroup[];
  linksToCreate: {
    channelKey: string;
    url: string;
    status: StoredStreamStatus;
    latency: number;
    failedAttempts: number;
    firstFailedAt: Date | null;
    lastCheckedAt: Date;
  }[];
  linkPatches: { _id: string; patch: Record<string, unknown> }[];
  /** Old URLs of this source that are dead, gone from the playlist and replaced. */
  linksToDelete: string[];
  entriesToCreate: {
    channelKey: string;
    name: string;
    url: string;
    canonicalUrl: string;
    firstSeenAt: Date;
    lastSeenAt: Date;
    lastProbe?: Record<string, unknown>;
  }[];
  entryPatches: { _id: string; patch: Record<string, unknown> }[];
  stats: {
    newEntries: number;
    updatedUrls: number;
    entriesRemoved: number;
    linksAddedActive: number;
    linksAddedBroken: number;
    linksRetired: number;
    linksRevived: number;
  };
}

export interface PlannerInput {
  desired: DesiredEntry[];
  storedEntries: StoredEntry[];
  channels: ChannelState[];
}

/**
 * Bundles stored state and playlist state per channel identity. A key can hold
 * several URLs at once (a channel listed twice with mirrors, or an old and a new
 * URL during a provider migration) — that is normal and is kept that way.
 */
export function groupPlaylistEntries(input: PlannerInput): SyncGroup[] {
  const { desired, storedEntries, channels } = input;

  const keys = new Set<string>();
  desired.forEach((d) => keys.add(d.channelKey));
  storedEntries.forEach((e) => keys.add(e.channelKey));
  channels.forEach((c) => keys.add(c.channelKey));

  const channelsByKey = new Map(channels.map((c) => [c.channelKey, c]));

  const groups: SyncGroup[] = [];
  for (const channelKey of Array.from(keys)) {
    const channel = channelsByKey.get(channelKey) || null;
    const groupDesired = desired.filter((d) => d.channelKey === channelKey);
    const groupStored = storedEntries.filter((e) => e.channelKey === channelKey);
    const storedPresent = groupStored.filter((e) => e.status === "present");
    const storedMissing = groupStored.filter((e) => e.status === "missing");

    const presentUrls = new Set(storedPresent.map((e) => e.canonicalUrl));
    const missingUrls = new Set(storedMissing.map((e) => e.canonicalUrl));
    const desiredUrls = new Set(groupDesired.map((d) => d.canonicalUrl));

    const newEntries = groupDesired.filter((d) => !presentUrls.has(d.canonicalUrl));
    const vanishedEntries = storedPresent.filter((e) => !desiredUrls.has(e.canonicalUrl));
    const returningEntries = newEntries.filter((d) => missingUrls.has(d.canonicalUrl));

    groups.push({
      channelKey,
      channelId: channel ? channel.channelId : null,
      isManuallyEdited: Boolean(channel?.isManuallyEdited),
      isPinned: Boolean(channel?.isPinned),
      links: channel ? channel.links : [],
      sourceLinkIds: channel ? channel.sourceLinkIds : [],
      desired: groupDesired,
      storedPresent,
      storedMissing,
      newEntries,
      vanishedEntries,
      returningEntries,
      changed: newEntries.length > 0 || vanishedEntries.length > 0,
    });
  }

  return groups;
}

/**
 * URLs that need a live probe before the plan can be decided: every URL of a
 * changed, *pinned* group — the incoming one (it must be verified before it can
 * serve the channel) and this source's outgoing ones (Case B needs to know the
 * old URL is genuinely dead before it is retired). Unchanged groups are never
 * probed, so a daily run only tests what actually moved in the playlist, and an
 * unpinned channel is never probed at all because no probe result can be applied
 * to it.
 */
export function selectProbeUrls(groups: SyncGroup[]): string[] {
  const out = new Set<string>();
  for (const group of groups) {
    if (!group.changed || !group.isPinned) continue;
    for (const entry of group.newEntries) {
      out.add(entry.canonicalUrl);
    }
    for (const entry of group.vanishedEntries) {
      const link = group.links.find((l) => l.canonicalUrl === entry.canonicalUrl);
      // A link that is already known broken needs no re-test; only a link that
      // still claims to work has to be confirmed dead before it can be retired.
      if (!link) continue;
      if (link.status !== "broken") out.add(entry.canonicalUrl);
    }
  }
  return Array.from(out);
}

function toProbeDetail(result: HlsCheckResult) {
  return {
    ok: result.ok,
    status: result.status,
    errorCode: result.errorCode,
    httpStatus: result.httpStatus,
    latency: result.latency,
    reason: result.reason || null,
    checkedAt: result.checkedAt,
  };
}

/**
 * Turns the grouped state plus probe results into the mutations to apply.
 * `probes` is keyed by canonical URL; a missing probe means "no fresh evidence",
 * in which case the stored status is trusted as-is (never delete on a guess).
 */
export function planPlaylistSync(
  groups: SyncGroup[],
  probes: Map<string, HlsCheckResult>,
  now: Date = new Date()
): PlaylistSyncPlan {
  const plan: PlaylistSyncPlan = {
    groups,
    linksToCreate: [],
    linkPatches: [],
    linksToDelete: [],
    entriesToCreate: [],
    entryPatches: [],
    stats: {
      newEntries: 0,
      updatedUrls: 0,
      entriesRemoved: 0,
      linksAddedActive: 0,
      linksAddedBroken: 0,
      linksRetired: 0,
      linksRevived: 0,
    },
  };

  for (const group of groups) {
    // Fails closed: a playlist may only move links on a channel the admin has
    // pinned. An unknown identity (no channel yet) and an unpinned one are both
    // left alone — the sync never creates a channel and never pins one.
    const pinned = Boolean(group.channelId && group.isPinned);

    // URLs this channel really has after the run: everything the playlist lists
    // plus links from other sources that the playlist says nothing about.
    const desiredUrls = new Set(group.desired.map((d) => d.canonicalUrl));
    const linkByUrl = new Map(group.links.map((l) => [l.canonicalUrl, l]));

    for (const entry of group.newEntries) {
      const probe = pinned ? probes.get(entry.canonicalUrl) : undefined;
      const working = Boolean(probe && (probe.ok || probe.status === "DEGRADED"));

      // Duplicate-URL guard: the same URL may already be on the channel under a
      // different name spelling, or added by hand. Record the entry, never a copy.
      const alreadyLinked = linkByUrl.has(entry.canonicalUrl);
      if (!alreadyLinked && pinned) {
        plan.linksToCreate.push({
          channelKey: group.channelKey,
          url: entry.url,
          status: working ? "active" : "broken",
          latency: probe ? probe.latency : 0,
          failedAttempts: working ? 0 : probe ? 1 : 0,
          firstFailedAt: working ? null : probe ? now : null,
          lastCheckedAt: now,
        });
        if (working) plan.stats.linksAddedActive++;
        else plan.stats.linksAddedBroken++;
      }

      plan.stats.newEntries++;
      // A second URL for a channel this source already supplied = the provider
      // moved the stream, not a new channel.
      if (group.storedPresent.length > 0 || group.storedMissing.length > 0) {
        plan.stats.updatedUrls++;
      }

      // A URL that was seen before and has come back refreshes its existing row
      // — inserting a second one would collide with the (sourceId, url) index.
      const returning = group.storedMissing.find((e) => e.canonicalUrl === entry.canonicalUrl);
      if (returning) {
        plan.entryPatches.push({
          _id: returning._id,
          patch: {
            status: "present",
            name: entry.name,
            url: entry.url,
            lastSeenAt: now,
            lastMissingAt: null,
            ...(probe ? { lastProbe: toProbeDetail(probe) } : {}),
          },
        });
      } else {
        plan.entriesToCreate.push({
          channelKey: group.channelKey,
          name: entry.name,
          url: entry.url,
          canonicalUrl: entry.canonicalUrl,
          firstSeenAt: now,
          lastSeenAt: now,
          lastProbe: probe ? toProbeDetail(probe) : undefined,
        });
      }
    }

    // Fresh probe results on URLs we already knew about: update the link health.
    for (const entry of group.storedPresent) {
      const probe = probes.get(entry.canonicalUrl);
      if (!probe) continue;
      const link = linkByUrl.get(entry.canonicalUrl);
      if (link) {
        // An admin-disabled link keeps whatever the admin left on it. A passing
        // playlist probe must not quietly put a deliberately retired server back
        // into the ladder.
        if (!link.adminDisabled) {
          const decision = decideStreamHealth(
            link.status,
            link.failedAttempts || 0,
            link.firstFailedAt,
            probe,
            now,
            link.lastCountedFailureDay
          );
          const revived = link.status !== "active" && decision.status === "active";
          if (revived) plan.stats.linksRevived++;
          plan.linkPatches.push({ _id: link._id, patch: { ...decision } });
        }
      }
      plan.entryPatches.push({ _id: entry._id, patch: { lastProbe: toProbeDetail(probe), lastSeenAt: now } });
    }

    // Vanished URLs: mark the entry, and retire its link only under Case B.
    for (const entry of group.vanishedEntries) {
      plan.stats.entriesRemoved++;
      plan.entryPatches.push({
        _id: entry._id,
        patch: { status: "missing", lastMissingAt: now },
      });
    }

    if (!pinned) continue;

    for (const entry of group.vanishedEntries) {
      const link = linkByUrl.get(entry.canonicalUrl);
      if (!link) continue;
      // Only links this source provided are retirement candidates: a link the
      // admin added by hand, or one another playlist owns, is never touched here.
      if (!group.sourceLinkIds.includes(link._id)) continue;
      if (link.manual || link.adminDisabled) continue;
      if (desiredUrls.has(link.canonicalUrl)) continue;
      const probe = probes.get(link.canonicalUrl);
      const dead = probe ? !(probe.ok || probe.status === "DEGRADED") : link.status === "broken";
      // Case B needs proof that a working URL replaced this one. No probe result
      // for the incoming URL means no evidence, which means nothing is deleted.
      const replaced = group.newEntries.some((n) => {
        const newProbe = probes.get(n.canonicalUrl);
        return Boolean(newProbe && (newProbe.ok || newProbe.status === "DEGRADED"));
      });
      if (dead && replaced) {
        plan.linksToDelete.push(link._id);
        plan.stats.linksRetired++;
      }
    }
  }

  return plan;
}

/**
 * Stats the dashboard shows per source, derived from the summary the last run
 * stored. Kept in one place so the API and the UI agree on the wording.
 */
export function describeSyncStats(stats: PlaylistSyncPlan["stats"]): string {
  const parts: string[] = [];
  if (stats.updatedUrls) parts.push(`${stats.updatedUrls} updated URL(s)`);
  if (stats.linksAddedActive) parts.push(`${stats.linksAddedActive} working link(s)`);
  if (stats.linksAddedBroken) parts.push(`${stats.linksAddedBroken} unverified link(s)`);
  if (stats.entriesRemoved) parts.push(`${stats.entriesRemoved} unavailable`);
  if (stats.linksRetired) parts.push(`${stats.linksRetired} retired`);
  if (stats.linksRevived) parts.push(`${stats.linksRevived} recovered`);
  return parts.length ? parts.join(" · ") : "No changes";
}
