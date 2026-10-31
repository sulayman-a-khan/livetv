import fs from "fs";
import path from "path";

/**
 * The premium tier's own local store — its own file, its own arrays, and no
 * connection to the catalogue store in `lib/inMemoryStore.ts`.
 *
 * The Direct HLS catalogue and this tier are separate products that happen to
 * share a database server, so they share nothing in code either: this store is
 * only used when there is no MongoDB (a local run), and production always uses
 * the `PremiumChannel` collection through `lib/premiumStore.ts`.
 * A viewer-facing channel list is never read or written from here.
 *
 * Match cards are not in this file. They belong to the Direct HLS panel and live in
 * MongoDB through `lib/fixtureStore.ts`, so a card the admin enters is the same card
 * the homepage shows.
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
}

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

/**
 * Read the file once per process. Nothing is ever seeded: an absent or unreadable
 * store simply means the tier has no entries yet, and a failure here must not be
 * able to touch the catalogue store beside it.
 */
function ensureLoaded() {
  if (global.__freetv_premium_channels) return;

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
      return;
    }
  } catch (err) {
    console.error("[premiumLocalStore] Failed to read the premium store from disk:", err);
  }

  global.__freetv_premium_channels = [];
}

function saveToDisk() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = {
      premiumChannels: global.__freetv_premium_channels || [],
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

  /** Where this store keeps itself, for the panel to show on screen. */
  filePath: (): string => DATA_FILE,
};
