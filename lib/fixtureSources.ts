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
import { existingPremiumChannelIds, listFixtures, requirePersistingStore } from "./premiumStore";
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
 * A catalogue row the public board was asked to resolve.
 *
 * Five fields, all of them names: no stream url, no probe bookkeeping, no link count. A board read
 * that asked for more than it projects would be a wider door than the card needs.
 */
export interface BoardDirectRow {
  _id: string;
  name: string;
  category: string;
  logoUrl: string;
  /** Whether the catalogue is showing this channel publicly (`isPinned`). */
  listed: boolean;
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
 * Which of these ids name a direct channel at all, and which of those the public catalogue is
 * currently showing.
 *
 * One read for the whole batch, keyed by the ids a board actually names: a card with eight links
 * costs the same query as a card with one, and a board of a hundred cards still costs one. That is
 * deliberate — the stale-reference case is common enough (a channel deleted after a match was
 * entered) that answering it per reference would be a request amplifier wearing a helpful name.
 *
 * Two answers come back, because they are two different facts and the card explains them
 * differently: an id that is absent named no channel and is a stale link, and an id that is present
 * with `listed: false` is a real channel the app has deliberately taken off screen — which the
 * board may name, but must not link.
 */
export async function listDirectChannelsByIds(ids: string[]): Promise<BoardDirectRow[]> {
  if (ids.length === 0) return [];
  const conn = await connectToDatabase();
  // Guarded like a write, for the same reason the premium check is: this answers both a fixture
  // write and the public board, and "that channel does not exist" is the wrong sentence when the
  // truth is that nothing could be read at all.
  requirePersistingStore(conn, "the channel catalogue could not be checked");
  if (conn) {
    // Only spellable ids are asked for: a catalogue row is keyed by an ObjectId, so anything else
    // already has its answer, and sending it would only throw a CastError.
    const objectIds = ids.filter((id) => mongoose.isValidObjectId(id));
    if (objectIds.length === 0) return [];
    const found = await Channel.find({ _id: { $in: objectIds } })
      .select("_id name logo category isPinned")
      .lean();
    return found.map((row) => ({
      _id: String(row._id),
      name: row.name || "",
      category: typeof row.category === "string" ? row.category : "Sports",
      logoUrl: row.logo || "",
      listed: row.isPinned === true,
    }));
  }
  const wanted = new Set(ids);
  return inMemoryDb
    .getChannels()
    .filter((channel) => wanted.has(channel._id))
    .map((channel) => ({
      _id: channel._id,
      name: channel.name,
      category: channel.category,
      logoUrl: channel.logo,
      listed: channel.isPinned === true,
    }));
}

/**
 * One reference and the reason it does not name a channel.
 */
export interface FixtureRefFinding {
  ref: FixtureChannelRef;
  reason: string;
}

/**
 * One sentence per refused reference, in the order they arrived.
 *
 * Shared because both fixture writes answer the same way, and an admin who sent two bad links
 * should read both mistakes in one message rather than one per round-trip.
 */
export function describeUnknownFixtureRefs(unknown: FixtureRefFinding[]): string {
  return unknown.map(({ ref, reason }) => `Linked channel ${ref.channelId} ${reason}.`).join(" ");
}

/**
 * The channels of the match card that names a premium channel, in the order the admin set them.
 *
 * The order is the priority the card is watched on — the first channel on it is the one that is
 * tried first, and the ones after it are what a failure moves to — so it is read from the card
 * rather than rebuilt here. Only a published card that has not finished counts: a card nobody
 * can see is not a reason to move a viewer anywhere.
 *
 * A link that names no channel is left out, because a fallback to a channel that is not there is
 * not a fallback.
 */
export async function listCardChannelsFor(channelId: string): Promise<FixtureChannelRef[]> {
  if (!channelId) return [];
  const fixtures = await listFixtures();
  const cards = fixtures.filter(
    (fixture) =>
      fixture.visible &&
      fixture.phase !== "finished" &&
      fixture.channels.some(
        (ref) => ref.sourceType === "secured" && ref.channelId === channelId
      )
  );
  if (cards.length === 0) return [];

  const card = cards[0];
  const { refused } = await checkFixtureRefs(card.channels);
  const gone = new Set(
    refused.map((finding) => `${finding.ref.sourceType}:${finding.ref.channelId}`)
  );
  return card.channels.filter((ref) => !gone.has(`${ref.sourceType}:${ref.channelId}`));
}

/**
 * The references a write cannot be accepted for: each one asks its own tier, in one query for
 * that tier, and the answer is the reference rather than an index, so the caller can name the
 * channel that is missing.
 *
 * The direct half distinguishes the two ways a link can be wrong, because they want different
 * repairs: an id with no row behind it is a reference to a channel that is gone, and a row that
 * exists but is not pinned is a channel the app is deliberately not showing. Saying "not a channel"
 * about the second would send the admin looking for a channel that is in front of them.
 *
 * Every reference that does not resolve is refused here: this is the write that is adding them.
 */
export async function unknownFixtureRefs(refs: FixtureChannelRef[]): Promise<FixtureRefFinding[]> {
  return (await checkFixtureRefs(refs)).refused;
}

/**
 * What a write found when it checked the references it was given.
 *
 * Two lists, because there are two different questions. A reference the admin is adding now has
 * to name a channel, or it is refused. A reference the card already carried and that no longer
 * names one — a channel deleted since, or a direct channel the catalogue has stopped showing —
 * is a stale link, and it is kept rather than refused: refusing it would lock the admin out of
 * the card they are trying to fix, and dropping it would destroy the one thing that lets a link
 * repair itself, which is that a channel that comes back is on the card again with no repair
 * step in between.
 *
 * The two lists come out of the same two queries, so the split costs no extra read.
 */
export async function checkFixtureRefs(
  refs: FixtureChannelRef[],
  carried: FixtureChannelRef[] = []
): Promise<{ refused: FixtureRefFinding[]; stale: FixtureRefFinding[] }> {
  if (refs.length === 0) return { refused: [], stale: [] };
  const direct = refs.filter((ref) => ref.sourceType === "direct").map((ref) => ref.channelId);
  const secured = refs.filter((ref) => ref.sourceType === "secured").map((ref) => ref.channelId);
  const [directRows, knownSecured] = await Promise.all([
    listDirectChannelsByIds(direct),
    existingPremiumChannelIds(secured),
  ]);
  const listedDirect = new Set(directRows.filter((row) => row.listed).map((row) => row._id));
  const existingDirect = new Set(directRows.map((row) => row._id));
  const carriedKeys = new Set(carried.map((ref) => `${ref.sourceType}:${ref.channelId}`));

  const refused: FixtureRefFinding[] = [];
  const stale: FixtureRefFinding[] = [];
  for (const ref of refs) {
    let reason: string | null = null;
    if (ref.sourceType === "direct" && !listedDirect.has(ref.channelId)) {
      reason = existingDirect.has(ref.channelId)
        ? "is not on the public channel list"
        : "is not a channel on the direct catalogue";
    } else if (ref.sourceType === "secured" && !knownSecured.has(ref.channelId)) {
      reason = "is not a channel in the secured list";
    }
    if (!reason) continue;
    const finding: FixtureRefFinding = { ref, reason };
    if (carriedKeys.has(`${ref.sourceType}:${ref.channelId}`)) stale.push(finding);
    else refused.push(finding);
  }
  return { refused, stale };
}
