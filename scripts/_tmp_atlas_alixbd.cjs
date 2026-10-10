/* Throwaway: read Atlas rows for the alixbd links. Prints host+path only (query
 * strings stripped) and scrubs any URL that appears inside the stored error text. */
const fs = require("fs");
const path = require("path");

const env = fs.readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf8");
const line = env
  .split(/\r?\n/)
  .find((l) => /^\s*MONGODB_URI\s*=/.test(l));
if (!line) {
  console.log("no MONGODB_URI in .env.local");
  process.exit(1);
}
const uri = line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
const hostAndDb = uri.replace(/\/\/[^@]*@/, "//<redacted>@").split("?")[0];
console.log("connecting to:", hostAndDb);

const { MongoClient, ObjectId } = require("mongodb");

const scrub = (v) => {
  if (typeof v !== "string") return v;
  return v.replace(/https?:\/\/[^\s"')]+/g, (m) => {
    try {
      const u = new URL(m);
      return u.host + u.pathname;
    } catch {
      return "<url>";
    }
  });
};

const show = (u) => {
  try {
    const x = new URL(u);
    return x.host + x.pathname;
  } catch {
    return "<bad>";
  }
};

(async () => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db();

  const links = await db
    .collection("streamlinks")
    .find({ url: /alixbd/i })
    .sort({ lastCheckedAt: -1 })
    .limit(300)
    .toArray();

  const ids = [...new Set(links.map((l) => l.channelId))];
  const chans = await db
    .collection("channels")
    .find({ _id: { $in: ids } })
    .project({ name: 1, isPinned: 1, category: 1 })
    .toArray();
  const byId = new Map(chans.map((c) => [String(c._id), c]));

  console.log(`rows: ${links.length}`);

  const histogram = {};
  for (const l of links) {
    const lc = l.lastCheck || {};
    const k = `${lc.healthStatus || "-"}/${lc.errorCode || "-"}`;
    histogram[k] = (histogram[k] || 0) + 1;
  }
  console.log("status/errorCode histogram:", JSON.stringify(histogram));

  const interesting = links.filter(
    (l) => /Discovery|ID\b/i.test((byId.get(String(l.channelId)) || {}).name || "") || (l.lastCheck || {}).errorCode === "DNS_FAILURE"
  );

  for (const l of interesting.slice(0, 25)) {
    const c = byId.get(String(l.channelId)) || {};
    const lc = l.lastCheck || {};
    console.log(
      JSON.stringify({
        channel: c.name,
        pinned: c.isPinned,
        link: String(l._id),
        url: show(l.url),
        headers: l.headers ? Object.keys(l.headers) : null,
        status: l.status,
        misses: l.deliveryMisses,
        hidden: l.deliveryHidden,
        disabled: l.adminDisabled,
        manual: l.manual,
        lastCheckedAt: l.lastCheckedAt,
        checkedAt: lc.checkedAt,
        health: lc.healthStatus,
        code: lc.errorCode,
        http: lc.httpStatus,
        ms: lc.responseTime,
        err: scrub(String(lc.error || "")).slice(0, 220),
        blocker: l.browserBlocker,
      })
    );
  }

  // cadence of recent checks across all alixbd rows: which run touched them?
  const times = links
    .map((l) => (l.lastCheckedAt ? new Date(l.lastCheckedAt).toISOString() : null))
    .filter(Boolean)
    .sort();
  const buckets = {};
  for (const t of times) {
    const b = t.slice(0, 16);
    buckets[b] = (buckets[b] || 0) + 1;
  }
  console.log("lastCheckedAt minute buckets:", JSON.stringify(buckets));

  await client.close();
})().catch((e) => {
  console.log("ERROR:", e.message);
  process.exit(1);
});
