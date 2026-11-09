/**
 * The storing half of the match board: every read and write of a match card goes
 * through here, and every one of them is answered by MongoDB.
 *
 * There is no local file behind this store. A card is entered by hand and shown on the
 * homepage, so the two have to be the same list — a card that lives in a developer's
 * file and a board that reads the database are two different boards, and the admin
 * would be editing one and publishing the other. So the rows live in one place, and a
 * process that cannot reach it refuses rather than answering with an empty list.
 */

import mongoose from "mongoose";
import { connectToDatabase, requireDatabase } from "./db";
import FixtureModel from "@/models/Fixture";
import {
  fixturePhase,
  FIXTURE_SOURCE_TYPES,
  type FixtureChannelRef,
  type FixtureInput,
  type FixtureSourceType,
} from "./fixtures";

export interface FixtureRecord {
  _id: string;
  /** The card's title, as the admin wrote it. */
  title: string;
  sport: "football" | "cricket";
  teamA: string;
  teamB: string;
  teamALogo: string;
  teamBLogo: string;
  competition: string;
  startsAt: string;
  durationMinutes: number;
  /** Every channel this match can be watched on, each naming the tier it comes from. */
  channels: FixtureChannelRef[];
  /** The admin's own broadcast address for the match, or an empty string. */
  directUrl: string;
  visible: boolean;
  /** Derived from the kickoff clock, so the admin sees the badge a card would show. */
  phase: "upcoming" | "live" | "finished";
  createdAt: string;
  updatedAt: string;
}

/**
 * The channels a stored row says this match can be watched on, in the order it stored them.
 *
 * Two shapes have to read as one answer. A row written after a card could name several
 * channels carries the list; a row written before it carries only `premiumChannelId`, and that
 * field always named a premium row, so it reads as one secured reference instead of being
 * dropped — an existing board keeps showing its matches on the channel the admin chose.
 * An entry that is not an id plus a known source is skipped rather than guessed at.
 */
function readFixtureChannels(row: {
  channels?: unknown;
  premiumChannelId?: string | null;
}): FixtureChannelRef[] {
  const refs: FixtureChannelRef[] = [];
  const stored = Array.isArray(row.channels) ? row.channels : [];
  for (const entry of stored) {
    const record = entry as { channelId?: unknown; sourceType?: unknown };
    const channelId = typeof record?.channelId === "string" ? record.channelId.trim() : "";
    const sourceType =
      typeof record?.sourceType === "string" ? record.sourceType.trim().toLowerCase() : "";
    if (!channelId) continue;
    if (!(FIXTURE_SOURCE_TYPES as readonly string[]).includes(sourceType)) continue;
    const typed = sourceType as FixtureSourceType;
    if (refs.some((ref) => ref.channelId === channelId && ref.sourceType === typed)) continue;
    refs.push({ channelId, sourceType: typed });
  }

  const legacy = typeof row.premiumChannelId === "string" ? row.premiumChannelId.trim() : "";
  if (legacy && !refs.some((ref) => ref.sourceType === "secured" && ref.channelId === legacy)) {
    refs.push({ channelId: legacy, sourceType: "secured" });
  }
  return refs;
}

/**
 * A stored row — in either shape — as the rest of the app reads it.
 */
function toFixtureRecord(
  row: {
    _id: unknown;
    title?: string;
    sport?: string;
    teamA?: string;
    teamB?: string;
    teamALogo?: string;
    teamBLogo?: string;
    competition?: string;
    startsAt?: Date;
    durationMinutes?: number;
    channels?: unknown;
    directUrl?: string;
    premiumChannelId?: string | null;
    visible?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
  },
  now: Date
): FixtureRecord {
  const startsAt = row.startsAt ? new Date(row.startsAt) : now;
  const duration = typeof row.durationMinutes === "number" ? row.durationMinutes : 120;
  return {
    _id: String(row._id),
    title: row.title || "",
    sport: row.sport === "cricket" ? "cricket" : "football",
    teamA: row.teamA || "",
    teamB: row.teamB || "",
    teamALogo: row.teamALogo || "",
    teamBLogo: row.teamBLogo || "",
    competition: row.competition || "",
    startsAt: startsAt.toISOString(),
    durationMinutes: duration,
    channels: readFixtureChannels(row),
    directUrl: row.directUrl || "",
    visible: row.visible === true,
    phase: fixturePhase(startsAt, duration, now),
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : "",
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : "",
  };
}

/** Soonest kickoff first, so the board reads like the schedule it is. */
function byKickoff(a: FixtureRecord, b: FixtureRecord): number {
  return a.startsAt.localeCompare(b.startsAt);
}

export async function listFixtures(): Promise<FixtureRecord[]> {
  const now = new Date();
  const conn = await connectToDatabase();
  requireDatabase(conn, "the match board could not be read");
  const rows = await FixtureModel.find().lean();
  return rows.map((row) => toFixtureRecord(row, now)).sort(byKickoff);
}

/**
 * One card by id, projected. Returns null when no card carries that id.
 *
 * A read, and guarded like the other reads: this store has no local copy, so a card that
 * cannot be found because nothing could be read is not the same answer as a card that is
 * not there.
 */
export async function getFixture(id: string): Promise<FixtureRecord | null> {
  const now = new Date();
  const conn = await connectToDatabase();
  requireDatabase(conn, "the match board could not be read");
  if (!mongoose.isValidObjectId(id)) return null;
  const row = await FixtureModel.findById(id).lean();
  return row ? toFixtureRecord(row, now) : null;
}

export async function createFixture(input: FixtureInput): Promise<FixtureRecord> {
  const now = new Date();
  const conn = await connectToDatabase();
  requireDatabase(conn, "nothing was saved");
  const created = await FixtureModel.create({
    title: input.title ?? "",
    sport: input.sport,
    teamA: input.teamA,
    teamB: input.teamB,
    teamALogo: input.teamALogo,
    teamBLogo: input.teamBLogo,
    competition: input.competition,
    startsAt: input.startsAt,
    durationMinutes: input.durationMinutes,
    channels: input.channels,
    directUrl: input.directUrl ?? "",
    visible: input.visible,
  });
  return toFixtureRecord(created.toObject(), now);
}

export async function updateFixture(
  id: string,
  patch: Partial<FixtureInput>
): Promise<FixtureRecord | null> {
  const now = new Date();
  // A row whose list was just edited owns that list: the single-column link it may still carry
  // is cleared in the same write, or re-reading it would put a channel back on the card the
  // admin just took off.
  const stored = patch.channels ? { ...patch, premiumChannelId: null } : patch;
  const conn = await connectToDatabase();
  requireDatabase(conn, "nothing was saved");
  if (!mongoose.isValidObjectId(id)) return null;
  const updated = await FixtureModel.findByIdAndUpdate(id, stored, { new: true }).lean();
  return updated ? toFixtureRecord(updated, now) : null;
}

export async function deleteFixture(id: string): Promise<boolean> {
  const conn = await connectToDatabase();
  requireDatabase(conn, "nothing was deleted");
  if (!mongoose.isValidObjectId(id)) return false;
  const result = await FixtureModel.deleteOne({ _id: id });
  return result.deletedCount > 0;
}
