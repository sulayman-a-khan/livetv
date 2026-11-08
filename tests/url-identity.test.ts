import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { canonicalStreamUrl } from "../lib/channelIdentity";
import { parseM3uContent } from "../lib/m3uParser";
import { groupPlaylistEntries, planPlaylistSync, rekeyStoredEntries, selectProbeUrls, type StoredEntry, type ChannelState } from "../lib/playlistSyncPlan";
import { planMaintenance } from "../lib/channelMaintenance";
import PlaylistEntry from "../models/PlaylistEntry";

const http = "http://cdn.broadcast.tv/Live.m3u8?Token=AbC";
const https = http.replace("http:", "https:");
const legacy = (url = http): StoredEntry => ({ _id: "entry1", channelKey: "sports", name: "Sports", url, canonicalUrl: url.replace(/^https?:\/\//, "").toLowerCase(), status: "present" });
const desired = (url: string) => ({ channelKey: "sports", name: "Sports", url, canonicalUrl: canonicalStreamUrl(url) });
const channel = (over: Partial<ChannelState> = {}): ChannelState => ({ channelKey: "sports", channelId: "ch1", isPinned: true, links: [{ _id: "link1", url: http, canonicalUrl: legacy().canonicalUrl, status: "active", latency: 100 }], sourceLinkIds: ["link1"], ...over });

test("URL identity keeps scheme, path/query case, credentials and trailing path bytes", () => {
  assert.notEqual(canonicalStreamUrl(http), canonicalStreamUrl(https));
  assert.equal(canonicalStreamUrl(`  HTTP://CDN.BROADCAST.TV/Live.m3u8?Token=AbC  `), http);
  for (const other of [http.replace("Live", "live"), http.replace("AbC", "abc"), `${http}/`]) {
    assert.notEqual(canonicalStreamUrl(http), canonicalStreamUrl(other));
  }
  assert.equal(canonicalStreamUrl("HTTPS://User:Pass@CDN.TV/A?Q=X"), "https://User:Pass@cdn.tv/A?Q=X");
  assert.equal(canonicalStreamUrl("not a URL/AbC"), "not a URL/AbC");
});

test("persisted canonicalUrl no longer lowercases paths and tokens", () => {
  const row = new PlaylistEntry({ sourceId: "012345678901234567890123", channelKey: "sports", url: https, canonicalUrl: https });
  assert.equal(row.canonicalUrl, https);
});

test("M3U import recognizes uppercase HTTP/HTTPS and retains both original URLs", () => {
  const urls = [http.replace("http:", "HTTP:"), https.replace("https:", "HTTPS:")];
  const parsed = parseM3uContent(`#EXTM3U\n${urls.map((url) => `#EXTINF:-1,Sports\n${url}`).join("\n")}`);
  assert.deepEqual(parsed.map((item) => item.streamUrl), urls);
  assert.equal(new Set(parsed.map((item) => canonicalStreamUrl(item.streamUrl))).size, 2);
});

test("legacy present row rekeys in place while HTTPS is a separate addition", () => {
  const old = legacy();
  const groups = groupPlaylistEntries({ desired: [desired(http), desired(https)], storedEntries: [old], channels: [channel()] });
  assert.deepEqual(selectProbeUrls(groups), [https]);
  const plan = planPlaylistSync(groups, new Map());
  assert.deepEqual(plan.linksToCreate.map((link) => link.url), [https]);
  assert.deepEqual(plan.entriesToCreate.map((entry) => entry.canonicalUrl), [https]);
  assert.deepEqual(plan.entryPatches, [{ _id: old._id, patch: { canonicalUrl: http } }]);
  assert.deepEqual(plan.linksToDelete, []);
  assert.equal(old.canonicalUrl, legacy().canonicalUrl);
});

test("legacy missing row returns without inserting a duplicate or losing its ID", () => {
  const old = { ...legacy(https), status: "missing" as const };
  const groups = groupPlaylistEntries({ desired: [desired(https)], storedEntries: [old], channels: [] });
  const plan = planPlaylistSync(groups, new Map());
  assert.equal(plan.entriesToCreate.length, 0);
  assert.equal(plan.entryPatches[0]._id, old._id);
  assert.equal(plan.entryPatches[0].patch.canonicalUrl, https);
  assert.ok(plan.entryPatches.some((entry) => entry._id === old._id && entry.patch.status === "present"));
  assert.equal(plan.linksToCreate.length, 0);
});

test("rekey is idempotent and ambiguous mixed-version rows fail closed", () => {
  const first = rekeyStoredEntries([legacy()]);
  assert.deepEqual(rekeyStoredEntries(first.entries).patches, []);
  const duplicate = { ...legacy(), _id: "entry2", canonicalUrl: http };
  assert.throws(() => rekeyStoredEntries([legacy(), duplicate]), /identity conflict/);
  assert.throws(() => rekeyStoredEntries([duplicate, legacy()]), /identity conflict/);
});

test("scheme additions respect the pin gate and outgoing manual/disabled links", () => {
  const groups = groupPlaylistEntries({ desired: [desired(https)], storedEntries: [legacy()], channels: [channel({ isPinned: false })] });
  assert.deepEqual(selectProbeUrls(groups), []);
  assert.equal(planPlaylistSync(groups, new Map()).linksToCreate.length, 0);
  for (const protection of [{ manual: true }, { adminDisabled: true }]) {
    const state = channel();
    Object.assign(state.links[0], protection, { status: "broken" });
    const protectedGroups = groupPlaylistEntries({ desired: [desired(https)], storedEntries: [legacy()], channels: [state] });
    const probes = new Map([[https, { ok: true, status: "ONLINE", latency: 100, checkedAt: new Date().toISOString() } as Parameters<typeof planPlaylistSync>[1] extends Map<string, infer P> ? P : never]]);
    assert.deepEqual(planPlaylistSync(protectedGroups, probes).linksToDelete, []);
  }
});

test("maintenance dedup keeps HTTP and HTTPS; removes only same-protocol copies", () => {
  const streams = [http, https, http.replace("cdn.broadcast.tv", "CDN.BROADCAST.TV")].map((url, index) => ({ _id: `link${index}`, channelId: "ch1", url, status: "active" as const, priority: index + 1, latency: 100 }));
  const plan = planMaintenance([{ _id: "ch1", name: "Sports", isPinned: true }], streams);
  assert.deepEqual(plan.streamsToDelete, ["link2"]);
  assert.equal(plan.stats.duplicateLinksRemoved, 1);
});

// Storage adapters run against strict in-process doubles only: no DB or fetch.
test("byte-identical sync repairs legacy keys and imports both schemes; source edit resets tracking", async () => {
  const nodeModule = Module as typeof Module & { _load: (request: string, ...args: unknown[]) => any };
  const originalLoad = nodeModule._load;
  const content = `#EXTM3U\n#EXTINF:-1,Sports\n${http}\n#EXTINF:-1,Sports\n${https}`;
  const crypto = await import("node:crypto");
  const source = { _id: "012345678901234567890123", name: "Provider", url: "http://provider.tv/list.m3u", contentHash: crypto.createHash("sha256").update(content).digest("hex") };
  const rows: any[] = [legacy()];
  const sourcePatches: any[] = [];
  let resets = 0;
  const entryModel = {
    find: () => ({ lean: async () => rows.map((row) => ({ ...row })) }),
    updateOne: async (filter: any, update: any) => { Object.assign(rows.find((row) => row._id === filter._id || row.canonicalUrl === filter.canonicalUrl), update.$set); },
    create: async (row: any) => {
      assert.equal(source.contentHash, "", "interrupted rekeys must not leave a usable old content hash");
      assert.ok(!rows.some((existing) => existing.canonicalUrl === row.canonicalUrl));
      rows.push({ ...row, _id: `entry${rows.length + 1}` });
    },
    updateMany: async () => {},
    deleteMany: async () => { resets++; },
  };
  const mocks: Record<string, unknown> = {
    "./db": { connectToDatabase: async () => ({}) },
    "@/models/PlaylistSource": { findById: () => ({ lean: async () => source }), updateOne: async (_filter: any, update: any) => { sourcePatches.push(update.$set); Object.assign(source, update.$set); } },
    "@/models/PlaylistEntry": entryModel,
    "@/models/Channel": { find: () => ({ select: () => ({ lean: async () => [] }) }) },
    "@/models/StreamLink": {},
    "./safeFetch": { safeFetch: async () => ({ ok: true, text: async () => content }) },
    "./streamProbe": { redactUrl: (url: string) => url, checkHlsStream: () => { throw new Error("Unexpected probe"); } },
    "./maintenanceRunner": {},
    "./playlistMonitor": {},
  };
  nodeModule._load = function (request, ...args) {
    if (request in mocks) return mocks[request];
    return originalLoad.call(this, request, ...args);
  };
  try {
    const sync = require("../lib/playlistSync") as typeof import("../lib/playlistSync");
    const result = await sync.syncPlaylistSource(source._id);
    assert.equal(result.entriesParsed, 2);
    assert.deepEqual(rows.map((row) => row.canonicalUrl), [http, https]);
    assert.equal(rows[0]._id, "entry1");
    assert.equal(resets, 0);
    assert.equal((await sync.syncPlaylistSource(source._id)).status, "unchanged");
    const sources = require("../lib/playlistSources") as typeof import("../lib/playlistSources");
    await sources.updateSource(source._id, { url: source.url.replace("http:", "https:") });
    assert.equal(sourcePatches.at(-1).contentHash, "");
    assert.equal(sourcePatches.at(-1).lastCheckedAt, null);
    assert.equal(resets, 1);
  } finally {
    nodeModule._load = originalLoad;
  }
});
