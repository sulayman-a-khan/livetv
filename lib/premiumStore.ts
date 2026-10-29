/**
 * The storing half of the premium tier: every read and write of a premium channel
 * or a fixture goes through here, and each read answers from MongoDB when it is
 * reachable and from the tier's own local store file when it is not, so the admin
 * panel behaves identically on a developer machine and in production. A write is
 * held to a stricter rule than a read — see `requirePersistingStore`.
 *
 * Nothing in this file is read by the Direct HLS catalogue, its ranking pass or its
 * maintenance sweep — those keep their own collections and their own local store
 * (`lib/inMemoryStore.ts`), and this tier never imports them.
 */

import mongoose from "mongoose";
import { connectToDatabase, mustUseDatabase } from "./db";
import {
  premiumLocalStore,
  type LocalFixture,
  type LocalPremiumChannel,
} from "./premiumLocalStore";
import FixtureModel from "@/models/Fixture";
import PremiumChannelModel from "@/models/PremiumChannel";
import {
  FIXTURE_SOURCE_TYPES,
  fixturePhase,
  type FixtureChannelRef,
  type FixtureInput,
  type FixtureSourceType,
  type PremiumChannelInput,
} from "./premiumFixtures";

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
  /**
   * The provider account this channel plays from, and the streams it plays and falls back to.
   *
   * The box holds the credential; this row holds the handle and the ids, which is what the
   * edit form has to show and nothing a viewer could play.
   */
  providerId: string;
  streamId: string;
  backupStreamIds: string[];
  active: boolean;
  sortOrder: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the public match board is allowed to know about a premium channel: its name, its place,
 * whether the admin switched it on, and whether it has a handle on the stream box.
 *
 * There is no `sourceUrl` and no `headers` here, so a card cannot be handed a source line even by
 * spreading a row — the shape the projection reads simply does not have one.
 */
export interface PremiumBoardChannel {
  _id: string;
  name: string;
  category: string;
  logoUrl: string;
  active: boolean;
  proxyChannelKey: string;
}

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

/**
 * Refuse a premium write that has nowhere to persist.
 *
 * This tier's local store is developer data: on a deployment there is no
 * `data/premium-store.json` to fall back to, and the filesystem cannot be written
 * to, so an accepted create would be answered with a fresh id and then lost when
 * the lambda cooled down — the panel would show a row that no viewer's request can
 * ever read back, and an accepted delete would report a row gone that is still on
 * air. Off a deployment the same fallback is the entire point of running locally,
 * so only a deployment is required to have a database (see `mustUseDatabase`).
 *
 * Reads are deliberately not guarded: a list that answers from an empty local tier
 * advertises nothing, and the admin routes already report which store they read
 * from (`dbMode`). A 503 there would turn a database blip into a blank panel with
 * less evidence, not more.
 *
 * The thrown `status` is what every one of these routes' own `fail()` already maps
 * into its response, so the refusal arrives as a 503 carrying this sentence.
 *
 * Exported because `lib/fixtureSources.ts` answers the same question about a channel list the
 * writes consult before they accept a reference, and must refuse for the same reason.
 */
export function requirePersistingStore(
  conn: typeof mongoose | null,
  action: string
): void {
  if (conn || !mustUseDatabase()) return;
  throw Object.assign(new Error(`Database unavailable — ${action}`), { status: 503 });
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
  providerId?: string;
  streamId?: string;
  backupStreamIds?: string[];
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
    providerId: row.providerId || "",
    streamId: row.streamId || "",
    backupStreamIds: readBackupStreamIds(row.backupStreamIds),
    active: row.active !== false,
    sortOrder: typeof row.sortOrder === "number" ? row.sortOrder : 99,
    note: row.note || "",
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : "",
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : "",
  };
}

/**
 * The failover order a row was stored with.
 *
 * The order is the whole point of the list, so a stored list that names the same stream twice
 * or holds something that is not a stream id is not repaired here: it is read as it was
 * written, and the validation on the way in is where such a list is refused.
 */
function readBackupStreamIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const value = entry.trim();
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
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
 * A stored row — in either shape — as the rest of the tier reads it.
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
 * The six fields a public match card may say about a premium channel, for the ids it names.
 *
 * Narrower than `listPremiumChannels` on purpose, and for two reasons that are the same reason: the
 * board needs the name, the switch and the handle to decide what a card may offer, and everything it
 * does not need — the note, the timestamps, the legacy source line and its headers — is one more
 * thing a projection could accidentally repeat. Asking by id also keeps the read proportional to
 * what a board references rather than to how many channels the admin has ever created.
 */
export async function listPremiumBoardChannels(
  ids: string[]
): Promise<PremiumBoardChannel[]> {
  if (ids.length === 0) return [];
  const conn = await connectToDatabase();
  if (conn) {
    const objectIds = ids.filter((id) => mongoose.isValidObjectId(id));
    if (objectIds.length === 0) return [];
    const rows = await PremiumChannelModel.find({ _id: { $in: objectIds } })
      .select("_id name category logoUrl active proxyChannelKey")
      .lean();
    return rows.map(toPremiumBoardChannel);
  }
  const wanted = new Set(ids);
  return premiumLocalStore
    .listChannels()
    .filter((channel) => wanted.has(channel._id))
    .map(toPremiumBoardChannel);
}

/**
 * A read that came back empty because nothing could be read at all is not a board with no
 * channels on it. Reads deliberately stay unguarded (a homepage must not turn into a 500 page
 * because a lookup was slow), so a deployment whose database is unreachable shows no premium
 * offer — which is the safe direction: a card never links a stream on optimism.
 */
