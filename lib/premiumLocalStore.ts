import fs from "fs";
import path from "path";
import type { FixtureChannelRef } from "./premiumFixtures";

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
  /**
   * The provider account this channel plays from, and the streams it plays and falls back to.
   * Optional in the type for the same reason `proxyChannelKey` is: a store file written before
   * a channel could name a provider has no such field on its rows.
   */
  providerId?: string;
  streamId?: string;
  backupStreamIds?: string[];
  active: boolean;
  sortOrder: number;
  note: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LocalFixture {
  _id: string;
  /** The card's title, as the admin wrote it. */
  title?: string;
  sport: string;
  teamA: string;
  teamB: string;
  teamALogo: string;
  teamBLogo: string;
  competition: string;
  startsAt: Date;
  durationMinutes: number;
  /**
   * Optional in the type for the same reason a stored premium row may have no
   * `proxyChannelKey`: a file written before a card could name several channels has no such
   * field on its fixtures, and reading one must not invent a reference it never recorded.
   */
  channels?: FixtureChannelRef[];
  /** Read-only legacy link, kept so an older file still shows its match on the right channel. */
  premiumChannelId: string | null;
  visible: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DATA_DIR = path.join(process.cwd(), "data");
/**
 * Where this tier's own rows live.
 *
 * The path is the project's own `data/` folder, and a test run may point it somewhere else:
 * a run that measured itself against whatever a developer happened to leave behind would be
 * measuring their leftovers and not the code. Nothing sets this outside a test.
 */
const DATA_FILE = process.env.PREMIUM_STORE_FILE
  ? path.resolve(process.env.PREMIUM_STORE_FILE)
  : path.join(DATA_DIR, "premium-store.json");

declare global {
  // eslint-disable-next-line no-var
  var __freetv_premium_channels: LocalPremiumChannel[] | undefined;
  // eslint-disable-next-line no-var
  var __freetv_premium_fixtures: LocalFixture[] | undefined;
}

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

/**
 * A linked channel as this file can legitimately hold it: an id and the tier it came from,
 * and nothing else. An entry that is not that shape is dropped rather than kept, because the
 * alternative is a card that offers a channel no route can name — and a key that is not one of
 * these two is exactly the kind of thing that must not be stored on a fixture.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readRef = (value: any): FixtureChannelRef | null => {
  const channelId = typeof value?.channelId === "string" ? value.channelId.trim() : "";
  const sourceType =
    typeof value?.sourceType === "string" ? value.sourceType.trim().toLowerCase() : "";
  if (!channelId) return null;
  if (sourceType !== "direct" && sourceType !== "secured") return null;
  return { channelId, sourceType };
};

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
        providerId: text(c?.providerId),
        streamId: text(c?.streamId),
        backupStreamIds: Array.isArray(c?.backupStreamIds)
          ? c.backupStreamIds.filter((id: unknown): id is string => typeof id === "string")
          : [],
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
        title: text(f?.title),
        sport: text(f?.sport, "football"),
        teamA: text(f?.teamA),
        teamB: text(f?.teamB),
        teamALogo: text(f?.teamALogo),
        teamBLogo: text(f?.teamBLogo),
        competition: text(f?.competition),
        startsAt: f?.startsAt ? new Date(f.startsAt) : new Date(),
        durationMinutes: typeof f?.durationMinutes === "number" ? f.durationMinutes : 120,
        channels: Array.isArray(f?.channels)
          ? f.channels.map(readRef).filter((ref: FixtureChannelRef | null) => ref !== null)
          : undefined,
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
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
   * Remove a channel row.
   *
   * The links to it are cleared by the tier's own delete path (`clearFixtureLinks` in
   * `lib/premiumStore.ts`) rather than here, so that MongoDB and this file behave the same
   * way: one rule, one implementation, whichever store is underneath.
   */
  deleteChannel: (id: string): boolean => {
    ensureLoaded();
    const before = global.__freetv_premium_channels?.length || 0;
    global.__freetv_premium_channels = (global.__freetv_premium_channels || []).filter(
      (c) => c._id !== id
    );
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
