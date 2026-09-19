/**
 * SoluPlay — Maintenance Runner (storage adapters)
 * ==============================================
 * Applies a `MaintenancePlan` to whichever backend is active. The rules live in
 * `channelMaintenance.ts`; this file only knows how to persist them.
 *
 * Called from:
 *   - M3U ingest              (after a playlist import)
 *   - Auto health checker     (after fresh latencies are measured)
 *   - Admin maintenance route (manual "Run cleanup" button)
 *   - Manual link add/delete  (single-channel refresh)
 */

import { connectToDatabase } from "./db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb, type InMemoryChannel } from "./inMemoryStore";
import {
  MaintChannel,
  MaintStream,
  MaintenancePlan,
  planChannelLinkRefresh,
  planMaintenance,
} from "./channelMaintenance";

export type MaintenanceReport = MaintenancePlan["stats"] & {
  mode: "mongodb" | "in-memory";
  channelsBefore: number;
  channelsAfter: number;
  streamsBefore: number;
  streamsAfter: number;
};

/* ------------------------------------------------------------------ *
 * In-memory adapter
 * ------------------------------------------------------------------ */

/**
 * Application order matters and is identical in both adapters:
 *   1. re-home + renumber links   (so nothing is stranded by a channel delete)
 *   2. delete duplicate channels  (frees their canonical name)
 *   3. patch the survivor         (its new normalizedName would otherwise
 *                                  collide with the duplicate's unique index)
 *   4. delete dead links
 */
function applyPlanInMemory(plan: MaintenancePlan) {
  const streams = inMemoryDb.getStreams();

  for (const patch of plan.streamPatches) {
    const s = streams.find((x) => x._id === patch._id);
    if (s) {
      s.channelId = patch.channelId;
      s.priority = patch.priority;
      s.updatedAt = new Date();
    }
  }

  // Duplicate channel records only — their links were reassigned above, so this
  // deliberately uses the delete that leaves stream links alone.
  for (const channelId of plan.channelsToDelete) {
    inMemoryDb.deleteChannelRecordOnly(channelId);
  }

  for (const patch of plan.channelPatches) {
    inMemoryDb.updateChannel(patch._id, patch.patch as Partial<InMemoryChannel>);
  }

  for (const streamId of plan.streamsToDelete) {
    inMemoryDb.deleteStream(streamId);
  }

  inMemoryDb.saveState();
}

/* ------------------------------------------------------------------ *
 * MongoDB adapter
 * ------------------------------------------------------------------ */

async function applyPlanMongo(plan: MaintenancePlan) {
  for (const patch of plan.streamPatches) {
    await StreamLink.findByIdAndUpdate(patch._id, {
      channelId: patch.channelId,
      priority: patch.priority,
    });
  }

  // Duplicates go first: `normalizedName` is a unique index, so the survivor
  // cannot take the canonical name while a duplicate still holds it.
  if (plan.channelsToDelete.length > 0) {
    await Channel.deleteMany({ _id: { $in: plan.channelsToDelete } });
  }

  for (const patch of plan.channelPatches) {
    await Channel.findByIdAndUpdate(patch._id, patch.patch);
  }

  if (plan.streamsToDelete.length > 0) {
    await StreamLink.deleteMany({ _id: { $in: plan.streamsToDelete } });
  }
}

/* ------------------------------------------------------------------ *
 * Public entry points
 * ------------------------------------------------------------------ */

/**
 * Full catalogue pass: normalize names, merge duplicates, purge test links and
 * renumber every channel's servers fastest-first. Safe to run repeatedly.
 */
export async function runMaintenance(): Promise<MaintenanceReport> {
  const conn = await connectToDatabase();

  if (conn) {
    const channelDocs = await Channel.find().lean();
    const streamDocs = await StreamLink.find().lean();

    const channels: MaintChannel[] = channelDocs.map((c) => ({
      ...c,
      _id: String(c._id),
    })) as unknown as MaintChannel[];
    const streams: MaintStream[] = streamDocs.map((s) => ({
      ...s,
      _id: String(s._id),
      channelId: String(s.channelId),
    })) as unknown as MaintStream[];

    const plan = planMaintenance(channels, streams);
    await applyPlanMongo(plan);

    return {
      ...plan.stats,
      mode: "mongodb",
      channelsBefore: channels.length,
      channelsAfter: channels.length - plan.channelsToDelete.length,
      streamsBefore: streams.length,
      streamsAfter: streams.length - plan.streamsToDelete.length,
    };
  }

  const channels = inMemoryDb.getChannels() as unknown as MaintChannel[];
  const streams = inMemoryDb.getStreams() as unknown as MaintStream[];
  const plan = planMaintenance(channels, streams);
  applyPlanInMemory(plan);

  return {
    ...plan.stats,
    mode: "in-memory",
    channelsBefore: channels.length,
    channelsAfter: channels.length - plan.channelsToDelete.length,
    streamsBefore: streams.length,
    streamsAfter: streams.length - plan.streamsToDelete.length,
  };
}

/**
 * Cheap single-channel pass used after adding or deleting one server link:
 * purges now-redundant test links and re-sorts so Server 1 is still the fastest.
 */
export async function refreshChannelLinks(channelId: string): Promise<void> {
  const conn = await connectToDatabase();

  if (conn) {
    const streamDocs = await StreamLink.find({ channelId }).lean();
    const streams: MaintStream[] = streamDocs.map((s) => ({
      ...s,
      _id: String(s._id),
      channelId: String(s.channelId),
    })) as unknown as MaintStream[];

    const { streamPatches, streamsToDelete } = planChannelLinkRefresh(channelId, streams);
    for (const p of streamPatches) {
      await StreamLink.findByIdAndUpdate(p._id, { priority: p.priority });
    }
    if (streamsToDelete.length > 0) {
      await StreamLink.deleteMany({ _id: { $in: streamsToDelete } });
    }
    return;
  }

  const streams = inMemoryDb.getStreams() as unknown as MaintStream[];
  const { streamPatches, streamsToDelete } = planChannelLinkRefresh(channelId, streams);

  const live = inMemoryDb.getStreams();
  for (const p of streamPatches) {
    const s = live.find((x) => x._id === p._id);
    if (s) {
      s.priority = p.priority;
      s.updatedAt = new Date();
    }
  }
  for (const id of streamsToDelete) {
    inMemoryDb.deleteStream(id);
  }
  inMemoryDb.saveState();
}
