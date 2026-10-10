/* Throwaway: what does the network layer say about alixbd.com right now? */
import dns from "node:dns";

const HOSTS = ["alixbd.com", "www.alixbd.com", "tplay.live"];
const PATHS = [
  "https://alixbd.com/playlistconfig/playlist.m3u",
  "https://alixbd.com/playlistconfig/channel/71.m3u8",
  "https://alixbd.com/playlistconfig/channel/73.m3u8",
];

const strip = (u) => {
  try {
    const x = new URL(u);
    return x.host + x.pathname;
  } catch {
    return "<bad url>";
  }
};

console.log("system resolver servers:", JSON.stringify(dns.getServers()));

for (const h of HOSTS) {
  for (const kind of ["resolve4", "resolve6", "resolveCname"]) {
    try {
      const r = await dns.promises[kind](h);
      console.log(`${kind.padEnd(12)} ${h} -> ${JSON.stringify(r)}`);
    } catch (e) {
      console.log(`${kind.padEnd(12)} ${h} -> ERROR ${e.code || e.name} ${e.message}`);
    }
  }
  try {
    const a = await dns.promises.lookup(h, { all: true });
    console.log(`lookup-all   ${h} -> ${JSON.stringify(a)}`);
  } catch (e) {
    console.log(`lookup-all   ${h} -> ERROR ${e.code || e.name} ${e.message}`);
  }
  try {
    const a = await dns.promises.lookup(h);
    console.log(`lookup       ${h} -> ${JSON.stringify(a)}`);
  } catch (e) {
    console.log(`lookup       ${h} -> ERROR ${e.code || e.name} ${e.message}`);
  }
}

console.log("\n--- fetch each path, 10s budget ---");
for (const url of PATHS) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
    const text = await res.text().catch(() => "");
    console.log(
      `${strip(url)} -> HTTP ${res.status} in ${Date.now() - t0}ms, ${text.length} chars, final=${strip(res.url)}`
    );
  } catch (e) {
    const code = e?.cause?.code || e?.name;
    console.log(`${strip(url)} -> FAILED in ${Date.now() - t0}ms: ${code} ${e?.message}`);
  } finally {
    clearTimeout(timer);
  }
}
