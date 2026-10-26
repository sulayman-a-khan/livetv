/**
 * Phase 3 end-to-end: the premium tier's push → sign → play handshake, against the real box.
 *
 * Nothing here is a mock of the proxy. The whole shipped proxy is booted in-process on the
 * local stack, `next start` runs the built site as a child process, and every claim is measured
 * through HTTP the way a viewer and the admin panel actually reach it:
 *
 *   1. the admin gate still refuses a wrong key, and a premium row can be created with no
 *      stream on it at all;
 *   2. pushing a source writes the handle and nothing else — the row's own `sourceUrl` and
 *      header columns stay empty, which is the decision this phase exists to keep;
 *   3. a viewer's board links a card to `/premium/<id>` only once the channel has a handle, and
 *      the board's JSON names no token, no origin and no upstream header;
 *   4. `/api/premium/<id>/play` answers with a box-signed, expiring URL on the box's own address,
 *      that URL plays through the site gate, its segments carry their bytes, and a foreign or
 *      absent origin is refused;
 *   5. the origin's own log proves the headers the admin typed reached it, and that the segment
 *      lines the source does not spell out were asked for with the source's credential;
 *   6. retracting takes the lane off the box and the row stops being playable; deleting a row
 *      that still has a lane takes that lane with it;
 *   7. readiness is the box's, not the row's: the board's `securedReady` follows the box's own
 *      health answer, and stopping the box mid-run takes the play route to 503 and the card's
 *      link away while the fixture keeps its teams and its channel name — then the box coming
 *      back, with the line pushed to it again, is what puts them back.
 *   8. a card's linked channels are checked as a list of id-plus-source references: the editor is
 *      offered both tiers, an edit replaces the whole list, and a reference that is unknown,
 *      malformed, or carrying anything beyond an id and a source is refused without being stored;
 *   9. a card that names channels from both tiers offers them as choices, each with the route its
 *      own tier already answers on — one offer taps straight through, two ask the viewer, and the
 *      box going away takes only the secured choice off the offer while the direct one stays.
 *  10. every read resolves the links a card holds now and nothing it held before: a card left with
 *      no channel to name comes off the board, a card linked again to a channel that exists is
 *      offered again with the stale count back at zero, and a deleted channel's id appears nowhere
 *      in what a viewer is sent. The stale-reference shape itself — a card that keeps a link to a
 *      channel that is gone and survives it as a count — is measured by
 *      tests/premium-fixtures.test.ts, because the local store clears a deleted channel's links on
 *      the way out, which is a thing this run is not allowed to undo from outside the validator.
 *
 * It writes to no production database: the first thing it does after the server answers is read
 * `dbMode` from the premium admin route, and it aborts before a single write unless that says
 * `local`. The tier's local store file is restored byte for byte afterwards.
 *
 *   npm run test:premium-box
 *   npm run test:premium-box -- --port=8497 --app=3112
 *   npm run test:premium-box -- --keep      # leave both up for a browser look, Ctrl-C to clean up
 *   npm run test:premium-box -- --tunnel    # put a Cloudflare tunnel in front of the box first
 *
 * With `--tunnel` the box is reached at the ephemeral https address `cloudflared` assigns, so
 * every gate below — admin push, sign, segment bytes, refusals — runs over the public edge rather
 * than over loopback. That is the shape of a real deployment, latency and all.
 *
 * The box is read from the sibling checkout named `ProxyServer` (or SOLUPLAY_PROXY_DIR) and must
 * already be built there.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

const opt = {};
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
  if (match) opt[match[1]] = match[2] === undefined ? true : match[2];
}

const PROXY_PORT = Number(opt.port ?? 8497);
const APP_PORT = Number(opt.app ?? 3112);
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const FOREIGN_ORIGIN = "https://somebody-elses-site.test";
// Where `cloudflared` lives differs by machine, so the run can name it.
const CF_BIN = String(opt.cloudflared ?? "cloudflared");
const TUNNEL_WAIT_MS = 45_000;
// A harness-only key. It is not a secret: it exists so the admin routes can be driven without
// borrowing the machine's real ADMIN_SECRET_KEY, which this script must never read or print.
const HARNESS_ADMIN_KEY = "premium-box-e2e-admin-key-not-real";

const SEGMENT_MS = 2000;
const WINDOW = 4;
const SEGMENT_BYTES = 8192;
const BASE_SEQ = 900;

// The source's two secrets, in the two places real premium lines keep them.
const PATH_TOKEN = "e2ePath7";
const QUERY_TOKEN = "e2eQuery3";
const WANT_UA = "SoluPlayPremiumE2E/1.0 (test lane)";
const WANT_REFERER = "https://origin-desk.test/";

const gates = [];
function gate(name, ok, detail = "") {
  gates.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}
const section = (title) => console.log(`\n${title}`);
const say = (line) => console.log(line);

/**
 * The origin: one manifest URL whose path and query both carry secrets, which answers 403
 * unless the request arrives with the headers it demands, and which remembers every request so
 * the claims about what reached *it* come from its log rather than from ours.
 */
function createRawOrigin() {
  const startedAt = Date.now();
  const seen = [];
  const dir = "premium";
  let inFlight = 0;
  let peak = 0;
  const edge = () => BASE_SEQ + Math.floor((Date.now() - startedAt) / SEGMENT_MS);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://origin.invalid");
    const match = /^\/secure\/([^/]+)\/(index\.m3u8|seg-(\d+)\.ts)$/.exec(url.pathname);
    const file = match?.[2] ?? "";
    const kind = match ? (file === "index.m3u8" ? "manifest" : "segment") : "other";
    const query = url.searchParams.get("token") ?? "";
    const note = (ok, why = "") =>
      seen.push({ ok, why, kind, dir, ua: req.headers["user-agent"] ?? "", referer: req.headers["referer"] ?? "", query, path: url.pathname });

    if (!match) {
      note(false, "no such route");
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
      return;
    }
    if (match[1] !== PATH_TOKEN || query !== QUERY_TOKEN) {
      note(false, "credential");
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("bad token");
      return;
    }
    if (req.headers["user-agent"] !== WANT_UA) {
      note(false, "user-agent");
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("who are you");
      return;
    }
    if (kind === "manifest" && req.headers["referer"] !== WANT_REFERER) {
      note(false, "referer");
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("where did you come from");
      return;
    }

    inFlight += 1;
    if (inFlight > peak) peak = inFlight;
    const finish = (status, body, type) => {
      inFlight -= 1;
      note(true);
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (kind === "manifest") {
      const first = edge() - WINDOW + 1;
      const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", `#EXT-X-MEDIA-SEQUENCE:${first}`];
      for (let seq = first; seq <= edge(); seq += 1) {
        lines.push(`#EXTINF:${(SEGMENT_MS / 1000).toFixed(3)},`, `seg-${seq}.ts`);
      }
      finish(200, `${lines.join("\n")}\n`, "application/vnd.apple.mpegurl");
      return;
    }
    finish(200, Buffer.alloc(SEGMENT_BYTES, Number(match[3]) % 256), "video/mp2t");
  });

  return {
    seen,
    countOf: (whichKind) => seen.filter((row) => row.ok && row.kind === whichKind).length,
    /** Every read that reached this origin, with the header or credential each carried. */
    log: () => seen.map((row) => `${row.ok ? "ok" : `refused(${row.why})`} ${row.kind} ${row.path} ua=${row.ua === WANT_UA ? "wanted" : JSON.stringify(row.ua)} ref=${row.referer === WANT_REFERER ? "wanted" : "-"} q=${row.query === QUERY_TOKEN ? "wanted" : JSON.stringify(row.query)}`),
    start: async (preferredPort) => {
      for (let port = preferredPort; port < preferredPort + 10; port++) {
        try {
          await new Promise((resolve, reject) => {
            const listening = () => {
              server.off("error", reject);
              resolve();
            };
            server.once("error", reject);
            server.listen(port, "127.0.0.1", listening);
          });
          return `http://127.0.0.1:${server.address().port}`;
        } catch {
          // Another process holds this port: try the next one.
        }
      }
      throw new Error(`no port available between ${preferredPort} and ${preferredPort + 9}`);
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const playlistLines = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

// The box republishes each segment under its own path, keeping the sequence number the origin
// named it with — which is what makes a served segment tellable from an empty one.
const seqOf = (pathname) => Number(/\/(\d+)\.ts(?:\?|$)/.exec(pathname)?.[1] ?? -1);

const clean = (headers) =>
  Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined && value !== null));

