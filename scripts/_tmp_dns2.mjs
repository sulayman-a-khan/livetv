/* Throwaway: does the failing host resolve from this PC, and from public resolvers? */
import dns from "node:dns";

const HOSTS = [
  "alixbd.com",
  "prod-linear-media.toffeelive.com",
  "toffeelive.com",
  "tplay.live",
  "gpcdn.net",
];

const withServers = (servers) => {
  const prev = dns.getServers();
  dns.setServers(servers);
  return () => dns.setServers(prev);
};

const attempts = [
  { label: "router(192.168.0.1)", servers: null },
  { label: "1.1.1.1", servers: ["1.1.1.1"] },
  { label: "8.8.8.8", servers: ["8.8.8.8"] },
  { label: "9.9.9.9", servers: ["9.9.9.9"] },
];

for (const a of attempts) {
  const restore = a.servers ? withServers(a.servers) : null;
  for (const h of HOSTS) {
    const out = [];
    for (const kind of ["resolve4", "resolve6"]) {
      try {
        const r = await dns.promises[kind](h);
        out.push(`${kind}=${JSON.stringify(r)}`);
      } catch (e) {
        out.push(`${kind}=ERR:${e.code || e.name}`);
      }
    }
    console.log(`${a.label.padEnd(20)} ${h.padEnd(32)} ${out.join("  ")}`);
  }
  if (restore) restore();
}

console.log("--- getaddrinfo (what fetch/net actually uses) ---");
for (const h of HOSTS) {
  try {
    const r = await dns.promises.lookup(h, { all: true });
    console.log(`${h.padEnd(32)} ${JSON.stringify(r)}`);
  } catch (e) {
    console.log(`${h.padEnd(32)} ERR ${e.code || e.name}`);
  }
}