function toPremiumBoardChannel(row: {
  _id: unknown;
  name?: string;
  category?: string;
  logoUrl?: string;
  active?: boolean;
  proxyChannelKey?: string;
}): PremiumBoardChannel {
  return {
    _id: String(row._id),
    name: row.name || "",
    category: row.category || "Premium",
    logoUrl: row.logoUrl || "",
    active: row.active !== false,
    proxyChannelKey: row.proxyChannelKey || "",
  };
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
  requirePersistingStore(conn, "nothing was saved");
  if (conn) {
    const created = await PremiumChannelModel.create({
      name: input.name,
      category: input.category,
      logoUrl: input.logoUrl,
      proxyChannelKey: input.proxyChannelKey,
      providerId: input.providerId ?? "",
      streamId: input.streamId ?? "",
      backupStreamIds: input.backupStreamIds ?? [],
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
    providerId: input.providerId ?? "",
    streamId: input.streamId ?? "",
    backupStreamIds: input.backupStreamIds ?? [],
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
  requirePersistingStore(conn, "nothing was saved");
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
  requirePersistingStore(conn, "nothing was saved");
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

/**
 * Take a deleted channel off every card that named it.
 *
 * The match itself survives — only the admin decides a match is gone — but the link does not: a
 * reference to a channel that no longer exists is a dead end for the public board and for the
 * editor, and it is the one dangling id this tier is able to repair on its own. A channel that
 * comes back under its own id is on the card again with no repair step in between.
 *
 * A direct reference is never touched: the catalogue is not this tier's to edit.
 *
 * One board, one write per card that named the channel. Cards are few and a delete is an admin
 * action, so a single list is cheaper than a query per card.
 */
async function clearFixtureLinks(channelId: string): Promise<void> {
  const fixtures = await listFixtures();
  for (const fixture of fixtures) {
    const kept = fixture.channels.filter(
      (ref) => !(ref.sourceType === "secured" && ref.channelId === channelId)
    );
    if (kept.length === fixture.channels.length) continue;
    await updateFixture(fixture._id, { channels: kept });
  }
}

/**
 * Remove a channel and every link to it.
 *
 * The row goes first, then the links that named it, so a card is never left pointing at a
 * channel this store has already forgotten.
 */
export async function deletePremiumChannel(id: string): Promise<boolean> {
  const conn = await connectToDatabase();
  requirePersistingStore(conn, "nothing was deleted");
  let removed: boolean;
  if (conn) {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await PremiumChannelModel.deleteOne({ _id: id });
    removed = result.deletedCount > 0;
  } else {
    removed = premiumLocalStore.deleteChannel(id);
  }
  if (!removed) return false;
  await clearFixtureLinks(id);
  return true;
}

/** Soonest kickoff first, so the board reads like the schedule it is. */
function byKickoff(a: FixtureRecord, b: FixtureRecord): number {
  return a.startsAt.localeCompare(b.startsAt);
}

/**
 * Which of these ids name a premium channel this store actually has.
 *
 * One pass for a whole list rather than a query per entry, because a fixture write checks every
 * channel on the card. Guarded like a write even though it reads: it is reached only from the two
 * fixture writes, and "channel is not in the premium list" is a wrong diagnosis when the truth is
 * that nothing could be read at all.
 */
export async function existingPremiumChannelIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const conn = await connectToDatabase();
  requirePersistingStore(conn, "the premium list could not be checked");
  if (conn) {
    const objectIds = ids.filter((id) => mongoose.isValidObjectId(id));
    if (objectIds.length === 0) return new Set();
    const found = await PremiumChannelModel.find({ _id: { $in: objectIds } })
      .select("_id")
      .lean();
    return new Set(found.map((row) => String(row._id)));
  }
  const present = new Set(premiumLocalStore.listChannels().map((channel) => channel._id));
  return new Set(ids.filter((id) => present.has(id)));
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

/**
 * One card by id, projected. Returns null when no card carries that id.
 *
 * A read, and unguarded like the other reads: a card that cannot be found is a card that is not
 * there, which is a fact the editor can act on.
 */
export async function getFixture(id: string): Promise<FixtureRecord | null> {
  const now = new Date();
  const conn = await connectToDatabase();
  if (conn) {
    if (!mongoose.isValidObjectId(id)) return null;
    const row = await FixtureModel.findById(id).lean();
    return row ? toFixtureRecord(row, now) : null;
  }
  const local = premiumLocalStore.getFixture(id);
  return local ? toFixtureRecord(local, now) : null;
}

export async function createFixture(input: FixtureInput): Promise<FixtureRecord> {
  const now = new Date();
  const conn = await connectToDatabase();
  requirePersistingStore(conn, "nothing was saved");
  if (conn) {
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
      visible: input.visible,
    });
    return toFixtureRecord(created.toObject(), now);
  }

  const record: LocalFixture = {
    _id: `fx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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
    premiumChannelId: null,
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
  // A row whose list was just edited owns that list: the single-column link it may still carry
  // is cleared in the same write, or re-reading it would put a channel back on the card the
  // admin just took off.
  const stored = patch.channels ? { ...patch, premiumChannelId: null } : patch;
  const conn = await connectToDatabase();
  requirePersistingStore(conn, "nothing was saved");
  if (conn) {
    if (!mongoose.isValidObjectId(id)) return null;
    const updated = await FixtureModel.findByIdAndUpdate(id, stored, { new: true }).lean();
    return updated ? toFixtureRecord(updated, now) : null;
  }
  const updated = premiumLocalStore.updateFixture(id, stored);
  return updated ? toFixtureRecord(updated, now) : null;
}

export async function deleteFixture(id: string): Promise<boolean> {
  const conn = await connectToDatabase();
  requirePersistingStore(conn, "nothing was deleted");
  if (conn) {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await FixtureModel.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }
  return premiumLocalStore.deleteFixture(id);
}