const exchanges = [];
async function grab(url, headers = {}) {
  const res = await fetch(url, { headers: clean(headers), signal: AbortSignal.timeout(25_000) });
  const body = new Uint8Array(await res.arrayBuffer());
  // The headers stay on the record because the transport claims below — who answered this, and
  // whether anything cached it — can only be read off the response, not off the body.
  const record = { url, status: res.status, headers: res.headers, body, text: Buffer.from(body).toString("latin1") };
  exchanges.push(record);
  return record;
}

/** A response to the admin's own browser must not carry any of these. */
let ADMIN_SECRETS = [];
// The origin's address is not a credential — the box's vault stores it in the clear precisely so
// an operator can read it — but a *viewer* must never learn which server a premium channel is
// pulled from, so anything a viewer could have read is held to the stricter list.
let BROWSER_SECRETS = [];
function leaksIn(text, secrets = BROWSER_SECRETS) {
  return secrets.filter((secret) => typeof secret === "string" && secret && text.includes(secret));
}

/**
 * `cloudflared`'s quick tunnel: an ephemeral https address in front of the box's loopback port.
 * The address only exists once the edge has assigned one, which is why the box cannot be
 * configured until this resolves — and why a named tunnel is what a deployment has to use.
 */
function startQuickTunnel(port) {
  return new Promise((resolve, reject) => {
    let log = "";
    let settled = false;
    const child = spawn(CF_BIN, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error(`${message}\n${log.slice(-600)}`));
    };
    const onData = (chunk) => {
      log += String(chunk);
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      resolve({ url: match[0], child });
    };
    const timer = setTimeout(() => fail(`no tunnel address after ${TUNNEL_WAIT_MS / 1000}s`), TUNNEL_WAIT_MS);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => fail(`cloudflared could not be started (${error.name}). Install it or pass --cloudflared=<path>.`));
    child.on("exit", (code) => fail(`cloudflared exited with ${String(code)} before assigning an address`));
  });
}

/**
 * Fail before the tunnel is up rather than after: a box that silently could not bind its port
 * leaves a public address sitting in front of whatever *was* listening there, and every gate
 * below would then be measuring a different run. `cloudflared` is pointed at a port number, not
 * at a process, so the ports have to be provably free first.
 */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function assertPortsFree(ports) {
  const busy = [];
  for (const port of ports) if (!(await portIsFree(port))) busy.push(port);
  if (busy.length > 0) {
    throw new Error(
      `port(s) ${busy.join(", ")} already have something listening on 127.0.0.1 — a previous kept run? ` +
        `Find it with \`netstat -ano | grep :<port>\` and kill that PID, or pass --port/--app to move this run`
    );
  }
}

/**
 * A freshly assigned `trycloudflare.com` hostname is not routable the instant `cloudflared`
 * prints it: the edge has to register the route, and a request that arrives first fails at the
 * transport rather than at the box. Without this wait the very first admin push is a false
 * "the stream box could not be reached".
 */
async function waitForTunnel(url) {
  const deadline = Date.now() + TUNNEL_WAIT_MS;
  let last = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) return { ms: Date.now() - (deadline - TUNNEL_WAIT_MS) };
      last = `status ${res.status}`;
    } catch (error) {
      last = `${error.name}: ${error.cause?.message ?? error.message}`;
    }
    await new Promise((sleep) => setTimeout(sleep, 1_500));
  }
  throw new Error(`the tunnel never became routable at ${url} within ${TUNNEL_WAIT_MS / 1000}s — last error: ${last}`);
}

/**
 * Polls until a condition reports itself done, and reports how long that took.
 *
 * A gate that only says "it worked" cannot tell a four-second blip from an outage that cleared
 * at the far edge of the trust window, and those are different facts about the same run — so
 * the wait is measured and its duration goes into the gate's own name.
 */
async function waitFor(check, timeoutMs, everyMs = 1_000) {
  const started = Date.now();
  let last = { done: false, detail: "no attempt made" };
  while (Date.now() - started < timeoutMs) {
    last = await check();
    if (last.done) return { ok: true, ms: Date.now() - started, detail: last.detail };
    await new Promise((sleep) => setTimeout(sleep, everyMs));
  }
  return { ok: false, ms: Date.now() - started, detail: last.detail };
}

/**
 * Where the stream box lives. An override wins; otherwise the suite layout is resolved relative to
 * this project, so no machine's directory names appear here. Both spellings of the sibling are
 * tried, and a directory that is not built is reported by the caller rather than guessed past.
 */
function findProxyDir() {
  const explicit = opt.proxy ?? process.env.SOLUPLAY_PROXY_DIR;
  if (explicit) return path.resolve(explicit);
  const candidates = [
    path.join(ROOT, "..", "ProxyServer"),
    path.join(ROOT, "..", "soluplay-stream-proxy"),
  ];
  const built = candidates.find((dir) => fs.existsSync(path.join(dir, "dist", "server.js")));
  return path.resolve(built ?? candidates[0]);
}

