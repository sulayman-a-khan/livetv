/* Throwaway: is DNS_FAILURE systemic in production, or just this host? */
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const env = fs.readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf8");
const line = env.split(/\r?\n/).find((l) => /^\s*MONGODB_URI\s*=/.test(l));
const uri = line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");

const scrub = (v) =>
  String(v || "").replace(/https?:\/\/[^\s"')]+/g, (m) => {
    try {
      const u = new URL(m);
      return u.host + u.pathname;
    } catch {
      return "<url>";
    }
  });

const show = (u) => {
  try {
    const x = new URL(u);
    return x.host + x.pathname;
  } catch {
    return "<bad>";
  }
};
const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return "<bad>";
  }
};

(async () => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db();

  const all = await db
    .collection("streamlinks")
    .find({})
    .project({ url: 1, status: 1, deliveryMisses: 1, deliveryHidden: 1, lastCheckedAt: 1, lastCheck: 1, manual: 1 })
    .toArray();
  console.log(`total links: ${all.length}`);

  const hist = {};
  for (const l of all) {
    const k = `${(l.lastCheck || {}).errorCode || "(none)"}`;
    hist[k] = (hist[k] || 0) + 1;
  }
  console.log("errorCode histogram:", JSON.stringify(hist, null, 0));

  const dns = all.filter((l) => (l.lastCheck || {}).errorCode === "DNS_FAILURE");
  console.log(`\nDNS_FAILURE rows: ${dns.length}`);
  const byHost = {};
  for (const l of dns) byHost[hostOf(l.url)] = (byHost[hostOf(l.url)] || 0) + 1;
  console.log("hosts:", JSON.stringify(byHost, null, 0));
  for (const l of dns.slice(0, 12)) {
    console.log(
      JSON.stringify({
        url: show(l.url),
        status: l.status,
        misses: l.deliveryMisses,
        hidden: l.deliveryHidden,
        checkedAt: l.lastCheckedAt,
        err: scrub((l.lastCheck || {}).error).slice(0, 80),
      })
    );
  }

  const alix = all.filter((l) => /alixbd/i.test(l.url));
  console.log("\nall alixbd rows:");
  for (const l of alix) {
    console.log(
      JSON.stringify({
        url: show(l.url),
        status: l.status,
        misses: l.deliveryMisses,
        hidden: l.deliveryHidden,
        manual: l.manual,
        lastCheckedAt: l.lastCheckedAt,
        code: (l.lastCheck || {}).errorCode,
        err: scrub((l.lastCheck || {}).error).slice(0, 80),
        attempts: (l.lastCheck || {}).attempts,
        ms: (l.lastCheck || {}).responseTime,
      })
    );
  }

  // how recently did production check anything at all?
  const times = all.map((l) => l.lastCheckedAt).filter(Boolean).sort();
  console.log("\nnewest lastCheckedAt:", times[times.length - 1]);
  console.log("oldest lastCheckedAt:", times[0]);

  await client.close();
})().catch((e) => {
  console.log("ERROR:", e.message);
  process.exit(1);
});
