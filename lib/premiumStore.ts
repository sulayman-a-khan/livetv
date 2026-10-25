/**
 * The storing half of the premium tier: every read and write of a premium channel
 * or a fixture goes through here, and each function answers from MongoDB when it
 * is reachable and from the tier's own local store file when it is not, so the
 * admin panel behaves identically on a developer machine and in production.
 *
 * Nothing in this file is read by the Direct HLS catalogue, its ranking pass or its
 * maintenance sweep — those keep their own collections and their own local store
 * (`lib/inMemoryStore.ts`), and this tier never imports them.
 */

import mongoose from "mongoose";
import { connectToDatabase } from "./db";
import {
  premiumLocalStore,
  type LocalFixture,
  type LocalPremiumChannel,
} from "./premiumLocalStore";
import FixtureModel from "@/models/Fixture";
import PremiumChannelModel from "@/models/PremiumChannel";
import { fixturePhase, type FixtureInput, type PremiumChannelInput } from "./premiumFixtures";

export interface PremiumChannelRecord {
  _id: string;
  name: string;
  category: string;
  logoUrl: string;
  /**
   * Legacy, admin-only, and never read for playback: new rows carry an empty one and the
   * stream itself lives in the box's vault under `proxyChannelKey`.
   */
  sourceUrl: string;
  headers: { userAgent: string; referer: string };
  /** The handle this channel's source is registered under on the proxy box, or "". */
  proxyChannelKey: string;
  /** When a source was last pushed to the box, so a panel run leaves visible evidence. */
  proxyPushedAt: string | null;
  active: boolean;
  sortOrder: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface FixtureRecord {
  _id: string;
  sport: "football" | "cricket";
  teamA: string;
  teamB: string;
  teamALogo: string;
  teamBLogo: string;
  competition: string;
  startsAt: string;
  durationMinutes: number;
  premiumChannelId: string | null;
  visible: boolean;
  /** Derived from the kickoff clock, so the admin sees the badge a card would show. */
  phase: "upcoming" | "live" | "finished";
  createdAt: string;
  updatedAt: string;
}

/** Rail order: the admin's own numbering first, then the name. */
function bySortOrder(a: PremiumChannelRecord, b: PremiumChannelRecord): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

function toPremiumRecord(row: {
  _id: unknown;
  name?: string;
  category?: string;
  logoUrl?: string;
  sourceUrl?: string;
  headers?: { userAgent?: string; referer?: string };
  proxyChannelKey?: string;
  proxyPushedAt?: Date | null;
  active?: boolean;
  sortOrder?: number;
  note?: string;
  createdAt?: Date;
  updatedAt?: Date;
}): PremiumChannelRecord {
  return {
    _id: String(row._id),
    name: row.name || "",
    category: row.category || "Premium",
    logoUrl: row.logoUrl || "",
    sourceUrl: row.sourceUrl || "",
    headers: { userAgent: row.headers?.userAgent || "", referer: row.headers?.referer || "" },
    proxyChannelKey: row.proxyChannelKey || "",
    proxyPushedAt: row.proxyPushedAt ? new Date(row.proxyPushedAt).toISOString() : null,
    active: row.active !== false,
    sortOrder: typeof row.sortOrder === "number" ? row.sortOrder : 99,
    note: row.note || "",
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : "",
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : "",
  };
}

function toFixtureRecord(
  row: {
    _id: unknown;
    sport?: string;
    teamA?: string;
    teamB?: string;
    teamALogo?: string;
    teamBLogo?: string;
    competition?: string;
    startsAt?: Date;
    durationMinutes?: number;
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
    sport: row.sport === "cricket" ? "cricket" : "football",
    teamA: row.teamA || "",
    teamB: row.teamB || "",
    teamALogo: row.teamALogo || "",
    teamBLogo: row.teamBLogo || "",
    competition: row.competition || "",
    startsAt: startsAt.toISOString(),
    durationMinutes: duration,
    premiumChannelId: row.premiumChannelId ? String(row.premiumChannelId) : null,
    visible: row.visible === true,
    phase: fixturePhase(startsAt, duration, now),
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : "",
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : "",
  };
}

export async function listPremiumChannels(): Promise<PremiumChannelRecord[]> {
  const conn = await connectToDatabase();
  if (conn) {
    const rows = await PremiumChannelModel.find().lean();
    return rows.map(toPremiumRecord).sort(bySortOrder);
  }
  return premiumLocalStore.listChannels().map(toPremiumRecord).sort(bySortOrder);
}

/**
 * Add a row. No source URL is written: a premium channel starts as a name and a place on the
 * rail, and its stream arrives only when the admin pushes a line to the box (`setPremiumProxy`).
 * A row created before this split keeps whatever `sourceUrl` it already had, untouched.
 */
export async function createPremiumChannel(
  input: PremiumChannelInput
): Promise<PremiumChannelRecord> {
  const conn = await connectToDatabase();
  if (conn) {
    const created = await PremiumChannelModel.create({
      name: input.name,
      category: input.category,
      logoUrl: input.logoUrl,
      proxyChannelKey: input.proxyChannelKey,
      active: input.active,
      sortOrder: input.sortOrder,
      note: input.note,
    });
    return toPremiumRecord(created.toObject());
  }

  const now = new Date();
  const record: LocalPremiumChannel = {
    _id: `pc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name,
    category: input.category,
    logoUrl: input.logoUrl,
    sourceUrl: "",
    headers: { userAgent: "", referer: "" },
    proxyChannelKey: input.proxyChannelKey,
    proxyPushedAt: null,
    active: input.active,
    sortOrder: input.sortOrder,
    note: input.note,
    createdAt: now,
    updatedAt: now,
  };
  premiumLocalStore.addChannel(record);
  return toPremiumRecord(record);
}

/**
 * Record what a push to the stream box did. `pushedAt` is this server's clock at the moment the
 * box accepted, so a row can show when its source last travelled; the box does not report one.
 * An empty handle is how a retraction is stored.
 */
export async function setPremiumProxy(
  id: string,
  patch: { proxyChannelKey: string; proxyPushedAt: Date | null }
): Promise<PremiumChannelRecord | null> {
  const conn = await connectToDatabase();
  if (conn) {
    if (!mongoose.isValidObjectId(id)) return null;
    const updated = await PremiumChannelModel.findByIdAndUpdate(id, patch, { new: true }).lean();
    return updated ? toPremiumRecord(updated) : null;
  }
  const updated = premiumLocalStore.updateChannel(id, patch);
  return updated ? toPremiumRecord(updated) : null;
}

/**
 * What a viewer-facing route is allowed to know about one premium channel. This is a separate
 * shape rather than `PremiumChannelRecord` on purpose: the record carries the legacy source
 * line, and a route that is answering a browser must not have that field within reach at all.
 */
export interface PublicPremiumChannel {
  _id: string;
  name: string;
  category: string;
  logoUrl: string;
  active: boolean;
  proxyChannelKey: string;
}

/** One row by id, projected. Returns null when no channel carries that id. */
export async function getPublicPremiumChannel(id: string): Promise<PublicPremiumChannel | null> {
  const conn = await connectToDatabase();
  if (conn) {
    if (!mongoose.isValidObjectId(id)) return null;
    const found = await PremiumChannelModel.findById(id)
      .select("name category logoUrl active proxyChannelKey")
      .lean();
    return found ? toPublicPremium(found) : null;
  }
  const local = premiumLocalStore.getChannel(id);
  return local ? toPublicPremium(local) : null;
}

function toPublicPremium(row: {
  _id: unknown;
  name?: string;
  category?: string;
  logoUrl?: string;
  active?: boolean;
  proxyChannelKey?: string;
}): PublicPremiumChannel {
  return {
    _id: String(row._id),
    name: row.name || "",
    category: row.category || "Premium",
    logoUrl: row.logoUrl || "",
    active: row.active !== false,
    proxyChannelKey: row.proxyChannelKey || "",
  };
}

/** Returns null when no channel carries that id. */
export async function updatePremiumChannel(
  id: string,
  patch: Partial<PremiumChannelInput>
): Promise<PremiumChannelRecord | null> {
  const conn = await connectToDatabase();
  if (conn) {
    // An id shaped like a local store's is not a MongoDB row, and handing it to
    // the driver would throw a cast error instead of answering "not found".
    if (!mongoose.isValidObjectId(id)) return null;
    const updated = await PremiumChannelModel.findByIdAndUpdate(id, patch, { new: true }).lean();
    return updated ? toPremiumRecord(updated) : null;
  }
  const updated = premiumLocalStore.updateChannel(id, patch);
  return updated ? toPremiumRecord(updated) : null;
}

export async function deletePremiumChannel(id: string): Promise<boolean> {
  const conn = await connectToDatabase();
  if (conn) {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await PremiumChannelModel.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }
  return premiumLocalStore.deleteChannel(id);
}

/** Soonest kickoff first, so the board reads like the schedule it is. */
function byKickoff(a: FixtureRecord, b: FixtureRecord): number {
  return a.startsAt.localeCompare(b.startsAt);
}

/**
 * Does a premium channel with this id exist? A fixture may only be tied to a
 * channel the admin has actually entered, or the card would advertise a match
 * nobody can watch.
 */
export async function premiumChannelExists(id: string): Promise<boolean> {
  const conn = await connectToDatabase();
  if (conn) {
    if (!mongoose.isValidObjectId(id)) return false;
    const found = await PremiumChannelModel.findById(id).select("_id").lean();
    return Boolean(found);
  }
  return Boolean(premiumLocalStore.getChannel(id));
}

export async function listFixtures(): Promise<FixtureRecord[]> {
  const now = new Date();
  const conn = await connectToDatabase();
  if (conn) {
    const rows = await FixtureModel.find().lean();
    return rows.map((row) => toFixtureRecord(row, now)).sort(byKickoff);
  }
  return premiumLocalStore.listFixtures().map((row) => toFixtureRecord(row, now)).sort(byKickoff);
}

export async function createFixture(input: FixtureInput): Promise<FixtureRecord> {
  const now = new Date();
  const conn = await connectToDatabase();
  if (conn) {
    const created = await FixtureModel.create({
      sport: input.sport,
      teamA: input.teamA,
      teamB: input.teamB,
      teamALogo: input.teamALogo,
      teamBLogo: input.teamBLogo,
      competition: input.competition,
      startsAt: input.startsAt,
      durationMinutes: input.durationMinutes,
      premiumChannelId: input.premiumChannelId,
      visible: input.visible,
    });
    return toFixtureRecord(created.toObject(), now);
  }

  const record: LocalFixture = {
    _id: `fx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sport: input.sport,
    teamA: input.teamA,
    teamB: input.teamB,
    teamALogo: input.teamALogo,
    teamBLogo: input.teamBLogo,
    competition: input.competition,
    startsAt: input.startsAt,
    durationMinutes: input.durationMinutes,
    premiumChannelId: input.premiumChannelId,
    visible: input.visible,
    createdAt: now,
    updatedAt: now,
  };
  premiumLocalStore.addFixture(record);
  return toFixtureRecord(record, now);
}

export async function updateFixture(
  id: string,
  patch: Partial<FixtureInput>
): Promise<FixtureRecord | null> {
  const now = new Date();
  const conn = await connectToDatabase();
  if (conn) {
    if (!mongoose.isValidObjectId(id)) return null;
    const updated = await FixtureModel.findByIdAndUpdate(id, patch, { new: true }).lean();
    return updated ? toFixtureRecord(updated, now) : null;
  }
  const updated = premiumLocalStore.updateFixture(id, patch);
  return updated ? toFixtureRecord(updated, now) : null;
}

export async function deleteFixture(id: string): Promise<boolean> {
  const conn = await connectToDatabase();
  if (conn) {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await FixtureModel.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }
  return premiumLocalStore.deleteFixture(id);
}