async function main() {
  const proxyDir = findProxyDir();
  const stackPath = path.join(proxyDir, "scripts", "local-stack.mjs");
  if (!fs.existsSync(path.join(proxyDir, "dist", "server.js"))) {
    throw new Error(
      `the stream box is not built at ${proxyDir} — run \`npm run build\` there, or point SOLUPLAY_PROXY_DIR at the checkout, then re-run this`
    );
  }
  const { createLocalStack } = await import(pathToFileURL(stackPath).href);

  const storeFile = path.join(ROOT, "data", "premium-store.json");
  const storeBefore = fs.existsSync(storeFile) ? fs.readFileSync(storeFile) : null;
  // The Direct HLS catalogue's own file, fingerprinted rather than read: this run links fixture
  // cards at channels from it, and the only proof that a link is a name rather than an edit is
  // that the file is the same bytes when the run ends as it was before the first write.
  const catalogueFile = path.join(ROOT, "data", "store.json");
  const fingerprint = (file) =>
    fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "<no such file>";
  const catalogueBefore = fingerprint(catalogueFile);

  section("boot");
  // Which checkout the run resolved on its own, so a pass says where the box was and a
  // refusal to find it is not left to be guessed at.
  say(`  the stream box is the checkout at ${proxyDir}`);
  // Only the two addresses something else can be reached at are asserted. The fixture origin
  // below deliberately walks to the next free port, because its address is only ever written
  // into the source line this run creates.
  await assertPortsFree([PROXY_PORT, APP_PORT]);
  const origin = createRawOrigin();
  // One above the box's port, and it never lands on the box's own port: a leak check that
  // compares addresses has to be able to tell them apart.
  const originBase = await origin.start(PROXY_PORT + 1);
  const originHost = originBase.slice("http://".length);
  const sourceUrl = `${originBase}/secure/${PATH_TOKEN}/index.m3u8?token=${QUERY_TOKEN}`;
  ADMIN_SECRETS = [PATH_TOKEN, QUERY_TOKEN, WANT_UA, WANT_REFERER, sourceUrl];
  BROWSER_SECRETS = [...ADMIN_SECRETS, originHost];

  let tunnel = null;
  if (opt.tunnel) {
    section("public transport");
    tunnel = await startQuickTunnel(PROXY_PORT);
    say(`  the box will be reached from outside at ${tunnel.url}`);
  }

  const stackOptions = {
    port: PROXY_PORT,
    register: false,
    window: WINDOW,
    segmentMs: SEGMENT_MS,
    // The address the box believes viewers come to it at. Signed URLs are built from this, so
    // with a tunnel up the player is handed the public address and not the loopback one.
    ...(tunnel ? { publicBase: tunnel.url } : {}),
    // The gate the site will actually run under, named here so the premium path is measured
    // against a gate that refuses rather than a wildcard that accepts everything.
    siteOrigins: APP_ORIGIN,
    siteGuardMode: "strict",
  };
  // A `let`, because one section below stops the box on purpose and brings it back: that is the
  // only way to measure a readiness gate against a real outage rather than a stubbed answer.
  let stack = await createLocalStack(stackOptions);

  if (tunnel) {
    const ready = await waitForTunnel(tunnel.url);
    say(`  the public edge answered the box in ${ready.ms} ms of trying`);
  }

  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(
    process.execPath,
    [nextBin, "start", "-H", "127.0.0.1", "-p", String(APP_PORT)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        // Blank, so the tier falls back to its own local store. `next start` also reads
        // .env.local, and dotenv never overwrites a variable that is already defined.
        MONGODB_URI: "",
        ADMIN_SECRET_KEY: HARNESS_ADMIN_KEY,
        PROXY_BASE_URL: stack.base,
        PROXY_ADMIN_TOKEN: stack.adminToken,
        PROXY_APP_TOKEN: stack.appToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const serverLog = [];
  child.stdout?.on("data", (chunk) => serverLog.push(String(chunk)));
  child.stderr?.on("data", (chunk) => serverLog.push(String(chunk)));
  let childExit = null;
  child.on("exit", (code, signal) => {
    childExit = signal ?? code;
  });

  const site = `${APP_ORIGIN}`;
  const admin = { "x-admin-secret": HARNESS_ADMIN_KEY };
  const getJson = async (url, headers) => {
    const res = await fetch(url, { headers: clean(headers ?? {}), cache: "no-store", signal: AbortSignal.timeout(25_000) });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    return { res, json, text };
  };
  const postJson = async (url, body, headers) => {
    const res = await fetch(url, {
      method: "POST",
      headers: clean({ ...(headers ?? {}), "content-type": "application/json" }),
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    return { res, json, text };
  };

  // Declared out here because a kept run prints the page it left behind for the browser to open.
  let channelId = "";

  try {
    // Wait for the site to answer at all: `next start` is not ready the moment it is spawned.
    let ready = false;
    for (let attempt = 0; attempt < 120 && !ready; attempt++) {
      if (childExit !== null) throw new Error(`the site exited before it was ready (${childExit})`);
      try {
        const probe = await getJson(`${site}/api/admin/premium/channels`, {});
        if (probe.res.status === 401) ready = true;
      } catch {
        // Not listening yet.
      }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    gate("the built site answers on its own port", ready);
    if (!ready) throw new Error("the site never came up, so nothing below can be measured");

    /* ---------------- the never-touch-production gate ---------------- */

    const first = await getJson(`${site}/api/admin/premium/channels`, admin);
    gate("this run is on the tier's local store, not a real database", first.json.dbMode === "local", `dbMode ${first.json.dbMode}`);
    if (first.json.dbMode !== "local") {
      throw new Error("refusing to write: the site connected to a real database");
    }

    /* ---------------- the admin gate ---------------- */

    section("the admin gate");
    const wrongKey = await getJson(`${site}/api/admin/premium/channels`, { "x-admin-secret": "wrong-key" });
    gate("a wrong admin key is refused", wrongKey.res.status === 401, `status ${wrongKey.res.status}`);
    const noKey = await getJson(`${site}/api/admin/premium/channels`, {});
    gate("and so is no key at all", noKey.res.status === 401, `status ${noKey.res.status}`);

    /* ---------------- a row with nothing on the box ---------------- */

    section("a premium row starts as a name, not a stream");
    const created = await fetch(`${site}/api/admin/premium/channels`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ name: "E2E Premium One", category: "Sports", sortOrder: 7, note: "harness row" }),
      cache: "no-store",
    });
    const createdJson = await created.json();
    channelId = String(createdJson.channel?._id ?? "");
    gate("the row is created with no box handle", created.status === 200 && createdJson.success === true && channelId !== "" && createdJson.channel.proxyChannelKey === "", `${created.status} ${channelId}`);
    if (!channelId) throw new Error("no row id, so the rest cannot be measured");
    const expectedKey = `prem-${channelId.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`.slice(0, 64);

    const beforePush = await getJson(`${site}/api/premium/${channelId}/play`, {});
    gate("a viewer cannot ask for a stream the box has never been given", beforePush.res.status === 409, `${beforePush.res.status} ${beforePush.json.error}`);

    const pageBefore = await grab(`${site}/premium/${channelId}`);
    gate("the premium watch page renders before there is anything to play", pageBefore.status === 200 && pageBefore.text.includes("Premium"), `status ${pageBefore.status}`);

    /* ---------------- the push ---------------- */

    section("pushing a source to the box");
    const badPush = await fetch(`${site}/api/admin/premium/channels/${channelId}/push`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ sourceUrl: "ftp://host/index.m3u8" }),
      cache: "no-store",
    });
    const badPushJson = await badPush.json();
    gate("a line that is not an http(s) URL never reaches the box", badPush.status === 400 && /Source URL/.test(String(badPushJson.error)), `${badPush.status} ${badPushJson.error}`);

    const pushed = await fetch(`${site}/api/admin/premium/channels/${channelId}/push`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ sourceUrl, userAgent: WANT_UA, referer: WANT_REFERER }),
      cache: "no-store",
    });
    const pushedJson = await pushed.json();
    const pushText = JSON.stringify(pushedJson);
    gate("the box takes the source and the row keeps its handle", pushed.status === 200 && pushedJson.success === true && pushedJson.channelKey === expectedKey, `${pushed.status} ${pushText.slice(0, 160)}`);
    gate("and a timestamp the admin can see", typeof pushedJson.pushedAt === "string" && !Number.isNaN(Date.parse(pushedJson.pushedAt)), String(pushedJson.pushedAt));
    gate("nothing the push answers carries the line or its headers", leaksIn(pushText).length === 0, JSON.stringify(leaksIn(pushText)));

    const rowsAfterPush = await getJson(`${site}/api/admin/premium/channels`, admin);
    const row = (rowsAfterPush.json.premiumChannels ?? []).find((r) => r._id === channelId) ?? {};
    gate("this database keeps no copy of the source line", row.sourceUrl === "" && row.headers?.userAgent === "" && row.headers?.referer === "", JSON.stringify({ sourceUrl: row.sourceUrl, headers: row.headers }));
    gate("and it does keep the handle and when it travelled", row.proxyChannelKey === expectedKey && typeof row.proxyPushedAt === "string", JSON.stringify({ key: row.proxyChannelKey, at: row.proxyPushedAt }));

    const boxChannels = await getJson(`${stack.base}/admin/channels`, { authorization: `Bearer ${stack.adminToken}` });
    const boxRow = (boxChannels.json.channels ?? []).find((c) => c.channelKey === expectedKey);
    gate("the box lists the channel it was filed under", boxRow?.kind === "hls" && boxRow?.streamId === "", JSON.stringify(boxRow ?? boxChannels.json).slice(0, 200));
    const boxProviders = await getJson(`${stack.base}/admin/providers`, { authorization: `Bearer ${stack.adminToken}` });
    const providerRow = (boxProviders.json.providers ?? []).find((p) => p.providerId === expectedKey);
    gate("the vault marks the lane as one that carries its own headers", providerRow?.kind === "hls" && providerRow?.ownHeaders === true, JSON.stringify(providerRow ?? {}).slice(0, 200));
    const boxListings = JSON.stringify(boxProviders.json) + JSON.stringify(boxChannels.json);
    gate("and neither listing prints the credential or the headers", leaksIn(boxListings, ADMIN_SECRETS).length === 0, JSON.stringify(leaksIn(boxListings, ADMIN_SECRETS)));

    const repushed = await fetch(`${site}/api/admin/premium/channels/${channelId}/push`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ sourceUrl, userAgent: WANT_UA, referer: WANT_REFERER }),
      cache: "no-store",
    });
    const repushedJson = await repushed.json();
    gate("pushing the same channel again updates rather than fails", repushed.status === 200 && repushedJson.success === true, `${repushed.status} ${JSON.stringify(repushedJson).slice(0, 160)}`);

    /* ---------------- the board ---------------- */

    section("what a viewer is allowed to see");
    // The match every gate below enters, so a card's teams stay the ones the outage section
    // reads back off the board.
    const fixtureBase = {
      sport: "football",
      teamA: "E2E United",
      teamB: "E2e City",
      competition: "Harness Cup",
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      durationMinutes: 120,
    };
    const fixtureRes = await fetch(`${site}/api/admin/fixtures`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ ...fixtureBase, channels: [{ channelId, sourceType: "secured" }] }),
      cache: "no-store",
    });
    const fixtureJson = await fixtureRes.json();
    const fixtureId = String(fixtureJson.fixture?._id ?? "");
    gate("a live match can be entered against that channel", fixtureRes.status === 200 && fixtureId !== "", `${fixtureRes.status}`);
    const publishRes = await fetch(`${site}/api/admin/fixtures/${fixtureId}`, {
      method: "PATCH",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ visible: true }),
      cache: "no-store",
    });
    gate("and published on its own switch", publishRes.status === 200 && (await publishRes.json()).fixture?.visible === true);

    const board = await getJson(`${site}/api/fixtures`, {});
    const card = (board.json.fixtures ?? []).find((f) => f.id === fixtureId) ?? {};
    gate("the card appears with a link to the premium watch page", card.watchPath === `/premium/${channelId}`, JSON.stringify({ watchPath: card.watchPath }));
    gate("the card names the channel but no server", leaksIn(board.text).length === 0, JSON.stringify(leaksIn(board.text)));

    /* ---------------- a card's linked channels ---------------- */

    // Phase 1's own contract, measured over HTTP: an editor is offered channels from both tiers,
    // a card stores each of them as an id plus the tier it came from, and a reference that is
    // malformed, unknown or carrying more than those two keys is refused without being stored.
    section("linking channels from both tiers");
    const refText = (list) => (list ?? []).map((ref) => `${ref.sourceType}:${ref.channelId}`).join(",");
    const OPTION_KEYS = ["category", "channelId", "logoUrl", "name", "sourceType"];

    const sources = await getJson(`${site}/api/admin/fixtures/sources`, admin);
    const directOptions = sources.json.direct ?? [];
    const securedOptions = sources.json.secured ?? [];
    gate(
      "the editor is offered channels from both tiers",
      sources.res.status === 200 &&
        sources.json.success === true &&
        directOptions.length > 0 &&
        securedOptions.some((option) => option.channelId === channelId),
      `${sources.res.status} — ${directOptions.length} direct, ${securedOptions.length} secured`
    );
    const optionKeys = [...new Set([...directOptions, ...securedOptions].flatMap((option) => Object.keys(option)))];
    gate(
      "and an option is only ever an id, a source, a name, a category and a logo",
      optionKeys.length > 0 && optionKeys.every((key) => OPTION_KEYS.includes(key)),
      JSON.stringify(optionKeys)
    );
    gate("the offer carries no source line, no header and no token", leaksIn(sources.text).length === 0, JSON.stringify(leaksIn(sources.text)));
    const noKeySources = await getJson(`${site}/api/admin/fixtures/sources`, {});
    gate("and it is not a channel list the public can read", noKeySources.res.status === 401, `${noKeySources.res.status}`);

    const directRef = directOptions[0] ?? {};
    const mixed = await postJson(
      `${site}/api/admin/fixtures`,
      { ...fixtureBase, teamA: "Mixed United", teamB: "Mixed City", channels: [{ channelId, sourceType: "secured" }, { channelId: directRef.channelId, sourceType: "direct" }] },
      admin
    );
    const mixedId = String(mixed.json.fixture?._id ?? "");
    const mixedRefs = refText(mixed.json.fixture?.channels);
    gate("a card can hold a secured channel and a direct channel at once", mixed.res.status === 200 && mixedRefs.split(",").length === 2, `${mixed.res.status} ${mixedRefs}`);
    gate("and it keeps both, in the order they were picked, each with its own source", mixedRefs === `secured:${channelId},direct:${directRef.channelId}`, mixedRefs);

    const cardsBefore = (await getJson(`${site}/api/admin/fixtures`, admin)).json.count;
    const REFUSALS = [
      ["a source the tier does not know", { channels: [{ channelId, sourceType: "premium" }] }, /Linked channel 1 source must be one of: direct, secured/],
      ["a reference that also carries a source line", { channels: [{ channelId, sourceType: "secured", sourceUrl }] }, /Linked channel 1 carries sourceUrl — a linked channel stores only an id and a source/],
      ["a direct id that is not a catalogue id", { channels: [{ channelId: "prem-e2e-not-a-catalogue-id", sourceType: "direct" }] }, /Linked channel 1 id must be a 24-character catalogue channel id/],
      ["the single-channel field this tier used to store", { premiumChannelId: channelId }, /Linked channel is now sent as a channels list with a source for each entry/],
      ["a secured channel nobody entered", { channels: [{ channelId: "pc-never-entered", sourceType: "secured" }] }, /Linked channel pc-never-entered is not a channel in the secured list/],
      ["a well-formed direct id that is not on the catalogue", { channels: [{ channelId: "0123456789abcdef01234567", sourceType: "direct" }] }, /Linked channel 0123456789abcdef01234567 is not a channel on the direct catalogue/],
    ];
    const refusals = [];
    for (const [name, extra, expect] of REFUSALS) {
      const attempt = await postJson(`${site}/api/admin/fixtures`, { ...fixtureBase, teamA: "Refused", teamB: "United", ...extra }, admin);
      const error = String(attempt.json.error ?? "");
      refusals.push({ name, status: attempt.res.status, matched: expect.test(error), error });
    }
    gate("six bad references are all refused", refusals.every((row) => row.status === 400), JSON.stringify(refusals.map((row) => `${row.name}=${row.status}`)));
    gate("and each names the reference and says what was wrong with it", refusals.every((row) => row.matched), JSON.stringify(refusals.filter((row) => !row.matched)));
    gate("a refusal never echoes the line it refused", leaksIn(refusals.map((row) => row.error).join(" "), ADMIN_SECRETS).length === 0, JSON.stringify(leaksIn(refusals.map((row) => row.error).join(" "), ADMIN_SECRETS)));
    const cardsAfterRefusals = (await getJson(`${site}/api/admin/fixtures`, admin)).json.count;
    gate("none of those writes stored a card", cardsAfterRefusals === cardsBefore, `${cardsBefore} → ${cardsAfterRefusals}`);

    const reLinked = await fetch(`${site}/api/admin/fixtures/${mixedId}`, {
      method: "PATCH",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ channels: [{ channelId: directRef.channelId, sourceType: "direct" }] }),
      cache: "no-store",
    });
    const reLinkedJson = await reLinked.json();
    gate("an edit replaces the card's whole list rather than merging into it", reLinked.status === 200 && refText(reLinkedJson.fixture?.channels) === `direct:${directRef.channelId}`, `${reLinked.status} ${refText(reLinkedJson.fixture?.channels)}`);

    const storedCards = (await getJson(`${site}/api/admin/fixtures`, admin)).json.fixtures ?? [];
    const storedMixed = storedCards.find((row) => row._id === mixedId) ?? {};
    gate("the card the edit left behind is still readable, with its schedule intact", storedMixed.teamA === "Mixed United" && storedMixed.competition === "Harness Cup" && refText(storedMixed.channels) === `direct:${directRef.channelId}`, JSON.stringify({ teamA: storedMixed.teamA, channels: storedMixed.channels }));
    gate("and reading the board back never prints a source line for any card", leaksIn(JSON.stringify(storedCards)).length === 0, JSON.stringify(leaksIn(JSON.stringify(storedCards))));

    // Phase 2's contract, measured on the same card the writes just left: a match that names
    // channels from both tiers offers every one of them and lets the viewer pick, while a match
    // with one thing to offer still taps straight through. It is published here because until now
    // this run only ever put one channel on a card.
    const chooserRefs = [
      { channelId, sourceType: "secured" },
      { channelId: directRef.channelId, sourceType: "direct" },
    ];
    const chooserEdit = await fetch(`${site}/api/admin/fixtures/${mixedId}`, {
      method: "PATCH",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ channels: chooserRefs, visible: true }),
      cache: "no-store",
    });
    gate(
      "both channels go back on the card and it is published",
      chooserEdit.status === 200 &&
        refText((await chooserEdit.json()).fixture?.channels) ===
          `secured:${channelId},direct:${directRef.channelId}`,
      `${chooserEdit.status}`
    );

    const chooserBoard = await getJson(`${site}/api/fixtures`, {});
    const chooserCard = (chooserBoard.json.fixtures ?? []).find((row) => row.id === mixedId) ?? {};
    gate(
      "a card with two channels to offer is on the board and is not one link",
      (chooserBoard.json.fixtures ?? []).length >= 2 &&
        chooserCard.watchPath === null &&
        (chooserCard.choices ?? []).length === 2,
      JSON.stringify({ watchPath: chooserCard.watchPath, choices: chooserCard.choices })
    );
    const choicePaths = (chooserCard.choices ?? []).map((choice) => choice.watchPath);
    gate(
      "each choice names the tier it came from and the route that tier already answers on",
      choicePaths.includes(`/premium/${channelId}`) &&
        choicePaths.includes(`/watch/${directRef.channelId}`) &&
        (chooserCard.choices ?? []).every((choice) =>
          /^\/(premium|watch)\//.test(String(choice.watchPath ?? ""))
        ),
      JSON.stringify(choicePaths)
    );
    gate(
      "every choice on it is offered, because the box is up and both rows are ready",
      (chooserCard.choices ?? []).every((choice) => choice.state === "ready"),
      JSON.stringify((chooserCard.choices ?? []).map((choice) => choice.state))
    );
    gate(
      "and a chooser's payload names channels only: no line, no header, no token, no host",
      leaksIn(chooserBoard.text).length === 0 &&
        !chooserBoard.text.includes(stack.base),
      JSON.stringify(leaksIn(chooserBoard.text))
    );

    // The card stays published for the rest of the run, so the outage below is measured against a
    // card that has a direct channel on it as well as a secured one.

    /* ---------------- sign and play ---------------- */

    section("the handshake and playback");
    const play = await getJson(`${site}/api/premium/${channelId}/play`, {});
    const entryUrl = String(play.json.entryUrl ?? "");
    const entry = new URL(entryUrl);
    gate("the site signs nothing itself — the box's answer is the URL", play.res.status === 200 && entryUrl.startsWith(`${stack.base}/`) && entry.searchParams.has("t"), `${play.res.status} ${entryUrl.slice(0, 80)}`);
    gate("and it expires", Number(play.json.expiresAt) > Date.now(), String(play.json.expiresAt));
    gate("the play response carries no credential of its own", leaksIn(play.text).length === 0, JSON.stringify(leaksIn(play.text)));
    gate("no-store on a signed URL", (play.res.headers.get("cache-control") ?? "").includes("no-store"), String(play.res.headers.get("cache-control")));
    if (!entryUrl) throw new Error("no entry URL, so playback cannot be measured");

    const signedToken = entry.searchParams.get("t") ?? "";
    const watchPage = await grab(`${site}/premium/${channelId}`);
    gate(
      "the watch page HTML arrives with no signed URL in it — the player asks for one",
      watchPage.status === 200 &&
        signedToken.length > 0 &&
        !watchPage.text.includes(signedToken) &&
        !watchPage.text.includes("/live/") &&
        leaksIn(watchPage.text).length === 0,
      JSON.stringify({ status: watchPage.status, leaks: leaksIn(watchPage.text) })
    );

    const manifest = await grab(entryUrl, { origin: APP_ORIGIN, referer: `${APP_ORIGIN}/premium/${channelId}` });
    gate("the viewer's player can open it through the site gate", manifest.status === 200 && manifest.text.includes("#EXTM3U"), `status ${manifest.status}: ${manifest.text.slice(0, 200)}`);
    if (manifest.status !== 200) {
      // Whatever the box said, the two places it could have gone wrong are the origin's log of
      // what it was asked for and its own health answer.
      say(`  note: origin log — ${origin.log().slice(-8).join("  |  ") || "(the origin was never reached)"}`);
      const health = await getJson(`${stack.base}/healthz`, {});
      say(`  note: /healthz — ${JSON.stringify(health.json).slice(0, 400)}`);
      const boxChannel = await getJson(`${stack.base}/admin/channels`, { authorization: `Bearer ${stack.adminToken}` });
      say(`  note: box channels — ${JSON.stringify(boxChannel.json.channels ?? []).slice(0, 400)}`);
    }
    let lines = playlistLines(manifest.text);
    if (lines.some((line) => line.includes("master.m3u8"))) {
      const level = await grab(new URL(lines[0], entryUrl).href, { origin: APP_ORIGIN });
      lines = playlistLines(level.text);
      gate("and a master resolves to the held window", lines.length === WINDOW, `${lines.length} line(s)`);
    }
    gate("the published playlist names no origin and no token", leaksIn(manifest.text).length === 0, JSON.stringify(leaksIn(manifest.text)));

    const segmentUrls = lines.map((line) => new URL(line, entryUrl).href);
    const segments = [];
    for (const url of segmentUrls) {
      segments.push(await grab(url, { origin: APP_ORIGIN, range: `bytes=0-${SEGMENT_BYTES - 1}` }));
    }
    gate("every published segment plays with its own bytes", segments.every((res, index) => (res.status === 200 || res.status === 206) && res.body[0] === ((seqOf(new URL(segmentUrls[index]).pathname) % 256 + 256) % 256) && res.body.length === SEGMENT_BYTES), segments.map((res, index) => `${seqOf(new URL(segmentUrls[index]).pathname)}: ${res.status}/${res.body.length}B first=${res.body[0]} ${res.status >= 400 ? res.text.slice(0, 80) : ""}`).join(" | "));
    gate("and none of them leaks the source", leaksIn(segments.map((res) => res.text).join("")).length === 0);

    // Measured after a viewer has read the lane, because that is when an operator would ask.
    const probe = await postJson(`${stack.base}/admin/channels/${expectedKey}/probe`, {}, { authorization: `Bearer ${stack.adminToken}` });
    gate("the operator can still see which source the lane reads", probe.res.status === 200 && probe.json.ok === true && /<- hls \S+\/\*\*\*\/index\.m3u8/.test(String(probe.json.window?.source ?? "")), `${probe.res.status} via ${probe.json.via}: ${JSON.stringify(probe.json).slice(0, 220)}`);
    gate("and its report prints no credential", leaksIn(JSON.stringify(probe.json), ADMIN_SECRETS).length === 0, JSON.stringify(leaksIn(JSON.stringify(probe.json), ADMIN_SECRETS)));

    const foreign = await grab(entryUrl, { origin: FOREIGN_ORIGIN });
    gate("an off-site embed of the premium entry is refused", foreign.status === 403 && foreign.text.includes("origin_not_allowed"), `status ${foreign.status}`);
    const bare = await grab(entryUrl, {});
    gate("a request that claims no site at all is refused too", bare.status === 403, `status ${bare.status}`);
    const unsigned = await grab(`${stack.base}${entry.pathname}`, { origin: APP_ORIGIN });
    gate("the entry path without its token is refused", unsigned.status === 403 && /token_/.test(unsigned.text), `status ${unsigned.status}`);
    const tampered = await grab(`${stack.base}${entry.pathname}${entry.search.replace(/t=[^&]*/, "t=00000000")}`, { origin: APP_ORIGIN });
    gate("and a tampered token is refused", tampered.status === 403, `status ${tampered.status}`);

    /* ---------------- what actually reached the origin ---------------- */

    section("the origin's own log");
    const reads = origin.seen.filter((row) => row.ok);
    gate("the admin's User-Agent is the one the source is read with", reads.length > 0 && reads.every((row) => row.ua === WANT_UA), `${origin.seen.filter((row) => !row.ok && row.why === "user-agent").length} refusal(s) for a wrong agent`);
    gate("so is the Referer", reads.filter((row) => row.kind === "manifest").every((row) => row.referer === WANT_REFERER), `${reads.filter((row) => row.kind === "manifest").length} manifest read(s)`);
    gate("a relative segment line is asked for with the source's credential", origin.seen.filter((row) => row.kind === "segment" && row.ok).length > 0 && origin.seen.filter((row) => row.kind === "segment" && row.ok).every((row) => row.query === QUERY_TOKEN && row.path === `/secure/${PATH_TOKEN}/${row.path.split("/").pop()}`), JSON.stringify([...new Set(origin.seen.map((row) => `${row.path}?${row.query}`))]));
    gate("and one lane never meant two connections to the source", origin.countOf("segment") > 0, `${origin.countOf("manifest")} manifest read(s), ${origin.countOf("segment")} segment read(s)`);

    const offBox = await getJson(`${site}/api/premium/${channelId}/play`, {});
    gate("the signed URL the site hands out is the box's address, never the origin's", !offBox.json.entryUrl?.includes(originHost), String(offBox.json.entryUrl).slice(0, 80));

    /* ---------------- the same contract, over the public edge ---------------- */

    if (tunnel) {
      section("through the tunnel");
      const health = await grab(`${tunnel.url}/healthz`, {});
      const ray = health.headers.get("cf-ray");
      gate("the box answers over https with Cloudflare in front", health.status === 200 && Boolean(ray), `status ${health.status}, cf-ray ${ray}`);
      gate("and the site signed into that address, not into loopback", String(offBox.json.entryUrl).startsWith(`${tunnel.url}/`), String(offBox.json.entryUrl).slice(0, 70));

      const edge = await grab(entryUrl, { origin: APP_ORIGIN });
      const cached = String(edge.headers.get("cf-cache-status") ?? "absent");
      gate("the edge hands out no cached copy of a signed playlist", edge.status === 200 && !/hit/i.test(cached), `cf-cache-status ${cached}`);
      const edgeForeign = await grab(entryUrl, { origin: FOREIGN_ORIGIN });
      gate("a refusal still travels intact through the edge", edgeForeign.status === 403 && edgeForeign.text.includes("origin_not_allowed"), `status ${edgeForeign.status}: ${edgeForeign.text.slice(0, 80)}`);

      // Latency, not capacity: these fixture segments are 8 KB, so the number that comes out is
      // the round trip plus the edge, and a rate computed from it would flatter or damn the
      // link by accident. Capacity is what the browser leg measures with a real stream.
      //
      // The window is read again here rather than reusing `segmentUrls` from the loopback walk:
      // a live window drops its oldest segment on every target duration, and this section starts
      // seconds later, so a line from that walk can already be gone. A 410 for an evicted
      // segment is the box answering correctly, and must not be filed as a transport failure.
      const edgeManifest = await grab(entryUrl, { origin: APP_ORIGIN });
      let edgeLines = playlistLines(edgeManifest.text);
      if (edgeLines.some((line) => line.includes("master.m3u8"))) {
        const level = await grab(new URL(edgeLines[0], entryUrl).href, { origin: APP_ORIGIN });
        edgeLines = playlistLines(level.text);
      }
      gate("the window is still published over the public edge", edgeManifest.status === 200 && edgeLines.length === WINDOW, `${edgeLines.length} line(s) at status ${edgeManifest.status}`);
      const times = [];
      for (const url of edgeLines.map((line) => new URL(line, entryUrl).href)) {
        const at = Date.now();
        const res = await grab(url, { origin: APP_ORIGIN, range: `bytes=0-${SEGMENT_BYTES - 1}` });
        times.push({ ms: Date.now() - at, bytes: res.body.length, status: res.status });
      }
      gate("every segment crossed the public edge whole", times.every((row) => (row.status === 200 || row.status === 206) && row.bytes === SEGMENT_BYTES), JSON.stringify(times));
      const sorted = times.map((row) => row.ms).sort((a, b) => a - b);
      say(`  ${times.length} segments over the tunnel: median ${sorted[Math.floor(sorted.length / 2)]} ms, slowest ${sorted[sorted.length - 1]} ms (8 KB each, so this is round trip, not bandwidth)`);
    }

    /* ---------------- readiness: the box decides, not the row ---------------- */

    section("whether the box is able to serve right now");

    /**
     * The same question the site asks, answered here from the box's own health body so the two
     * readings can be compared. It is written independently of `lib/premiumReadiness.ts` on
     * purpose: if the site's verdict and the box's report ever disagree, this is the gate that
     * says which one lied.
     */
    const boxSays = async () => {
      const health = await getJson(`${stack.base}/healthz`, {});
      const vault = health.json.vault ?? {};
      return {
        status: health.res.status,
        ok: health.json.ok === true,
        appApi: health.json.appApi === true,
        vaultReady: vault.ready,
        resolvable: Number(vault.resolvable ?? 0),
        ready:
          health.res.status === 200 &&
          health.json.ok === true &&
          vault.ready === true &&
          health.json.appApi === true &&
          Number(vault.resolvable ?? 0) > 0,
      };
    };

    const boxNow = await boxSays();
    const readyBoard = await getJson(`${site}/api/fixtures`, {});
    gate(
      `the box says it can serve (${boxNow.resolvable} lane(s)) and the board agrees`,
      boxNow.ready === true && readyBoard.json.securedReady === true,
      JSON.stringify({ box: boxNow, securedReady: readyBoard.json.securedReady })
    );
    const readyPlay = await getJson(`${site}/api/premium/${channelId}/play`, {});
    gate("so a viewer asking now is given a URL", readyPlay.res.status === 200, `${readyPlay.res.status} ${readyPlay.json.error}`);

    const boardCache = String(readyBoard.res.headers.get("cache-control") ?? "");
    const maxAge = Number(/s-maxage=(\d+)/.exec(boardCache)?.[1] ?? Number.POSITIVE_INFINITY);
    gate(
      "a linked board is cached for no longer than its readiness answer stays true",
      maxAge <= 15,
      boardCache
    );
    gate(
      "readiness reaches a viewer as one boolean, and nothing about the box",
      typeof readyBoard.json.securedReady === "boolean" &&
        !readyBoard.text.includes(stack.base) &&
        !readyBoard.text.includes("healthz") &&
        leaksIn(readyBoard.text).length === 0,
      JSON.stringify({ base: stack.base, leaks: leaksIn(readyBoard.text) })
    );

    /* ---------------- the box goes away ---------------- */

    // Every flag a client could be told about is still green at this moment: the channel is
    // active, the row still carries its handle, the fixture is still published and live. So if
    // the rail keeps linking after this, it was inferred from the row rather than measured on
    // the box — which is the failure this section exists to catch.
    section("the box goes down");
    await stack.stop();

    const offAir = await waitFor(async () => {
      try {
        const attempt = await getJson(`${site}/api/premium/${channelId}/play`, {});
        return { done: attempt.res.status === 503, detail: `${attempt.res.status} ${attempt.json.error ?? ""}` };
      } catch (error) {
        return { done: false, detail: `${error.name}: ${error.message}` };
      }
    }, 90_000);
    gate(`the play route fails closed once the box cannot answer (${offAir.ms} ms)`, offAir.ok, offAir.detail);

    const deadPlay = await getJson(`${site}/api/premium/${channelId}/play`, {});
    gate(
      "and says so as an outage, not as a dead URL handed to a player",
      deadPlay.res.status === 503 &&
        deadPlay.json.success === false &&
        !deadPlay.json.entryUrl &&
        String(deadPlay.res.headers.get("cache-control") ?? "").includes("no-store"),
      `${deadPlay.res.status} ${JSON.stringify(deadPlay.json).slice(0, 120)}`
    );

    const deadBoard = await getJson(`${site}/api/fixtures`, {});
    const deadCard = (deadBoard.json.fixtures ?? []).find((f) => f.id === fixtureId) ?? {};
    gate(
      "the board stops claiming readiness and stops being cacheable",
      deadBoard.json.securedReady === false &&
        String(deadBoard.res.headers.get("cache-control") ?? "").includes("no-store"),
      `${deadBoard.json.securedReady} ${deadBoard.res.headers.get("cache-control")}`
    );
    gate(
      "the match keeps its teams, its competition and its channel — only the link goes",
      deadBoard.res.status === 200 &&
        deadCard.teamA === "E2E United" &&
        deadCard.competition === "Harness Cup" &&
        (deadCard.choices ?? []).length === 1 &&
        deadCard.choices?.[0]?.name === "E2E Premium One" &&
        deadCard.choices?.[0]?.state === "box-offline" &&
        deadCard.watchPath === null,
      JSON.stringify(deadCard)
    );

    const deadChooser = (deadBoard.json.fixtures ?? []).find((f) => f.id === mixedId) ?? {};
    const deadDirect = (deadChooser.choices ?? []).find((c) => c.sourceType === "direct") ?? {};
    const deadSecured = (deadChooser.choices ?? []).find((c) => c.sourceType === "secured") ?? {};
    gate(
      "the box going down reaches only the choices that come from the box",
      deadChooser.watchPath === `/watch/${directRef.channelId}` &&
        deadDirect.state === "ready" &&
        deadDirect.watchPath === `/watch/${directRef.channelId}` &&
        deadSecured.state === "box-offline" &&
        deadSecured.watchPath === null,
      JSON.stringify({ watchPath: deadChooser.watchPath, direct: deadDirect, secured: deadSecured })
    );

    const rowDuringOutage = (
      ((await getJson(`${site}/api/admin/premium/channels`, admin)).json.premiumChannels ?? []).find(
        (r) => r._id === channelId
      ) ?? {}
    );
    gate(
      "while it is hidden the row is still active with its handle — the box is the only thing that changed",
      rowDuringOutage.active === true && rowDuringOutage.proxyChannelKey === expectedKey,
      JSON.stringify({ active: rowDuringOutage.active, key: rowDuringOutage.proxyChannelKey })
    );

    /* ---------------- the box comes back ---------------- */

    section("the box comes back");
    stack = await createLocalStack(stackOptions);
    // A fresh box holds nothing: the admin has to push the line again, exactly as they would
    // after a real redeploy, before the lane exists to be signed.
    const pushedAgain = await postJson(
      `${site}/api/admin/premium/channels/${channelId}/push`,
      { sourceUrl, userAgent: WANT_UA, referer: WANT_REFERER },
      admin
    );
    gate("the new box takes the source", pushedAgain.res.status === 200 && pushedAgain.json.success === true, `${pushedAgain.res.status} ${JSON.stringify(pushedAgain.json).slice(0, 140)}`);

    const backOn = await waitFor(async () => {
      try {
        const attempt = await getJson(`${site}/api/premium/${channelId}/play`, {});
        return { done: attempt.res.status === 200, detail: `${attempt.res.status} ${attempt.json.error ?? ""}` };
      } catch (error) {
        return { done: false, detail: `${error.name}: ${error.message}` };
      }
    }, 90_000);
    gate(`the rail returns only when the box answers again (${backOn.ms} ms)`, backOn.ok, backOn.detail);

    const backBoard = await getJson(`${site}/api/fixtures`, {});
    const backCard = (backBoard.json.fixtures ?? []).find((f) => f.id === fixtureId) ?? {};
    gate(
      "the card is a link again, and the box's own health answer agrees",
      backBoard.json.securedReady === true &&
        backCard.watchPath === `/premium/${channelId}` &&
        (await boxSays()).ready === true,
      JSON.stringify({ securedReady: backBoard.json.securedReady, watchPath: backCard.watchPath })
    );

    const backChooser = (backBoard.json.fixtures ?? []).find((f) => f.id === mixedId) ?? {};
    gate(
      "the chooser comes back too: two ready channels, so the card asks instead of picking",
      (backChooser.choices ?? []).every((choice) => choice.state === "ready") &&
        backChooser.watchPath === null,
      JSON.stringify({ watchPath: backChooser.watchPath, choices: backChooser.choices })
    );

    /* ---------------- retract and delete ---------------- */

    // A kept run is meant to be looked at, so it leaves the channel, its source and its fixture
    // in place; the retract/delete half of the contract is measured by the default run.
    if (!opt.keep) {
      section("taking the source back off the box");
    const retracted = await fetch(`${site}/api/admin/premium/channels/${channelId}/push`, {
      method: "DELETE",
      headers: admin,
      cache: "no-store",
    });
    const retractJson = await retracted.json();
    gate("the row survives with its handle cleared", retracted.status === 200 && retractJson.success === true && retractJson.channelKey === "", `${retracted.status} ${JSON.stringify(retractJson).slice(0, 120)}`);
    const afterRetract = await getJson(`${site}/api/admin/premium/channels`, admin);
    const retractedRow = (afterRetract.json.premiumChannels ?? []).find((r) => r._id === channelId) ?? {};
    gate("the box lane is gone, so nothing is left serving it", retractedRow.proxyChannelKey === "" && retractedRow.proxyPushedAt === null, JSON.stringify({ key: retractedRow.proxyChannelKey, at: retractedRow.proxyPushedAt }));
    const boxAfterRetract = await getJson(`${stack.base}/admin/channels`, { authorization: `Bearer ${stack.adminToken}` });
    gate("the box agrees it is gone", (boxAfterRetract.json.channels ?? []).every((c) => c.channelKey !== expectedKey), JSON.stringify((boxAfterRetract.json.channels ?? []).map((c) => c.channelKey)));
    const playAfterRetract = await getJson(`${site}/api/premium/${channelId}/play`, {});
    gate("and the viewer is told there is no stream, not given a dead URL", playAfterRetract.res.status === 409, `${playAfterRetract.res.status} ${playAfterRetract.json.error}`);
    const boardAfterRetract = await getJson(`${site}/api/fixtures`, {});
    const cardAfterRetract = (boardAfterRetract.json.fixtures ?? []).find((f) => f.id === fixtureId) ?? {};
    gate("the card that is no longer watchable stops being a link", cardAfterRetract.watchPath === null, JSON.stringify({ watchPath: cardAfterRetract.watchPath }));

    const chooserAfterRetract = (boardAfterRetract.json.fixtures ?? []).find((f) => f.id === mixedId) ?? {};
    const retractedChoice = (chooserAfterRetract.choices ?? []).find((c) => c.sourceType === "secured") ?? {};
    const directChoice = (chooserAfterRetract.choices ?? []).find((c) => c.sourceType === "direct") ?? {};
    gate(
      "the same card with a direct channel on it still offers that one, and calls the unpushed channel unpushed rather than offline",
      retractedChoice.state === "not-pushed" &&
        directChoice.state === "ready" &&
        chooserAfterRetract.watchPath === `/watch/${directRef.channelId}`,
      JSON.stringify({ watchPath: chooserAfterRetract.watchPath, retracted: retractedChoice.state, direct: directChoice.state })
    );

    const dropped = await fetch(`${site}/api/admin/fixtures/${mixedId}`, { method: "DELETE", headers: admin, cache: "no-store" });
    gate("this run's chooser card is taken off the board again", dropped.status === 200 && (await dropped.json()).success === true, `${dropped.status}`);

    /* ---------------- a row deleted while it still has a lane ---------------- */

    section("deleting a row that still has a source");
    await fetch(`${site}/api/admin/premium/channels/${channelId}/push`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ sourceUrl, userAgent: WANT_UA, referer: WANT_REFERER }),
      cache: "no-store",
    });
    const deleted = await fetch(`${site}/api/admin/premium/channels/${channelId}`, { method: "DELETE", headers: admin, cache: "no-store" });
    gate("the delete goes through", deleted.status === 200 && (await deleted.json()).success === true, `${deleted.status}`);
    const boxAfterDelete = await getJson(`${stack.base}/admin/channels`, { authorization: `Bearer ${stack.adminToken}` });
    const providersAfterDelete = await getJson(`${stack.base}/admin/providers`, { authorization: `Bearer ${stack.adminToken}` });
    gate("and it took the box's channel and its credential with it", (boxAfterDelete.json.channels ?? []).every((c) => c.channelKey !== expectedKey) && (providersAfterDelete.json.providers ?? []).every((p) => p.providerId !== expectedKey), JSON.stringify({ channels: (boxAfterDelete.json.channels ?? []).map((c) => c.channelKey), providers: (providersAfterDelete.json.providers ?? []).map((p) => p.providerId) }));

    /* ---------------- a card whose channel has been deleted ---------------- */

    // The two stores answer the same admin action with different data, and this run can only
    // measure the one it lives in: the local store clears a deleted channel's link from every card
    // that named it, so the card ends up naming no channel at all — the one state that does take a
    // match off the board. An Atlas row keeps the reference no delete removed, and its card
    // survives as a count; that shape is measured by tests/premium-fixtures.test.ts and in the
    // browser, because nothing in this run writes a fixture row behind the validator's back.
    section("a card whose channel has been deleted");
    const staleBoard = await getJson(`${site}/api/fixtures`, {});
    gate(
      "a card left naming no channel is off the board, and the deleted id appears nowhere",
      staleBoard.res.status === 200 &&
        !(staleBoard.json.fixtures ?? []).some((f) => f.id === fixtureId) &&
        !staleBoard.text.includes(channelId) &&
        leaksIn(staleBoard.text).length === 0,
      JSON.stringify({
        status: staleBoard.res.status,
        ids: (staleBoard.json.fixtures ?? []).map((f) => f.id),
        namesRow: staleBoard.text.includes(channelId),
        leaks: leaksIn(staleBoard.text),
      })
    );

    const storedAfterDelete = (
      (await getJson(`${site}/api/admin/fixtures`, admin)).json.fixtures ?? []
    ).find((row) => row._id === fixtureId) ?? {};
    gate(
      "the delete took the link, not the match: the fixture is still stored with its schedule",
      storedAfterDelete._id === fixtureId &&
        storedAfterDelete.teamA === "E2E United" &&
        storedAfterDelete.competition === "Harness Cup" &&
        (storedAfterDelete.channels ?? []).length === 0,
      JSON.stringify({ teamA: storedAfterDelete.teamA, channels: storedAfterDelete.channels })
    );

    // And a card with nothing to name can be given a link again, on the same read: what the board
    // counts comes from the references the card holds now, never from the ones it once held.
    const relinked = await fetch(`${site}/api/admin/fixtures/${fixtureId}`, {
      method: "PATCH",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ channels: [{ channelId: directRef.channelId, sourceType: "direct" }] }),
      cache: "no-store",
    });
    const relinkedBoard = await getJson(`${site}/api/fixtures`, {});
    const relinkedCard = (relinkedBoard.json.fixtures ?? []).find((f) => f.id === fixtureId) ?? {};
    gate(
      "a card linked to a channel that exists is on the board again, counting nothing",
      relinked.status === 200 &&
        relinkedCard.staleReferences === 0 &&
        (relinkedCard.choices ?? []).length === 1 &&
        relinkedCard.watchPath === `/watch/${directRef.channelId}`,
      JSON.stringify({ status: relinked.status, stale: relinkedCard.staleReferences, choices: relinkedCard.choices, watchPath: relinkedCard.watchPath })
    );
    }

    /* ---------------- the tier never touched the Direct HLS catalogue ---------------- */

    section("isolation");
    const catalogue = await getJson(`${site}/api/channels`, {});
    const catalogueText = JSON.stringify(catalogue.json);
    gate("the premium run left the Direct HLS catalogue as it found it", catalogue.res.status === 200 && !catalogueText.includes(expectedKey) && !catalogueText.includes(PATH_TOKEN), `${catalogue.res.status}`);
    gate("and no premium answer in this run named the origin", leaksIn(exchanges.map((row) => row.url).join(" ")).length === 0, JSON.stringify(leaksIn(exchanges.map((row) => row.url).join(" "))));
    gate(
      "the Direct HLS catalogue's own file is the same bytes it started as",
      fingerprint(catalogueFile) === catalogueBefore,
      `${catalogueBefore.slice(0, 16)} → ${fingerprint(catalogueFile).slice(0, 16)}`
    );
  } catch (error) {
    gate("the run completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
    if (serverLog.length > 0) say(`--- site output (last 20 lines) ---\n${serverLog.join("").split(/\r?\n/).slice(-20).join("\n")}`);
  } finally {
    if (opt.keep) {
      say(`\nkeeping both up:  site ${site}   box ${stack.base}`);
      if (channelId) {
        say(`  homepage with the fixture card: ${site}/`);
        say(`  premium watch page:             ${site}/premium/${channelId}`);
      }
      say("Ctrl-C (or a kill) to clean up.");
      await new Promise((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
    }

    if (childExit === null) child.kill();
    await stack.stop();
    await origin.stop();
    // The edge keeps its own connection to the port, so it goes down last and by name: a stray
    // quick tunnel left running would advertise a dead box to whoever found the address.
    tunnel?.child.kill();

    const storeNow = fs.existsSync(storeFile) ? fs.readFileSync(storeFile) : null;
    if (storeBefore === null) {
      if (storeNow !== null) fs.rmSync(storeFile);
      gate("the tier's local store file is back to not existing", !fs.existsSync(storeFile), storeFile);
    } else {
      fs.writeFileSync(storeFile, storeBefore);
      gate("the tier's local store file is restored byte for byte", Buffer.compare(fs.readFileSync(storeFile), storeBefore) === 0, storeFile);
    }

    const failed = gates.filter((row) => !row.ok).length;
    say(`\n${gates.length - failed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  }
}

await main();
