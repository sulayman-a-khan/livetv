/**
 * The read-only door between a fixture card and the channels it can name.
 *
 * A fixture may now point at a channel from either tier, and the Direct HLS catalogue is a
 * protected existing system, so this module is the only place the premium tier looks at it —
 * and it only ever looks. It selects ids, names and logos, and calls no write method on the
 * catalogue's model or its local store; a fixture edit can therefore never change a direct
 * channel, its links, its health bookkeeping or its pin state.
 *
 * An id alone is not enough to know where to look, which is why every reference carries the
 * tier it came from (`sourceType` in `lib/premiumFixtures.ts`) rather than being searched for
 * in both lists.
 */

import mongoose from "mongoose";
import Channel from "@/models/Channel";
import { connectToDatabase } from "./db";
import { inMemoryDb } from "./inMemoryStore";
import { existingPremiumChannelIds, requirePersistingStore } from "./premiumStore";
import type { FixtureChannelRef, FixtureSourceType } from "./premiumFixtures";

/** One channel an admin may link a match to, as the editor shows it. */
export interface FixtureSourceOption {
  channelId: string;
  sourceType: FixtureSourceType;
  name: string;
  category: string;
  logoUrl: string;
}

/**
 * The direct channels a card may offer.
 *
 * Pinned-only, because that is the rule the public catalogue itself obeys: an unpinned channel
 * exists in the database and in the admin dashboard, and a homepage card that linked one would
 * advertise a channel the app deliberately keeps off screen.
 */
export async function listDirectChannelOptions(): Promise<FixtureSourceOption[]> {
  const conn = await connectToDatabase();
  if (conn) {
    const rows = await Channel.find({ isPinned: true })
      .select("_id name logo category")
      .sort({ priorityOrder: 1, name: 1 })
      .lean();
    return rows.map((row) => ({
      channelId: String(row._id),
      sourceType: "direct" as const,
      name: row.name || "",
      category: typeof row.category === "string" ? row.category : "Sports",
      logoUrl: row.logo || "",
    }));
  }
  return inMemoryDb
    .getChannels()
    .filter((channel) => channel.isPinned)
    .sort((a, b) => a.priorityOrder - b.priorityOrder || a.name.localeCompare(b.name))
    .map((channel) => ({
      channelId: channel._id,
      sourceType: "direct" as const,
      name: channel.name,
      category: channel.category,
      logoUrl: channel.logo,
    }));
}

/**
 * Which of these ids name a direct channel that is still on the public catalogue.
 *
 * A deleted or unpinned channel is absent from the returned set rather than guessed about: a
 * card that points at one has nothing to offer, and Phase 3's job is to say so rather than to
 * drop the match. Nothing here needs the stream box, so a secured outage cannot affect it.
 */
export async function existingDirectChannelIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const conn = await connectToDatabase();
  // Guarded like a write, for the same reason the premium check is: this answers a fixture
  // write, and "channel is not in the catalogue" is the wrong sentence when the truth is that
  // nothing could be read at all.
  requirePersistingStore(conn, "the channel catalogue could not be checked");
  if (conn) {
    const objectIds = ids.filter((id) => mongoose.isValidObjectId(id));
    if (objectIds.length === 0) return new Set();
    const found = await Channel.find({ _id: { $in: objectIds }, isPinned: true })
      .select("_id")
      .lean();
    return new Set(found.map((row) => String(row._id)));
  }
  const present = new Set(inMemoryDb.getChannels().filter((c) => c.isPinned).map((c) => c._id));
  return new Set(ids.filter((id) => present.has(id)));
}

/**
 * One sentence per refused reference, in the order they arrived.
 *
 * Shared because both fixture writes answer the same way, and an admin who sent two bad links
 * should read both mistakes in one message rather than one per round-trip.
 */
export function describeUnknownFixtureRefs(
  unknown: { ref: FixtureChannelRef; reason: string }[]
): string {
  return unknown.map(({ ref, reason }) => `Linked channel ${ref.channelId} ${reason}.`).join(" ");
}

/**
 * The references a write cannot be accepted for: each one asks its own tier, in one query for
 * that tier, and the answer is the reference rather than an index, so the caller can name the
 * channel that is missing.
 */
export async function unknownFixtureRefs(
  refs: FixtureChannelRef[]
): Promise<{ ref: FixtureChannelRef; reason: string }[]> {
  if (refs.length === 0) return [];
  const direct = refs.filter((ref) => ref.sourceType === "direct").map((ref) => ref.channelId);
  const secured = refs.filter((ref) => ref.sourceType === "secured").map((ref) => ref.channelId);
  const [knownDirect, knownSecured] = await Promise.all([
    existingDirectChannelIds(direct),
    existingPremiumChannelIds(secured),
  ]);

  const unknown: { ref: FixtureChannelRef; reason: string }[] = [];
  for (const ref of refs) {
    if (ref.sourceType === "direct" && !knownDirect.has(ref.channelId)) {
      unknown.push({ ref, reason: "is not a channel on the direct catalogue" });
    } else if (ref.sourceType === "secured" && !knownSecured.has(ref.channelId)) {
      unknown.push({ ref, reason: "is not a channel in the secured list" });
    }
  }
  return unknown;
}
