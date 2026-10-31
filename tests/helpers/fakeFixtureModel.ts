/**
 * A stand-in for MongoDB, used to exercise the fixture store's database path with no database
 * anywhere near it.
 *
 * The fixture cards live in MongoDB and nowhere else, so the code that has to be proven is the
 * code that writes and reads them there. A real cluster is not available to a test run, so the
 * two things the store actually touches are replaced: `connectToDatabase()` resolves to a
 * truthy stand-in, and the `Fixture` and `Channel` models become in-memory ones that answer the
 * same calls with the same shapes.
 *
 * Nothing here reaches the network, and nothing is written to disk.
 */

export interface FakeRow {
  _id: string;
  [key: string]: unknown;
}

const clone = (row: FakeRow): FakeRow => JSON.parse(JSON.stringify(row));

/** A query object shaped the way the store and the sources read one. */
interface FakeQuery {
  select: (fields?: string) => FakeQuery;
  sort: (spec?: unknown) => FakeQuery;
  lean: () => Promise<FakeRow[]>;
}

/** The catalogue's own filters: a field equality, or a set of ids. */
function matches(row: FakeRow, filter: Record<string, unknown>): boolean {
  for (const [key, want] of Object.entries(filter || {})) {
    if (want && typeof want === "object" && Array.isArray((want as { $in?: unknown[] }).$in)) {
      const ids = (want as { $in: unknown[] }).$in.map(String);
      if (!ids.includes(String(row[key]))) return false;
      continue;
    }
    if (row[key] !== want) return false;
  }
  return true;
}

/**
 * The catalogue rows, as the two reads a fixture board makes see them: the pinned ones with their
 * names and logos, and the ones a set of ids names.
 */
export function createFakeChannelModel(rows: FakeRow[] = []) {
  return {
    rows,
    find(filter: Record<string, unknown> = {}) {
      const found = rows.filter((row) => matches(row, filter));
      const query: FakeQuery = {
        select: () => query,
        sort: () => query,
        lean: async () => found.map(clone),
      };
      return query;
    },
  };
}

/**
 * The card rows, as the store reads and writes them.
 *
 * `create` answers with a document rather than a plain row, because that is what mongoose does
 * and the store asks it for `toObject()`.
 */
export function createFakeFixtureModel(rows: FakeRow[] = []) {
  let counter = 0;
  /** A real ObjectId shape, because the store asks mongoose whether an id is one. */
  const nextId = () => `64b5c72de29c995275489${(counter++).toString(16).padStart(3, "0")}`;

  return {
    rows,
    find() {
      return { lean: async () => rows.map(clone) };
    },
    findById(id: string) {
      return {
        lean: async () => {
          const row = rows.find((entry) => String(entry._id) === String(id));
          return row ? clone(row) : null;
        },
      };
    },
    findByIdAndUpdate(id: string, patch: Record<string, unknown>) {
      return {
        lean: async () => {
          const index = rows.findIndex((entry) => String(entry._id) === String(id));
          if (index < 0) return null;
          const merged = { ...rows[index], ...patch, updatedAt: new Date().toISOString() };
          rows[index] = merged;
          return clone(merged);
        },
      };
    },
    async create(doc: Record<string, unknown>) {
      const now = new Date().toISOString();
      const row = { _id: nextId(), ...doc, createdAt: now, updatedAt: now };
      rows.push(row);
      return { toObject: () => clone(row) };
    },
    async deleteOne(filter: { _id?: string }) {
      const index = rows.findIndex((entry) => String(entry._id) === String(filter?._id));
      if (index < 0) return { deletedCount: 0 };
      rows.splice(index, 1);
      return { deletedCount: 1 };
    },
  };
}

export interface FakeDatabase {
  /** The card rows the store will read and write. */
  fixtures: FakeRow[];
  /** The catalogue rows the fixture sources will read. */
  channels: FakeRow[];
  /** Puts the real modules back. */
  restore: () => void;
}

/**
 * Replaces the database for the duration of a test.
 *
 * The three modules are patched in place rather than re-required, so every module that already
 * holds a reference to them sees the change: the store asks for `connectToDatabase()` at call
 * time, and asks the model for its `default` export at call time too.
 */
export function installFakeDatabase(
  options: { fixtures?: FakeRow[]; channels?: FakeRow[] } = {}
): FakeDatabase {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dbModule = require("@/lib/db");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fixtureModule = require("@/models/Fixture");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const channelModule = require("@/models/Channel");

  const originalConnect = dbModule.connectToDatabase;
  const originalFixture = fixtureModule.default;
  const originalChannel = channelModule.default;

  const fixtures = options.fixtures ?? [];
  const channels = options.channels ?? [];

  dbModule.connectToDatabase = async () => ({ fake: true });
  fixtureModule.default = createFakeFixtureModel(fixtures);
  channelModule.default = createFakeChannelModel(channels);

  return {
    fixtures,
    channels,
    restore() {
      dbModule.connectToDatabase = originalConnect;
      fixtureModule.default = originalFixture;
      channelModule.default = originalChannel;
    },
  };
}
