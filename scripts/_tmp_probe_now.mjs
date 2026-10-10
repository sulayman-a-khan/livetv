/* Throwaway: what do the toffeelive "DNS lookup failed" rows look like in detail,
 * and do they deliver when asked from this machine right now? */
import { registerHooks } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(process.cwd());
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) {
      const base = path.join(ROOT, spec.replace(/^@\//, ""));
      for (const c of [base + ".ts", base + ".tsx", path.join(base, "index.ts")]) {
        try {
          if (fs.statSync(c).isFile()) return { url: pathToFileURL(c).href, shortCircuit: true };
        } catch {}
      }
    }
    return next(spec, ctx);
  },
});

const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
const uriLine = env.split(/\r?\n/).find((l) => /^\s*MONGODB_URI\s*=/.test(l));
const uri = uriLine.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");

import { MongoClient } from "mongodb";
const { checkHlsStream } = await import(pathToFileURL(path.join(ROOT, "lib", "streamProbe.ts")).href);

const strip = (u) => {
  try {
    const x = new URL(u);
    return x.host + x.pathname;
  } catch {
    return "<bad>";
  }
};
const scrub = (v) =>
  String(v || "").replace(/https?:\/\/[^\s"')]+/g, (m) => {
    try {
      const u = new URL(m);
      return u.host + u.pathname;
    } catch {
      return "<url>";
    }
  });

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
await client.connect();
const db = client.db();

const links = await db
  .collection("streamlinks")
  .find({ $or: [{ url: /toffeelive/i }, { url: /alixbd/i }] })
  .limit(400)
  .toArray();
const ids = [...new Set(links.map((l) => l.channelId))];
const chans = await db.collection("channels").find({ _id: { $in: ids } }).project({ name: 1 }).toArray();
const name = new Map(chans.map((c) => [String(c._id), c.name]));

console.log(`rows: ${links.length}`);

const shape = {};
for (const l of links) {
  const lc = l.lastCheck || {};
  if (lc.errorCode !== "DNS_FAILURE") continue;
  const k = `${lc.errorCode} attempts=${lc.attempts} ms=${lc.responseTime} http=${lc.httpStatus}`;
  shape[k] = (shape[k] || 0) + 1;
}
console.log("DNS_FAILURE row shapes:", JSON.stringify(shape));

// Which channels do these belong to (are ID / Discovery Science among them)?
const want = /(^ID$|Discovery)/i;
const mine = links.filter((l) => want.test(name.get(String(l.channelId)) || ""));
console.log(`\nrows for channels matching ID/Discovery: ${mine.length}`);
for (const l of mine) {
  const lc = l.lastCheck || {};
  console.log(
    JSON.stringify({
      ch: name.get(String(l.channelId)),
      url: strip(l.url),
      status: l.status,
      misses: l.deliveryMisses,
      hidden: l.deliveryHidden,
      code: lc.errorCode,
      err: scrub(lc.error).slice(0, 90),
      checkedAt: l.lastCheckedAt,
    })
  );
}

// Probe a handful live with the shipped code.
const picks = [];
const seenHost = new Set();
for (const l of links) {
  const h = new URL(l.url).host;
  if (!seenHost.has(h) || (h.includes("toffeelive") && [...seenHost].filter((x) => x === h).length < 2)) {
    seenHost.add(h);
    picks.push(l);
  }
  if (picks.length >= 5) break;
}
for (const l of mine.slice(0, 2)) if (!picks.includes(l)) picks.push(l);

console.log("\n--- live probes with the shipped code (delivery re-check options) ---");
const RECHECK = { timeoutMs: 9000, maxAttempts: 1, checkLiveRefresh: false, useFfprobe: false, segmentSampleSize: 1 };
for (const l of picks) {
  const t0 = Date.now();
  const r = await checkHlsStream(l.url, { ...RECHECK, headers: l.headers || undefined });
  console.log(
    JSON.stringify({
      ch: name.get(String(l.channelId)),
      url: strip(l.url),
      wall: Date.now() - t0,
      verdict: `${r.status}/${r.errorCode}/miss=${r.deliveryMisses}`,
      http: r.httpStatus,
      segs: r.segmentCount,
      err: scrub(r.error).slice(0, 120),
    })
  );
}

await client.close();
