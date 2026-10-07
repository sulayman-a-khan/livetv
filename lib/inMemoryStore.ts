/**
 * SoluPlay Data Store & Persistence Layer
 * Automatically persists channels and stream links to `data/store.json`
 * so ingested playlists remain permanent even across dev server restarts and code edits.
 */

import fs from "fs";
import path from "path";
import { getChannelLogo } from "./utils";
import { normalizeCategory, type ChannelCategory } from "./categories";

export interface InMemoryChannel {
  _id: string;
  name: string;
  normalizedName: string;
  logo: string;
  /** Exactly one of the five catalogue categories. */
  category: ChannelCategory;
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
  /**
   * Consecutive-failure streak bookkeeping (see `lib/streamHealth.ts`). The
   * streak advances at most once per UTC day, and this is the day it last moved.
   */
  lastCountedFailureDay?: string | null;
  /** Hand-added link: automation may probe and rank it, never delete it. */
  manual?: boolean;
  /** Admin took the link out of service; hidden until an admin restores it. */
  adminDisabled?: boolean;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Optional per-stream request headers (User-Agent/Referer/Origin/
   * Authorization/Cookie) forwarded to the health checker. Undefined means
   * "use the checker's sensible defaults" — nothing else in the app reads
   * this, so it's safe to leave unset on existing records.
   */
  headers?: Record<string, string>;
  /**
   * Rich diagnostics from the last HLS health check (see
   * `lib/streamProbe.ts`). Additive/optional so existing records and code
   * that only know about `status`/`latency` keep working untouched — this
   * is purely extra detail for the admin UI/logs.
   */
  lastCheck?: {
    healthStatus: string; // ONLINE | DEGRADED | OFFLINE | EXPIRED | BLOCKED | INVALID | TIMEOUT | UNKNOWN
    errorCode: string;
    httpStatus: number | null;
    responseTime: number;
    playlistType: string | null;
    isLive: boolean | null;
    segmentCount: number | null;
    newSegmentDetected: boolean | null;
    video: boolean | null;
    audio: boolean | null;
    resolution: string | null;
    codec: string | null;
    fps: number | null;
    attempts: number;
    error: string | null;
    checkedAt: string;
  };
}

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

const seedChannel = (
  _id: string,
  name: string,
  normalizedName: string,
  category: ChannelCategory,
  country: string
): InMemoryChannel => ({
  _id,
  name,
  normalizedName,
  logo: getChannelLogo(name),
  category,
  country,
  isPinned: false,
  priorityOrder: 99,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const INITIAL_CHANNELS: InMemoryChannel[] = [
  seedChannel("ch_tsports", "T Sports HD", "tsports", "Sports", "Bangladesh"),
  seedChannel("ch_gtv", "GTV (Gazi TV)", "gtv", "Bangla", "Bangladesh"),
  seedChannel("ch_starsports1", "Star Sports 1 HD", "starsports1", "Sports", "India"),
  seedChannel("ch_sonyten1", "Sony Ten 1 HD", "sonyten1", "Sports", "India"),
  seedChannel("ch_ptvsports", "PTV Sports", "ptvsports", "Sports", "Pakistan"),
  seedChannel("ch_asports", "A Sports HD", "asports", "Sports", "Pakistan"),
  seedChannel("ch_somoynews", "Somoy News TV", "somoynews", "Bangla", "Bangladesh"),
  seedChannel("ch_aajtak", "Aaj Tak HD", "aajtak", "Indian", "India"),
  seedChannel("ch_geonews", "GEO News", "geonews", "Pakistani", "Pakistan"),
];

const INITIAL_STREAMS: InMemoryStreamLink[] = [
  {
    _id: "st_tsports",
    channelId: "ch_tsports",
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
    _id: "st_gtv",
    channelId: "ch_gtv",
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
    _id: "st_starsports1",
    channelId: "ch_starsports1",
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
    _id: "st_sonyten1",
    channelId: "ch_sonyten1",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    priority: 1,
    status: "active",
    failedAttempts: 0,
    firstFailedAt: null,
    lastCheckedAt: new Date(),
    latency: 150,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "st_ptvsports",
    channelId: "ch_ptvsports",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    priority: 1,
    status: "active",
    failedAttempts: 0,
    firstFailedAt: null,
    lastCheckedAt: new Date(),
    latency: 160,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "st_asports",
    channelId: "ch_asports",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    priority: 1,
    status: "active",
    failedAttempts: 0,
    firstFailedAt: null,
    lastCheckedAt: new Date(),
    latency: 170,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    _id: "st_somoynews",
    channelId: "ch_somoynews",
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
    _id: "st_aajtak",
    channelId: "ch_aajtak",
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
    _id: "st_geonews",
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
          const base = {
            ...c,
            // Legacy category text ("Live Sports", "News", "Movies", "General")
            // collapses into the five; a value already in the five passes through.
            category: normalizeCategory(c.category, c.name, c.country),
            tags: Array.isArray(c.tags) ? c.tags : [],
            isPinned: c.isPinned === true,
            priorityOrder: typeof c.priorityOrder === "number" ? c.priorityOrder : 99,
            createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
            updatedAt: c.updatedAt ? new Date(c.updatedAt) : new Date(),
          };

          // A hand-edited record is authoritative: only the category collapse runs,
          // never automatic country/logo re-detection.
          if (c.isManuallyEdited) return base;

          const detected = detectCategoryAndCountry(c.name, c.category || "");
          return {
            ...base,
            country:
              !c.country || c.country === "Global" || c.country === "All"
                ? detected.country
                : c.country,
            logo: getChannelLogo(c.name, c.logo),
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
      // Manual admin overrides are authoritative for everything but the
      // five-category collapse, which no record is allowed to escape.
      const category = normalizeCategory(c.category, c.name, c.country);
      if (c.isManuallyEdited) return { ...c, category };
      const detected = detectCategoryAndCountry(c.name, c.category || "");
      return {
        ...c,
        country:
          !c.country || c.country === "Global" || c.country === "All"
            ? detected.country
            : c.country,
        category,
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
