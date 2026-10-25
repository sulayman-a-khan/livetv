import fs from "fs";
import path from "path";

/**
 * The premium tier's own local store — its own file, its own arrays, and no
 * connection to the catalogue store in `lib/inMemoryStore.ts`.
 *
 * The Direct HLS catalogue and this tier are separate products that happen to
 * share a database server, so they share nothing in code either: this store is
 * only used when there is no MongoDB (a local run), and production always uses
 * the `PremiumChannel` / `Fixture` collections through `lib/premiumStore.ts`.
 * A viewer-facing channel list is never read or written from here.
 */

export interface LocalPremiumChannel {
  _id: string;
  name: string;
  category: string;
  logoUrl: string;
  /** Admin-supplied line. Never published to a viewer-facing route. */
  sourceUrl: string;
  headers: { userAgent: string; referer: string };
  /**
   * The handle this channel's source is registered under on the proxy box. Optional in the
   * type because a store file written before the box existed has no such field on its rows.
   */
  proxyChannelKey?: string;
  proxyPushedAt?: Date | null;
  active: boolean;
  sortOrder: number;
  note: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LocalFixture {
  _id: string;
  sport: string;
  teamA: string;
  teamB: string;
  teamALogo: string;
  teamBLogo: string;
  competition: string;
  startsAt: Date;
  durationMinutes: number;
  premiumChannelId: string | null;
  visible: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "premium-store.json");

declare global {
  // eslint-disable-next-line no-var
  var __freetv_premium_channels: LocalPremiumChannel[] | undefined;
  // eslint-disable-next-line no-var
  var __freetv_premium_fixtures: LocalFixture[] | undefined;
}

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

/**
 * Read the file once per process. Nothing is ever seeded: an absent or unreadable
 * store simply means the tier has no entries yet, and a failure here must not be
 * able to touch the catalogue store beside it.
 */
function ensureLoaded() {
  if (global.__freetv_premium_channels && global.__freetv_premium_fixtures) return;

  try {
    if (fs.existsSync(DATA_FILE)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      global.__freetv_premium_channels = (
        Array.isArray(parsed.premiumChannels) ? parsed.premiumChannels : []
      ).map((c: any) => ({
        _id: text(c?._id),
        name: text(c?.name),
        category: text(c?.category, "Premium"),
        logoUrl: text(c?.logoUrl),
        sourceUrl: text(c?.sourceUrl),
        headers: {
          userAgent: text(c?.headers?.userAgent),
          referer: text(c?.headers?.referer),
        },
        proxyChannelKey: text(c?.proxyChannelKey),
        proxyPushedAt: c?.proxyPushedAt ? new Date(c.proxyPushedAt) : null,
        active: c?.active !== false,
        sortOrder: typeof c?.sortOrder === "number" ? c.sortOrder : 99,
        note: text(c?.note),
        createdAt: c?.createdAt ? new Date(c.createdAt) : new Date(),
        updatedAt: c?.updatedAt ? new Date(c.updatedAt) : new Date(),
      }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      global.__freetv_premium_fixtures = (
        Array.isArray(parsed.fixtures) ? parsed.fixtures : []
      ).map((f: any) => ({
        _id: text(f?._id),
        sport: text(f?.sport, "football"),
        teamA: text(f?.teamA),
        teamB: text(f?.teamB),
        teamALogo: text(f?.teamALogo),
        teamBLogo: text(f?.teamBLogo),
        competition: text(f?.competition),
        startsAt: f?.startsAt ? new Date(f.startsAt) : new Date(),
        durationMinutes: typeof f?.durationMinutes === "number" ? f.durationMinutes : 120,
        premiumChannelId: text(f?.premiumChannelId) || null,
        visible: f?.visible === true,
        createdAt: f?.createdAt ? new Date(f.createdAt) : new Date(),
        updatedAt: f?.updatedAt ? new Date(f.updatedAt) : new Date(),
      }));
      return;
    }
  } catch (err) {
    console.error("[premiumLocalStore] Failed to read the premium store from disk:", err);
  }

  global.__freetv_premium_channels = [];
  global.__freetv_premium_fixtures = [];
}

function saveToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = {
      premiumChannels: global.__freetv_premium_channels || [],
      fixtures: global.__freetv_premium_fixtures || [],
    };
    // Atomic write, for the same reason the catalogue store does it: a crash
    // mid-serialize must not leave a truncated file behind. Write to a temp file
    // on the same volume, then rename over the target.
    const tmpFile = `${DATA_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpFile, DATA_FILE);
  } catch (err) {
    console.error("[premiumLocalStore] Failed to write the premium store to disk:", err);
  }
}

export const premiumLocalStore = {
  listChannels: (): LocalPremiumChannel[] => {
    ensureLoaded();
    return [...(global.__freetv_premium_channels || [])];
  },

  getChannel: (id: string): LocalPremiumChannel | null => {
    ensureLoaded();
    return global.__freetv_premium_channels?.find((c) => c._id === id) || null;
  },

  addChannel: (channel: LocalPremiumChannel): LocalPremiumChannel => {
    ensureLoaded();
    global.__freetv_premium_channels = global.__freetv_premium_channels || [];
    global.__freetv_premium_channels.push(channel);
    saveToDisk();
    return channel;
  },

  updateChannel: (id: string, patch: Partial<LocalPremiumChannel>): LocalPremiumChannel | null => {
    ensureLoaded();
    const channel = global.__freetv_premium_channels?.find((c) => c._id === id);
    if (!channel) return null;
    Object.assign(channel, patch, { updatedAt: new Date() });
    saveToDisk();
    return channel;
  },

  /**
   * Deleting a channel clears the link on every fixture that pointed at it but
   * never deletes the match itself: only the admin decides a fixture is gone.
   */
  deleteChannel: (id: string): boolean => {
    ensureLoaded();
    const before = global.__freetv_premium_channels?.length || 0;
    global.__freetv_premium_channels = (global.__freetv_premium_channels || []).filter(
      (c) => c._id !== id
    );
    (global.__freetv_premium_fixtures || []).forEach((f) => {
      if (f.premiumChannelId === id) f.premiumChannelId = null;
    });
    saveToDisk();
    return (global.__freetv_premium_channels?.length || 0) < before;
  },

  listFixtures: (): LocalFixture[] => {
    ensureLoaded();
    return [...(global.__freetv_premium_fixtures || [])];
  },

  getFixture: (id: string): LocalFixture | null => {
    ensureLoaded();
    return global.__freetv_premium_fixtures?.find((f) => f._id === id) || null;
  },

  addFixture: (fixture: LocalFixture): LocalFixture => {
    ensureLoaded();
    global.__freetv_premium_fixtures = global.__freetv_premium_fixtures || [];
    global.__freetv_premium_fixtures.push(fixture);
    saveToDisk();
    return fixture;
  },

  updateFixture: (id: string, patch: Partial<LocalFixture>): LocalFixture | null => {
    ensureLoaded();
    const fixture = global.__freetv_premium_fixtures?.find((f) => f._id === id);
    if (!fixture) return null;
    Object.assign(fixture, patch, { updatedAt: new Date() });
    saveToDisk();
    return fixture;
  },

  deleteFixture: (id: string): boolean => {
    ensureLoaded();
    const before = global.__freetv_premium_fixtures?.length || 0;
    global.__freetv_premium_fixtures = (global.__freetv_premium_fixtures || []).filter(
      (f) => f._id !== id
    );
    saveToDisk();
    return (global.__freetv_premium_fixtures?.length || 0) < before;
  },

  /** Where this store keeps itself, for the panel to show on screen. */
  filePath: (): string => DATA_FILE,
};
