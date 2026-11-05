/**
 * The storing half of a saved channel list: every read and write of a list goes
 * through here, and every one of them is answered by MongoDB.
 *
 * There is no local file behind this store, for the same reason the match
 * board has none: the device keeps its own copy and this is the copy that
 * travels between devices, so two stores would be two different lists. A
 * process that cannot reach the database refuses rather than answering with an
 * empty list — an empty list is a real answer, and it would erase the list a
 * viewer has on a second device.
 */

import { connectToDatabase, requireDatabase } from "./db";
import FavouriteListModel from "@/models/FavouriteList";

export interface FavouriteListRecord {
  /** The eight characters the list travels under. */
  key: string;
  /** The channel ids on the list, in the order they were marked. */
  ids: string[];
  /** When the list was last written, as the app reads a clock. */
  updatedAt: string;
}

/** A stored row as the route reads it. */
function toFavouriteListRecord(row: {
  key?: unknown;
  ids?: unknown;
  updatedAt?: Date;
} | null): FavouriteListRecord {
  const ids = Array.isArray(row?.ids)
    ? row.ids.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    key: typeof row?.key === "string" ? row.key : "",
    ids,
    updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : "",
  };
}

/**
 * The list held under a key, or null when the key holds none.
 *
 * A read is guarded like the other reads: a list that could not be read is not
 * the same answer as a list that is empty.
 */
export async function readFavouriteList(key: string): Promise<FavouriteListRecord | null> {
  const conn = await connectToDatabase();
  requireDatabase(conn, "the saved list could not be read");
  const row = await FavouriteListModel.findOne({ key }).lean();
  return row ? toFavouriteListRecord(row) : null;
}

/**
 * Puts a list under a key, replacing whatever was there.
 *
 * The list that is written last is the list that is kept: the app has no
 * account and no way to merge two copies, so a write is the whole truth.
 */
export async function writeFavouriteList(
  key: string,
  ids: string[]
): Promise<FavouriteListRecord> {
  const conn = await connectToDatabase();
  requireDatabase(conn, "the saved list could not be written");

  try {
    const row = await FavouriteListModel.findOneAndUpdate(
      { key },
      { key, ids },
      { upsert: true, new: true }
    ).lean();
    return toFavouriteListRecord(row);
  } catch (error: any) {
    // Two devices writing the same key for the first time at the same moment
    // both try to create the row, and the second one is refused by the unique
    // index. The row exists now, so the same write without the insert lands.
    if (error?.code !== 11000) throw error;
    const row = await FavouriteListModel.findOneAndUpdate(
      { key },
      { key, ids },
      { new: true }
    ).lean();
    return toFavouriteListRecord(row);
  }
}
