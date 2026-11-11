/**
 * A stand-in for MongoDB, used to exercise the saved list's database path with no
 * database anywhere near it.
 *
 * The lists live in MongoDB and nowhere else, so the code that has to be proven is the
 * code that writes and reads them there. A real cluster is not available to a test run,
 * so the two things the store actually touches are replaced: `connectToDatabase()`
 * resolves to a truthy stand-in, and the `FavouriteList` model becomes an in-memory one
 * that answers the same calls with the same shapes.
 *
 * Nothing here reaches the network, and nothing is written to disk.
 */

export interface FakeFavouriteRow {
  _id: string;
  key: string;
  ids: string[];
  createdAt: string;
  updatedAt: string;
}

const clone = (row: FakeFavouriteRow): FakeFavouriteRow => ({
  ...row,
  ids: [...row.ids],
});

/**
 * The model as the store calls it.
 *
 * `findOne` reads a row and `findOneAndUpdate` writes one, with an insert when
 * the row is not there yet — which is how a list is written the first time and
 * replaced afterwards.
 */
export interface FakeFavouriteListModel {
  /** The rows the model holds. */
  rows: FakeFavouriteRow[];
  /**
   * Makes the next `count` writes fail the way a racing insert fails: the write
   * is refused with the duplicate-key error the unique index raises, and no row
   * is written.
   */
  failNextWritesWithDuplicateKey: (count: number) => void;
  findOne: (filter: { key?: string }) => { lean: () => Promise<FakeFavouriteRow | null> };
  findOneAndUpdate: (
    filter: { key?: string },
    update: { key: string; ids: string[] },
    options?: { upsert?: boolean; new?: boolean }
  ) => { lean: () => Promise<FakeFavouriteRow | null> };
}

/**
 * The list rows, as the store reads and writes them.
 *
 * `findOneAndUpdate` with an insert is how a list is written the first time, and the
 * same call without one is how it is replaced afterwards — so the fake answers both.
 */
export function createFakeFavouriteListModel(rows: FakeFavouriteRow[] = []): FakeFavouriteListModel {
  let counter = 0;
  /** How many of the next writes are refused with a duplicate-key error. */
  let duplicateFailures = 0;
  /** A real ObjectId shape, because the row carries one. */
  const nextId = () => `65b5c72de29c995275489${(counter++).toString(16).padStart(3, "0")}`;

  return {
    rows,
    failNextWritesWithDuplicateKey(count: number) {
      duplicateFailures = count;
    },
    findOne(filter: { key?: string }) {
      return {
        lean: async () => {
          const row = rows.find((entry) => entry.key === filter?.key);
          return row ? clone(row) : null;
        },
      };
    },
    findOneAndUpdate(
      filter: { key?: string },
      update: { key: string; ids: string[] },
      options: { upsert?: boolean; new?: boolean } = {}
    ) {
      return {
        lean: async () => {
          if (duplicateFailures > 0) {
            duplicateFailures -= 1;
            const error: any = new Error(
              "E11000 duplicate key error collection: freetv.favouritelists index: key_1"
            );
            error.code = 11000;
            throw error;
          }

          const index = rows.findIndex((entry) => entry.key === filter?.key);
          const now = new Date().toISOString();

          if (index < 0) {
            if (!options.upsert) return null;
            const row: FakeFavouriteRow = {
              _id: nextId(),
              key: update.key,
              ids: [...update.ids],
              createdAt: now,
              updatedAt: now,
            };
            rows.push(row);
            return clone(row);
          }

          const merged: FakeFavouriteRow = {
            ...rows[index],
            key: update.key,
            ids: [...update.ids],
            updatedAt: now,
          };
          rows[index] = merged;
          return clone(merged);
        },
      };
    },
  };
}

export interface FakeFavouriteDatabase {
  /** The list rows the store will read and write. */
  lists: FakeFavouriteRow[];
  /** The model standing in for MongoDB, so a test can make a write fail. */
  model: FakeFavouriteListModel;
  /** Puts the real modules back. */
  restore: () => void;
}

/**
 * Replaces the database for the duration of a test.
 *
 * The two modules are patched in place rather than re-required, so every module that
 * already holds a reference to them sees the change: the store asks for
 * `connectToDatabase()` at call time, and asks the model for its `default` export at
 * call time too.
 */
export function installFakeFavouriteDatabase(
  options: { lists?: FakeFavouriteRow[] } = {}
): FakeFavouriteDatabase {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dbModule = require("@/lib/db");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const listModule = require("@/models/FavouriteList");

  const originalConnect = dbModule.connectToDatabase;
  const originalList = listModule.default;

  const lists = options.lists ?? [];
  const model = createFakeFavouriteListModel(lists);

  dbModule.connectToDatabase = async () => ({ fake: true });
  listModule.default = model;

  return {
    lists,
    model,
    restore() {
      dbModule.connectToDatabase = originalConnect;
      listModule.default = originalList;
    },
  };
}
