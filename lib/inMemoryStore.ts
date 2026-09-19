/**
 * SoluPlay Data Store & Persistence Layer
 * Automatically persists channels and stream links to `data/store.json`
 * so ingested playlists remain permanent even across dev server restarts and code edits.
 */

import fs from "fs";
import path from "path";
import { getChannelLogo } from "./utils";

export interface InMemoryChannel {
  _id: string;
  name: string;
  normalizedName: string;
  logo: string;
  category: string;
  subCategory?: string;
  country: string;
  isPinned: boolean;
  priorityOrder: number;
  /** Free-form admin tags used for manual categorisation overrides. */
  tags?: string[];
  /**
   * Set when an admin edits the channel by hand. Automated passes (category
   * detection, merge metadata) must never overwrite a manually edited record.
   */
  isManuallyEdited?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface InMemoryStreamLink {
  _id: string;
  channelId: string;
  url: string;
  priority: number;
  status: "active" | "degraded" | "broken";
  failedAttempts: number;
  firstFailedAt: Date | null;
  lastCheckedAt: Date | null;
  latency: number;
  createdAt: Date;
  updatedAt: Date;
}

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

const INITIAL_CHANNELS: InMemoryChannel[] = [
  {
    _id: "ch_tsports",
    name: "T Sports HD",
    normalizedName: "tsports",
    logo: getChannelLogo("T Sports HD"),
    category: "Live Sports",
    subCategory: "Cricket",
    country: "Bangladesh",
    isPinned: false,
    priorityOrder: 99,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "ch_gtv",
    name: "GTV (Gazi TV)",
    normalizedName: "gtv",
    logo: getChannelLogo("GTV (Gazi TV)"),
    category: "Live Sports",
    subCategory: "Cricket",
    country: "Bangladesh",
    isPinned: false,
    priorityOrder: 99,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "ch_starsports1",
    name: "Star Sports 1 HD",
    normalizedName: "starsports1",
    logo: getChannelLogo("Star Sports 1 HD"),
    category: "Live Sports",
    subCategory: "Cricket",
    country: "India",
    isPinned: false,
    priorityOrder: 99,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "ch_sonyten1",
    name: "Sony Ten 1 HD",
    normalizedName: "sonyten1",
    logo: getChannelLogo("Sony Ten 1 HD"),
    category: "Live Sports",
    subCategory: "Football",
    country: "India",
    isPinned: false,
    priorityOrder: 99,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "ch_ptvsports",
    name: "PTV Sports",
    normalizedName: "ptvsports",
    logo: getChannelLogo("PTV Sports"),
    category: "Live Sports",
    subCategory: "Cricket",
    country: "Pakistan",
    isPinned: false,
    priorityOrder: 99,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "ch_asports",
    name: "A Sports HD",
    normalizedName: "asports",
    logo: getChannelLogo("A Sports HD"),
    category: "Live Sports",
    subCategory: "Football",
    country: "Pakistan",
    isPinned: false,
    priorityOrder: 99,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "ch_somoynews",
    name: "Somoy News TV",
    normalizedName: "somoynews",
    logo: getChannelLogo("Somoy News TV"),
    category: "News",
    subCategory: "News",
    country: "Bangladesh",
    isPinned: false,
    priorityOrder: 99,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "ch_aajtak",
    name: "Aaj Tak HD",
    normalizedName: "aajtak",
    logo: getChannelLogo("Aaj Tak HD"),
    category: "News",
    subCategory: "News",
    country: "India",
    isPinned: false,
    priorityOrder: 99,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "ch_geonews",
    name: "GEO News",
    normalizedName: "geonews",
    logo: getChannelLogo("GEO News"),
    category: "News",
    subCategory: "News",
    country: "Pakistan",
    isPinned: false,
    priorityOrder: 99,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const INITIAL_STREAMS: InMemoryStreamLink[] = [
  {
    _id: "str_tsports_1",
    channelId: "ch_tsports",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    priority: 1,
    status: "active",
    failedAttempts: 0,
    firstFailedAt: null,
    lastCheckedAt: new Date(),
    latency: 110,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "str_tsports_2",
    channelId: "ch_tsports",
    url: "https://playertest.longtailvideo.com/adaptive/bipbop/gear4/prog_index.m3u8",
    priority: 2,
    status: "active",
    failedAttempts: 0,
    firstFailedAt: null,
    lastCheckedAt: new Date(),
    latency: 145,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "str_gtv_1",
    channelId: "ch_gtv",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    priority: 1,
    status: "active",
    failedAttempts: 0,
    firstFailedAt: null,
    lastCheckedAt: new Date(),
    latency: 125,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "str_gtv_2",
    channelId: "ch_gtv",
    url: "https://demo.unified-streaming.com/k8s/live/stable/sintel.ism/.m3u8",
    priority: 2,
    status: "active",
    failedAttempts: 0,
    firstFailedAt: null,
    lastCheckedAt: new Date(),
    latency: 160,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "str_starsports1_1",
    channelId: "ch_starsports1",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    priority: 1,
    status: "active",
    failedAttempts: 0,
    firstFailedAt: null,
    lastCheckedAt: new Date(),
    latency: 105,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "str_sonyten1_1",
    channelId: "ch_sonyten1",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    priority: 1,
    status: "active",
    failedAttempts: 0,
    firstFailedAt: null,
    lastCheckedAt: new Date(),
    latency: 130,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "str_ptvsports_1",
    channelId: "ch_ptvsports",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    priority: 1,
    status: "active",
    failedAttempts: 0,
    firstFailedAt: null,
    lastCheckedAt: new Date(),
    latency: 115,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "str_asports_1",
    channelId: "ch_asports",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    priority: 1,
    status: "active",
    failedAttempts: 0,
    firstFailedAt: null,
    lastCheckedAt: new Date(),
    latency: 140,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "str_somoynews_1",
    channelId: "ch_somoynews",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    priority: 1,
    status: "active",
    failedAttempts: 0,
    firstFailedAt: null,
    lastCheckedAt: new Date(),
    latency: 95,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "str_aajtak_1",
    channelId: "ch_aajtak",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    priority: 1,
    status: "active",
    failedAttempts: 0,
    firstFailedAt: null,
    lastCheckedAt: new Date(),
    latency: 120,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "str_geonews_1",
    channelId: "ch_geonews",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    priority: 1,
    status: "active",
    failedAttempts: 0,
    firstFailedAt: null,
    lastCheckedAt: new Date(),
    latency: 135,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

declare global {
  // eslint-disable-next-line no-var
  var __freetv_in_memory_channels: InMemoryChannel[] | undefined;
  // eslint-disable-next-line no-var
  var __freetv_in_memory_streams: InMemoryStreamLink[] | undefined;
}

import { detectCategoryAndCountry } from "./utils";

function ensureLoaded(force: boolean = false) {
  if (!force && global.__freetv_in_memory_channels && global.__freetv_in_memory_streams) {
    return;
  }

  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.channels) && Array.isArray(parsed.streams)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        global.__freetv_in_memory_channels = parsed.channels.map((c: any) => {
          // Hand-edited channels keep exactly what the admin saved.
          if (c.isManuallyEdited) {
            return {
              ...c,
              tags: Array.isArray(c.tags) ? c.tags : [],
              isPinned: c.isPinned === true,
              priorityOrder: typeof c.priorityOrder === "number" ? c.priorityOrder : 99,
              createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
              updatedAt: c.updatedAt ? new Date(c.updatedAt) : new Date(),
            };
          }
          const detected = detectCategoryAndCountry(c.name, c.category || "");
          return {
            ...c,
            country: (!c.country || c.country === "Global" || c.country === "All") ? detected.country : c.country,
            category: (!c.category || c.category === "General") ? detected.category : c.category,
            subCategory: (!c.subCategory || c.subCategory === "Others") ? detected.subCategory : c.subCategory,
            logo: getChannelLogo(c.name, c.logo),
            isPinned: c.isPinned === true,
            priorityOrder: typeof c.priorityOrder === "number" ? c.priorityOrder : 99,
            createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
            updatedAt: c.updatedAt ? new Date(c.updatedAt) : new Date(),
          };
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        global.__freetv_in_memory_streams = parsed.streams.map((s: any) => ({
          ...s,
          firstFailedAt: s.firstFailedAt ? new Date(s.firstFailedAt) : null,
          lastCheckedAt: s.lastCheckedAt ? new Date(s.lastCheckedAt) : null,
          createdAt: s.createdAt ? new Date(s.createdAt) : new Date(),
          updatedAt: s.updatedAt ? new Date(s.updatedAt) : new Date(),
        }));
        return;
      }
    }
  } catch (err) {
    console.error("[inMemoryStore] Failed to read store.json from disk:", err);
  }

  global.__freetv_in_memory_channels = [...INITIAL_CHANNELS];
  global.__freetv_in_memory_streams = [...INITIAL_STREAMS];
  saveToDisk();
}

function saveToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const data = {
      channels: global.__freetv_in_memory_channels || [],
      streams: global.__freetv_in_memory_streams || [],
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[inMemoryStore] Failed to write store.json to disk:", err);
  }
}

export const inMemoryDb = {
  getChannels: () => {
    ensureLoaded(true);
    const channels = global.__freetv_in_memory_channels || [];
    return channels.map((c) => {
      // Manual admin overrides are authoritative — skip auto-detection.
      if (c.isManuallyEdited) return c;
      const detected = detectCategoryAndCountry(c.name, c.category || "");
      return {
        ...c,
        country: (!c.country || c.country === "Global" || c.country === "All") ? detected.country : c.country,
        category: (!c.category || c.category === "General") ? detected.category : c.category,
        subCategory: (!c.subCategory || c.subCategory === "Others") ? detected.subCategory : c.subCategory,
        logo: getChannelLogo(c.name, c.logo),
        isPinned: c.isPinned === true,
        priorityOrder: typeof c.priorityOrder === "number" ? c.priorityOrder : 99,
      };
    });
  },
  getStreams: () => {
    ensureLoaded(true);
    return global.__freetv_in_memory_streams || [];
  },
  addChannel: (ch: InMemoryChannel) => {
    ensureLoaded();
    global.__freetv_in_memory_channels?.push(ch);
    saveToDisk();
  },
  addStream: (st: InMemoryStreamLink) => {
    ensureLoaded();
    global.__freetv_in_memory_streams?.push(st);
    saveToDisk();
  },
  deleteChannel: (id: string) => {
    ensureLoaded();
    if (global.__freetv_in_memory_channels) {
      global.__freetv_in_memory_channels = global.__freetv_in_memory_channels.filter(
        (c) => c._id !== id
      );
    }
    if (global.__freetv_in_memory_streams) {
      global.__freetv_in_memory_streams = global.__freetv_in_memory_streams.filter(
        (s) => s.channelId !== id
      );
    }
    saveToDisk();
  },
  deleteStream: (id: string) => {
    ensureLoaded();
    if (global.__freetv_in_memory_streams) {
      global.__freetv_in_memory_streams = global.__freetv_in_memory_streams.filter(
        (s) => s._id !== id
      );
    }
    saveToDisk();
  },
  updateChannelLogo: (id: string, logo: string) => {
    ensureLoaded();
    if (global.__freetv_in_memory_channels) {
      const ch = global.__freetv_in_memory_channels.find((c) => c._id === id);
      if (ch) {
        ch.logo = logo;
        ch.updatedAt = new Date();
      }
    }
    saveToDisk();
  },
  updateChannelPin: (id: string, isPinned: boolean, priorityOrder: number) => {
    ensureLoaded();
    if (global.__freetv_in_memory_channels) {
      const ch = global.__freetv_in_memory_channels.find((c) => c._id === id);
      if (ch) {
        ch.isPinned = isPinned;
        ch.priorityOrder = priorityOrder;
        ch.updatedAt = new Date();
      }
    }
    saveToDisk();
  },
  updatePinnedOrder: (orderedIds: string[]) => {
    ensureLoaded();
    if (global.__freetv_in_memory_channels) {
      orderedIds.forEach((id, index) => {
        const ch = global.__freetv_in_memory_channels!.find((c) => c._id === id);
        if (ch) {
          ch.priorityOrder = index + 1;
          ch.updatedAt = new Date();
        }
      });
    }
    saveToDisk();
  },
  /**
   * Generic field patch used by the admin editor and the maintenance runner.
   * Passing `markManual` flags the record so automated passes leave it alone.
   */
  updateChannel: (
    id: string,
    patch: Partial<InMemoryChannel>,
    markManual: boolean = false
  ): InMemoryChannel | null => {
    ensureLoaded();
    const ch = global.__freetv_in_memory_channels?.find((c) => c._id === id);
    if (!ch) return null;

    Object.assign(ch, patch);
    if (markManual) ch.isManuallyEdited = true;
    ch.updatedAt = new Date();

    saveToDisk();
    return ch;
  },

  /**
   * Removes only the channel record, leaving stream links untouched. Used by
   * the merge pass, where the duplicate's links have already been re-homed to
   * the surviving channel and must not be deleted with it.
   */
  deleteChannelRecordOnly: (id: string) => {
    ensureLoaded();
    if (global.__freetv_in_memory_channels) {
      global.__freetv_in_memory_channels = global.__freetv_in_memory_channels.filter(
        (c) => c._id !== id
      );
    }
    saveToDisk();
  },

  getChannelById: (id: string): InMemoryChannel | null => {
    ensureLoaded();
    return global.__freetv_in_memory_channels?.find((c) => c._id === id) || null;
  },

  getStreamsForChannel: (channelId: string): InMemoryStreamLink[] => {
    ensureLoaded();
    return (global.__freetv_in_memory_streams || []).filter((s) => s.channelId === channelId);
  },

  saveState: () => {
    ensureLoaded();
    saveToDisk();
  },
};
