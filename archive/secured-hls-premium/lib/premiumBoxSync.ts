/**
 * The premium tier's bond with the box: what a row here says, and what the box holds for it.
 *
 * A provider-backed channel is one row in this site and one channel in the box's vault, and
 * the box is where the failover happens — the primary stream, then the first backup, then the
 * second. This module is the only place that writes that channel, so the two can never
 * disagree about which streams a channel plays.
 *
 * Three decisions live here, and each one is a decision rather than a detail:
 *
 *   - **The handle is derived from the row id**, not typed by the admin, so a renamed channel
 *     stays the same channel on the box and a new row is a new channel.
 *   - **Only the fields that changed are written.** A rename must not drop the failover
 *     order, and an edit that mentions nothing must not rewrite anything.
 *   - **A row with no provider is not touched.** A channel whose source was pasted in as a
 *     manifest line belongs to the push route, which owns its box row; the two flows never
 *     write to the same channel.
 */

import { performProxyAction } from "./proxyActions";
import { proxyKeyForRow } from "./premiumProxy";

/** The fields of a box channel that this site is allowed to write. */
export type BoxChannelField =
  | "displayName"
  | "category"
  | "logoUrl"
  | "providerId"
  | "streamId"
  | "backupStreamIds";

/** Every writable field, in the order they are read. */
export const BOX_CHANNEL_FIELDS: BoxChannelField[] = [
  "displayName",
  "category",
  "logoUrl",
  "providerId",
  "streamId",
  "backupStreamIds",
];

/** The shape of a premium row, as far as the box is concerned. */
export interface BoxChannelShape {
  _id: string;
  name: string;
  category: string;
  logoUrl: string;
  providerId: string;
  streamId: string;
  backupStreamIds: string[];
  /**
   * The handle this row is filed under on the box, when it has one.
   *
   * A row that was pushed keeps the handle the push wrote, and a row that was made here has
   * none yet — in which case the handle its own id implies is the one it is filed under.
   */
  proxyChannelKey?: string;
}

/**
 * A premium row, read as the box sees it.
 *
 * The site row carries more than the box does — a note, a place on the rail, timestamps — and
 * none of it belongs on the box, so the row is narrowed to the fields the box holds.
 */
export function boxShapeOf(row: {
  _id: string;
  name: string;
  category: string;
  logoUrl: string;
  providerId: string;
  streamId: string;
  backupStreamIds: string[];
  proxyChannelKey?: string;
}): BoxChannelShape {
  return {
    _id: row._id,
    name: row.name,
    category: row.category,
    logoUrl: row.logoUrl,
    providerId: row.providerId,
    streamId: row.streamId,
    backupStreamIds: row.backupStreamIds,
    proxyChannelKey: row.proxyChannelKey,
  };
}

/**
 * What one write to the box did.
 *
 * A refusal is reported rather than thrown: the caller has a row to keep or roll back, and
 * the box's own reason — "that provider is still in use", "that stream id does not exist" —
 * is what the admin has to read.
 */
export type BoxSyncOutcome =
  | { ok: true; created: boolean }
  | { ok: false; status: number; error: string; code: string | null };

/** The reason an action failed, as the site knows it: its own code and the box's. */
function failureOf(body: Record<string, unknown>): { error: string; code: string | null } {
  const error = typeof body.error === "string" ? body.error : "the stream box refused the change";
  const result = body.result as Record<string, unknown> | undefined;
  const code = typeof result?.code === "string" ? result.code : null;
  return { error, code };
}

/**
 * Write one channel to the box, under the handle its row implies.
 *
 * The row is written first and the box second, so the caller can roll the row back when the
 * box refuses — a row that claims a stream the box does not hold is a row that plays nothing
 * and says otherwise.
 */
export async function syncChannelToBox(
  row: BoxChannelShape,
  fields: BoxChannelField[]
): Promise<BoxSyncOutcome> {
  const channelKey = row.proxyChannelKey || proxyKeyForRow(row._id);
  const wants = new Set(fields);

  // A create carries the whole row: the box has no way to merge into a channel it does not
  // have yet, and a create that named only some of the fields would create a channel that is
  // missing the rest.
  const created = await performProxyAction({
    action: "create_channel",
    target: channelKey,
    displayName: row.name,
    category: row.category,
    logoUrl: row.logoUrl,
    providerId: row.providerId,
    streamId: row.streamId,
    backupStreamIds: row.backupStreamIds,
  });

  if (created.status === 200) return { ok: true, created: true };

  // The box already has this handle — the channel was created before, and this write is an
  // edit. The box says so with a conflict, and the answer is to change only what changed.
  const conflict =
    created.status === 409 || (created.body.result as Record<string, unknown> | undefined)?.code === "channel_exists";
  if (!conflict) {
    const { error, code } = failureOf(created.body);
    return { ok: false, status: created.status, error, code };
  }
  if (wants.size === 0) return { ok: true, created: false };

  const patch: Record<string, unknown> = {};
  if (wants.has("displayName")) patch.displayName = row.name;
  if (wants.has("category")) patch.category = row.category;
  if (wants.has("logoUrl")) patch.logoUrl = row.logoUrl;
  if (wants.has("providerId")) patch.providerId = row.providerId;
  if (wants.has("streamId")) patch.streamId = row.streamId;
  if (wants.has("backupStreamIds")) patch.backupStreamIds = row.backupStreamIds;

  const updated = await performProxyAction({
    action: "update_channel",
    target: channelKey,
    ...patch,
  });
  if (updated.status === 200) return { ok: true, created: false };

  const { error, code } = failureOf(updated.body);
  return { ok: false, status: updated.status, error, code };
}

/**
 * Which fields of a box channel a change actually touched.
 *
 * The comparison is on the values, not on which keys the request carried: an admin who
 * opened the form and pressed save without changing the stream ids has changed nothing
 * about the failover, and the box must not be told otherwise.
 */
export function changedBoxFields(
  before: BoxChannelShape,
  after: BoxChannelShape
): BoxChannelField[] {
  const changed: BoxChannelField[] = [];
  if (before.name !== after.name) changed.push("displayName");
  if (before.category !== after.category) changed.push("category");
  if (before.logoUrl !== after.logoUrl) changed.push("logoUrl");
  if (before.providerId !== after.providerId) changed.push("providerId");
  if (before.streamId !== after.streamId) changed.push("streamId");
  if (
    before.backupStreamIds.length !== after.backupStreamIds.length ||
    before.backupStreamIds.some((id, at) => id !== after.backupStreamIds[at])
  ) {
    changed.push("backupStreamIds");
  }
  return changed;
}

/**
 * The row, put back the way it was.
 *
 * A box write that was refused must not leave a row claiming a stream the box does not
 * hold, so the fields the write was about are written back with the values they had. Only
 * those fields are named: a rollback that rewrote the whole row would undo whatever else
 * changed in the meantime.
 */
export function rollbackPatch(
  before: BoxChannelShape,
  fields: BoxChannelField[]
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (fields.includes("displayName")) patch.name = before.name;
  if (fields.includes("category")) patch.category = before.category;
  if (fields.includes("logoUrl")) patch.logoUrl = before.logoUrl;
  if (fields.includes("providerId")) patch.providerId = before.providerId;
  if (fields.includes("streamId")) patch.streamId = before.streamId;
  if (fields.includes("backupStreamIds")) patch.backupStreamIds = before.backupStreamIds;
  return patch;
}
