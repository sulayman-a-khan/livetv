/**
 * Tests for the site's half of the box tier (`lib/boxRegistry.ts`, `lib/boxCredentials.ts`
 * and the routes that admit, enroll and withdraw a box).
 *
 * Run with `npm run test:box-registry`. No box is involved: the box's own health route is a
 * stubbed `fetch`, so the rules being executed are the same ones a deployment runs against a
 * real stream box.
 *
 * The cases that matter are the ones an operator would be hurt by if they broke: an address
 * that is not a box becoming the address this site sends its box credentials to, a code that
 * can be replayed, a box that keeps working after the site withdrew it, and a site that
 * keeps talking to a box whose address has moved.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

// The compiled store reaches its siblings through the app's `@/` alias, which the compiler
// leaves in the emitted `require`. Point it at `.tmp-tests` so these tests load the real
// modules rather than a stand-in for them.
type NodeModuleWithHook = typeof Module & {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};
const nodeModule = Module as NodeModuleWithHook;
const originalResolve = nodeModule._resolveFilename;
const compiledRoot = path.resolve(__dirname, "..");
nodeModule._resolveFilename = function resolveAppAlias(request: string, ...rest: unknown[]) {
  if (request.startsWith("@/")) {
    return originalResolve.call(this, path.resolve(compiledRoot, request.slice(2)), ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};

// A blank URI is the shape of "this process has no database". It is cleared before anything
// is loaded, because `lib/db.ts` reads it once at load time and a database that answered
// here would take a branch these cases are not about.
delete process.env.MONGODB_URI;
delete process.env.VERCEL;

type Registry = typeof import("../lib/boxRegistry");
const registry: Registry = require("../lib/boxRegistry");
const {
  isBoxTokenValid,
  checkBoxBaseUrl,
  verifyBoxHandshake,
  registerBox,
  readRegisteredBox,
  readBox,
  listBoxes,
  createEnrollment,
  redeemEnrollment,
  revokeBox,
  currentBoxToken,
  resolveBoxAddress,
  resetBoxRegistryCache,
  toBoxRecord,
} = registry;

type Credentials = typeof import("../lib/boxCredentials");
const credentials: Credentials = require("../lib/boxCredentials");
const { deriveBoxToken, hashEnrollmentCode } = credentials;

/** Where the local registration lives while a case runs. */
let registryFile = "";

/** A fresh, empty place for the local registration, so no case can see another's. */
function freshRegistryFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freetv-box-registry-"));
  registryFile = path.join(dir, "proxy-box.json");
  process.env.BOX_REGISTRY_FILE = registryFile;
  resetBoxRegistryCache();
  return registryFile;
}

const REAL_BASE_URL = process.env.PROXY_BASE_URL;
const REAL_BOX_SECRET = process.env.PROXY_BOX_SECRET;
const REAL_ADMIN_SECRET = process.env.ADMIN_SECRET_KEY;

/** The site's one master secret. Every credential it hands a box is derived from this. */
const BOX_SECRET = "the-master-secret-this-site-holds-for-its-boxes";

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv("PROXY_BASE_URL", REAL_BASE_URL);
  setEnv("PROXY_BOX_SECRET", REAL_BOX_SECRET);
  setEnv("ADMIN_SECRET_KEY", REAL_ADMIN_SECRET);
  delete process.env.VERCEL;
  resetBoxRegistryCache();
});

/** `/healthz` as `ProxyServer/src/server.ts` answers it. */
function boxHealthBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, service: "soluplay-stream-proxy", uptimeMs: 1_000, ...overrides };
}

/** `/app/channels` as the box answers it to a caller holding the app token. */
function boxCatalogueBody(): Record<string, unknown> {
  return { ok: true, channels: [], tokenTtlMs: 3_600_000 };
}

function fakeResponse(status: number, text: string) {
  return {
    status,
    headers: { get: () => null },
    text: async () => text,
  } as unknown as Response;
}

/** The app token this site derives for one box. */
function appTokenFor(boxId: string): string {
  return deriveBoxToken(BOX_SECRET, "app", boxId);
}

/**
 * A `fetch` that answers like a box does: its health route for anybody, and its catalogue
 * only for a caller that presents the app token.
 *
 * The second rule is the box's own, and it is the reason the site's proof has two steps — so
 * the stub has it too, and a test that expects the proof to fail can make it fail.
 */
function boxFetch(
  options: { appToken?: string; health?: unknown; healthStatus?: number } = {}
): { fetchImpl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const appToken = options.appToken ?? appTokenFor("box-one");
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/healthz")) {
      const body = options.health === undefined ? boxHealthBody() : options.health;
      return fakeResponse(options.healthStatus ?? 200, JSON.stringify(body));
    }
    if (url.endsWith("/app/channels")) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.authorization !== `Bearer ${appToken}`) {
        return fakeResponse(401, JSON.stringify({ ok: false, code: "unauthorized" }));
      }
      return fakeResponse(200, JSON.stringify(boxCatalogueBody()));
    }
    return fakeResponse(404, JSON.stringify({ ok: false }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A `fetch` that answers with one thing, and records what it was asked. */
function stubFetch(reply: { status: number; body: unknown } | Error) {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    calls.push(String(input));
    if (reply instanceof Error) throw reply;
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return fakeResponse(reply.status, text);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * Issues an enrollment code for a box, without spending it.
 *
 * The box stays pending until the code is exchanged, which is the state an admin sees
 * between "here is the code" and "the box has taken it".
 */
async function issueCode(boxId: string): Promise<string> {
  const issued = await createEnrollment(boxId);
  assert.ok(issued.ok, "the enrollment was issued");
  return issued.enrollment.code;
}

/**
 * Admits a box: issues a code and exchanges it, exactly as the admin panel does.
 *
 * The box comes out enrolled, which is the only state in which the site will talk to it.
 * The code is returned so a case can check that it is spent afterwards.
 */
async function enrollBox(boxId: string): Promise<string> {
  const code = await issueCode(boxId);
  const redeemed = await redeemEnrollment({ boxId, code });
  assert.ok(redeemed.ok, "the enrollment was redeemed");
  return code;
}

// --- the credential ---

test("a site with no master secret refuses every box token", () => {
  setEnv("PROXY_BOX_SECRET", undefined);
  assert.equal(isBoxTokenValid("anything", "app", "box-one"), false);
  assert.equal(isBoxTokenValid(null, "app", "box-one"), false);
});

test("a box's token is its own, and it is not another box's token", () => {
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  const mine = appTokenFor("box-one");

  assert.equal(isBoxTokenValid(mine, "app", "box-one"), true);
  // The same bytes presented as another box's token: refused.
  assert.equal(isBoxTokenValid(mine, "app", "box-two"), false);
  // The same box, the wrong purpose: refused.
  assert.equal(isBoxTokenValid(mine, "admin", "box-one"), false);
  assert.equal(isBoxTokenValid(mine, "readonly", "box-one"), false);
});

test("the token is compared the way every other secret here is", () => {
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  const mine = appTokenFor("box-one");

  assert.equal(isBoxTokenValid(`  ${mine}  `, "app", "box-one"), true);
  assert.equal(isBoxTokenValid(mine.slice(0, -1), "app", "box-one"), false);
  assert.equal(isBoxTokenValid("", "app", "box-one"), false);
});

test("two boxes on one secret never share a token, and neither purpose shares with the other", () => {
  const app = deriveBoxToken(BOX_SECRET, "app", "box-one");
  const admin = deriveBoxToken(BOX_SECRET, "admin", "box-one");
  const other = deriveBoxToken(BOX_SECRET, "app", "box-two");

  assert.notEqual(app, admin);
  assert.notEqual(app, other);
  assert.ok(app.length >= 24, "a token is long enough for the box to accept it");
});

// --- the shape of an address ---

test("only an origin is accepted: no credential, no query, no fragment, no path", () => {
  assert.equal(checkBoxBaseUrl("https://box.example.com").ok, true);
  assert.equal(checkBoxBaseUrl("https://box.example.com/").ok, true);
  assert.equal(checkBoxBaseUrl("https://box.example.com:8443").ok, true);

  for (const bad of [
    "https://user:pass@box.example.com",
    "https://box.example.com?token=abc",
    "https://box.example.com#frag",
    "https://box.example.com/live",
    "http://box.example.com",
    "ftp://box.example.com",
    "not a url",
    "",
  ]) {
    const verdict = checkBoxBaseUrl(bad);
    assert.equal(verdict.ok, false, `${bad} was accepted`);
    assert.ok(verdict.reason, `${bad} was refused without a reason`);
  }
});

test("a deployment refuses an address that names the server's own network", () => {
  setEnv("VERCEL", "1");
  for (const bad of ["https://127.0.0.1:8080", "https://localhost:8080", "https://10.0.0.5", "https://169.254.169.254"]) {
    assert.equal(checkBoxBaseUrl(bad).ok, false, `${bad} was accepted`);
  }
  assert.equal(checkBoxBaseUrl("https://box.example.com").ok, true);
});

test("a local run may point at a box on this machine", () => {
  assert.equal(checkBoxBaseUrl("http://127.0.0.1:8080").ok, true);
  assert.equal(checkBoxBaseUrl("http://localhost:8080").ok, true);
  // Only the loopback is allowed over plain http; everything else still needs https.
  assert.equal(checkBoxBaseUrl("http://box.example.com").ok, false);
});

// --- the handshake ---

test("an address that answers as a box is accepted, and one that does not is refused", async () => {
  const token = appTokenFor("box-one");
  const box = boxFetch({ appToken: token });
  const good = await verifyBoxHandshake("https://box.example.com", {
    fetchImpl: box.fetchImpl,
    attempts: 1,
    appToken: token,
  });
  assert.equal(good.ok, true);
  assert.equal(good.service, "soluplay-stream-proxy");
  assert.equal(box.calls.length, 2, "the proof is two reads: the health route and the catalogue");
  assert.ok(box.calls[0].url.endsWith("/healthz"), "the first read is the box's own health route");
  assert.ok(box.calls[1].url.endsWith("/app/channels"), "the second read is the box's catalogue");

  const other = stubFetch({ status: 200, body: { hello: "world" } });
  const notABox = await verifyBoxHandshake("https://elsewhere.example.com", {
    fetchImpl: other.fetchImpl,
    attempts: 1,
    appToken: token,
  });
  assert.equal(notABox.ok, false);
  assert.ok(notABox.reason, "a refusal says why");

  const silent = stubFetch(new Error("connection refused"));
  const dead = await verifyBoxHandshake("https://dead.example.com", {
    fetchImpl: silent.fetchImpl,
    attempts: 1,
    appToken: token,
  });
  assert.equal(dead.ok, false);
});

test("a refusal says what went wrong, in a sentence the operator can act on", async () => {
  // The operator of a box reads this reason on the box's own screen, so it has to say what
  // happened — not the name of the error class. "TypeError" tells the operator nothing; a
  // sentence that names the failure tells them what to change.
  const failure = new TypeError("fetch failed");
  const silent = stubFetch(failure);
  const dead = await verifyBoxHandshake("https://dead.example.com", {
    fetchImpl: silent.fetchImpl,
    attempts: 1,
    appToken: appTokenFor("box-one"),
  });
  assert.equal(dead.ok, false);
  assert.ok(dead.reason, "a refusal says why");
  assert.ok(
    !/^\s*TypeError\s*$/.test(dead.reason as string),
    `the reason must not be a bare error name: ${dead.reason}`
  );
  assert.match(dead.reason as string, /could not be reached/i, "the reason says the address was not reached");
  assert.match(dead.reason as string, /fetch failed/i, "the reason carries what the machine said");
});

test("the health read asks for no credential, and the second read proves the box holds the site's token", async () => {
  const token = appTokenFor("box-one");
  const box = boxFetch({ appToken: token });
  await verifyBoxHandshake("https://box.example.com", {
    fetchImpl: box.fetchImpl,
    attempts: 1,
    appToken: token,
  });

  const health = box.calls[0];
  assert.equal(health.init?.headers, undefined, "the health read must not carry a header");

  const catalogue = box.calls[1];
  const headers = (catalogue.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${token}`);
});

test("an address that claims to be a box but does not hold the site's token is refused", async () => {
  // The name in a health body costs an impostor nothing to copy. Only the shared secret
  // says the address is this box, so an address that answers with the right name and the
  // wrong token must never be stored — it is exactly the address that would be handed the
  // site's box credentials.
  const box = boxFetch({ appToken: "a-token-this-site-does-not-hold" });
  const result = await verifyBoxHandshake("https://impostor.example.com", {
    fetchImpl: box.fetchImpl,
    attempts: 1,
    appToken: appTokenFor("box-one"),
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason, "a refusal says why");
});

test("a site that holds no app token cannot prove any address to be a box", async () => {
  const box = boxFetch();
  const result = await verifyBoxHandshake("https://box.example.com", {
    fetchImpl: box.fetchImpl,
    attempts: 1,
    appToken: "",
  });
  assert.equal(result.ok, false);
});

// --- enrolling ---

test("an enrollment hands the operator a code and keeps only its hash", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);

  const issued = await createEnrollment("box-one");
  assert.ok(issued.ok);
  assert.equal(issued.enrollment.boxId, "box-one");
  assert.ok(issued.enrollment.code.length >= 32, "the code is long enough to be a credential");
  assert.ok(issued.enrollment.expiresAt, "the code says when it stops working");

  // The file the site keeps must not carry the code itself: a dump of it cannot be
  // replayed as an enrollment.
  const stored = fs.readFileSync(registryFile, "utf8");
  assert.ok(!stored.includes(issued.enrollment.code), "the code is in the site's own store");
  assert.ok(stored.includes(hashEnrollmentCode(issued.enrollment.code)), "the hash of the code is kept");
});

test("a box name that could not be an id is refused", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);

  for (const bad of ["", "   ", "has space", "has/slash", "has.dot", "x".repeat(65)]) {
    const issued = await createEnrollment(bad);
    assert.equal(issued.ok, false, `${bad} was accepted`);
    assert.equal(issued.reason, "invalid");
  }
});

test("a code buys the box its three credentials, and only that box's", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);

  const code = await issueCode("box-one");
  const redeemed = await redeemEnrollment({ boxId: "box-one", code });
  assert.ok(redeemed.ok);
  assert.equal(redeemed.boxId, "box-one");

  assert.equal(redeemed.tokens.app, deriveBoxToken(BOX_SECRET, "app", "box-one"));
  assert.equal(redeemed.tokens.admin, deriveBoxToken(BOX_SECRET, "admin", "box-one"));
  assert.equal(redeemed.tokens.readonly, deriveBoxToken(BOX_SECRET, "readonly", "box-one"));
  assert.notEqual(redeemed.tokens.app, redeemed.tokens.admin);

  // Another box's code does not open this box's door. The box below is waiting with a
  // code of its own, so the only thing that can refuse the swap is the code itself.
  const otherCode = await issueCode("box-two");
  await issueCode("box-three");
  const crossed = await redeemEnrollment({ boxId: "box-three", code: otherCode });
  assert.equal(crossed.ok, false);
  assert.equal(crossed.reason, "refused");
});

test("a code is spent when it is redeemed and cannot be replayed", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);

  const code = await enrollBox("box-one");
  const replay = await redeemEnrollment({ boxId: "box-one", code });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "refused");
  assert.match(replay.error, /already been used/i);
});

test("a code that has expired is refused", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);

  const issued = await createEnrollment("box-one", { ttlMs: 1 });
  assert.ok(issued.ok);

  const late = await redeemEnrollment(
    { boxId: "box-one", code: issued.enrollment.code },
    { now: () => Date.now() + 60_000 }
  );
  assert.equal(late.ok, false);
  assert.match(late.error, /expired/i);
});

test("a site with no master secret issues no credential to anybody", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);

  const issued = await createEnrollment("box-one");
  assert.ok(issued.ok);
  setEnv("PROXY_BOX_SECRET", undefined);

  const redeemed = await redeemEnrollment({ boxId: "box-one", code: issued.enrollment.code });
  assert.equal(redeemed.ok, false);
  assert.equal(redeemed.reason, "refused");
});

test("a code for a box the site knows nothing about is refused", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);

  const redeemed = await redeemEnrollment({ boxId: "box-unknown", code: "whatever" });
  assert.equal(redeemed.ok, false);
  assert.equal(redeemed.reason, "refused");
});

test("an enrolled box is the box the site derives a token for", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);

  assert.equal(await currentBoxToken("app"), "", "no box, no token");

  await enrollBox("box-one");

  assert.equal(await currentBoxToken("app"), deriveBoxToken(BOX_SECRET, "app", "box-one"));
  assert.equal(await currentBoxToken("admin"), deriveBoxToken(BOX_SECRET, "admin", "box-one"));
  assert.equal(await currentBoxToken("readonly"), deriveBoxToken(BOX_SECRET, "readonly", "box-one"));
});

// --- withdrawing ---

test("a revoked box is withdrawn: no token, no address, no registration", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  setEnv("PROXY_BASE_URL", undefined);

  await enrollBox("box-one");
  const box = boxFetch({ appToken: appTokenFor("box-one") });
  const registered = await registerBox(
    { baseUrl: "https://box.example.com", boxId: "box-one" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: appTokenFor("box-one") }
  );
  assert.equal(registered.ok, true);
  assert.ok(await readRegisteredBox(), "the box is the one the site talks to");

  const revoked = await revokeBox("box-one");
  assert.ok(revoked.ok);
  assert.equal(revoked.boxId, "box-one");

  assert.equal(await readRegisteredBox(), null, "a withdrawn box is not the box the site talks to");
  assert.equal(await currentBoxToken("app"), "", "a withdrawn box has no token");
  assert.equal(await resolveBoxAddress(), null, "a withdrawn box has no address the site will use");

  const row = await readBox("box-one");
  assert.equal(row?.state, "revoked");

  // And it may not come back with the same registration.
  const again = await registerBox(
    { baseUrl: "https://box.example.com", boxId: "box-one" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: appTokenFor("box-one") }
  );
  assert.equal(again.ok, false);
  assert.equal(again.reason, "not_admitted");
});

test("a withdrawn box comes back only through a fresh enrollment", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);

  await enrollBox("box-one");
  assert.ok((await revokeBox("box-one")).ok);

  await enrollBox("box-one");

  const row = await readBox("box-one");
  assert.equal(row?.state, "enrolled");
});

test("the site knows every box it has, whatever state it is in", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);

  await enrollBox("box-one");
  await createEnrollment("box-two");
  await enrollBox("box-three");
  await revokeBox("box-three");

  const boxes = await listBoxes();
  const states = boxes.map((box) => `${box.boxId}:${box.state}`).sort();
  assert.deepEqual(states, ["box-one:enrolled", "box-three:revoked", "box-two:pending"]);
});

// --- the row as the database gives it back ---

test("a date the database kept as a date survives the read", () => {
  // The two stores disagree: the file store keeps text, the database keeps a real date.
  // Reading only text silently dropped every date of every box the site keeps in its
  // database — so the panel said an enrolled box was not enrolled, and an enrollment code
  // outlived the day it was good for.
  const enrolledAt = new Date("2026-10-30T03:36:00.000Z");
  const registeredAt = new Date("2026-10-30T03:37:00.000Z");
  const expiresAt = new Date("2026-10-31T03:35:00.000Z");

  const row = toBoxRecord({
    boxId: "box-one",
    baseUrl: "https://box.example.com",
    state: "enrolled",
    registeredAt,
    enrolledAt,
    revokedAt: null,
    enrollmentCodeHash: "hash",
    enrollmentCodeExpiresAt: expiresAt,
    enrollmentCodeUsedAt: null,
  });

  assert.equal(row.enrolledAt, enrolledAt.toISOString());
  assert.equal(row.registeredAt, registeredAt.toISOString());
  assert.equal(row.enrollmentCodeExpiresAt, expiresAt.toISOString());
  assert.equal(row.revokedAt, null);
  assert.equal(row.state, "enrolled");
});

test("the same row read as text gives the same answer", () => {
  // The file store's shape must not drift away from the database's: the same facts have to
  // come out of both, whichever store the site is running against.
  const enrolledAt = new Date("2026-10-30T03:36:00.000Z");
  const registeredAt = new Date("2026-10-30T03:37:00.000Z");

  const fromDate = toBoxRecord({
    boxId: "box-one",
    baseUrl: "https://box.example.com",
    state: "enrolled",
    registeredAt,
    enrolledAt,
  });
  const fromText = toBoxRecord({
    boxId: "box-one",
    baseUrl: "https://box.example.com",
    state: "enrolled",
    registeredAt: registeredAt.toISOString(),
    enrolledAt: enrolledAt.toISOString(),
  });

  assert.deepEqual(fromDate, fromText);
});

test("a row with no dates in it is still a row, not a broken one", () => {
  const row = toBoxRecord({ boxId: "box-two", baseUrl: "", state: "pending" });
  assert.equal(row.state, "pending");
  assert.equal(row.registeredAt, "");
  assert.equal(row.enrolledAt, null);
  assert.equal(row.enrollmentCodeExpiresAt, null);
});

test("a date that cannot be read is treated as absent", () => {
  const row = toBoxRecord({
    boxId: "box-two",
    state: "pending",
    enrolledAt: "not a date",
    enrollmentCodeExpiresAt: new Date("nonsense"),
  });
  assert.equal(row.enrolledAt, null);
  assert.equal(row.enrollmentCodeExpiresAt, null);
});

// --- registering ---

test("a box the site has not enrolled may not register an address", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  setEnv("PROXY_BASE_URL", undefined);
  const box = boxFetch();

  const result = await registerBox(
    { baseUrl: "https://box.example.com", boxId: "stranger" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: appTokenFor("stranger") }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_admitted");
  assert.equal(box.calls.length, 0, "a box that is not admitted must not reach the network");
});

test("a registration is checked, proved and kept, and the site then uses that address", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  setEnv("PROXY_BASE_URL", undefined);
  await enrollBox("box-one");
  const box = boxFetch({ appToken: appTokenFor("box-one") });

  const result = await registerBox(
    { baseUrl: "https://box.example.com/", boxId: "box-one" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: appTokenFor("box-one") }
  );

  assert.equal(result.ok, true);
  assert.ok(!("error" in result) || result.ok);

  const stored = await readRegisteredBox();
  assert.ok(stored, "the registration was not kept");
  assert.equal(stored.boxId, "box-one");
  assert.equal(stored.baseUrl, "https://box.example.com", "the address is kept as an origin");

  const resolved = await resolveBoxAddress();
  assert.ok(resolved);
  assert.equal(resolved.baseUrl, "https://box.example.com");
  assert.equal(resolved.source, "registered");
  assert.equal(resolved.boxId, "box-one");

  // The file it was kept in is the tier's own, never the catalogue's.
  assert.ok(fs.existsSync(registryFile));
  assert.ok(!fs.existsSync(path.join(process.cwd(), "data", "store.json.tmp")));
});

test("an address that cannot be proved to be a box is never kept", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  setEnv("PROXY_BASE_URL", undefined);
  await enrollBox("box-one");
  const box = boxFetch({ health: { not: "a box" } });

  const result = await registerBox(
    { baseUrl: "https://elsewhere.example.com", boxId: "box-one" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: appTokenFor("box-one") }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unverified");
  const row = await readBox("box-one");
  assert.equal(row?.baseUrl, "", "an unproved address must not be kept");
  assert.equal(await resolveBoxAddress(), null, "the site has no address to use");
});

test("a registration that does not name the box is refused before anything is asked", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  await enrollBox("box-one");
  const box = boxFetch();
  const result = await registerBox(
    { baseUrl: "https://box.example.com", boxId: "" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: appTokenFor("box-one") }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.equal(box.calls.length, 0, "a refused registration must not reach the network");
});

test("an address with a credential in it is refused before anything is asked", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  await enrollBox("box-one");
  const box = boxFetch();
  const result = await registerBox(
    { baseUrl: "https://user:pass@box.example.com", boxId: "box-one" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: appTokenFor("box-one") }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.equal(box.calls.length, 0);
});

test("a deployment with no database refuses the registration rather than forgetting it", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  setEnv("PROXY_BASE_URL", undefined);
  await enrollBox("box-one");
  setEnv("VERCEL", "1");
  const box = boxFetch();
  const result = await registerBox(
    { baseUrl: "https://box.example.com", boxId: "box-one" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: appTokenFor("box-one") }
  );
  // A deployment has no file to fall back on, so the store that holds the enrollment is
  // gone too: the site cannot admit a box it has no row for. The refusal comes one step
  // earlier than it used to, and it is the same refusal either way — the registration is
  // not answered as accepted and then forgotten.
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_admitted");
  assert.equal(await resolveBoxAddress(), null, "nothing may be remembered");
});

test("an address the operator configured wins over one a box registered", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  setEnv("PROXY_BASE_URL", "https://configured.example.com");
  await enrollBox("box-one");
  const box = boxFetch({ appToken: appTokenFor("box-one") });
  await registerBox(
    { baseUrl: "https://registered.example.com", boxId: "box-one" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: appTokenFor("box-one") }
  );

  const resolved = await resolveBoxAddress();
  assert.ok(resolved);
  assert.equal(resolved.baseUrl, "https://configured.example.com");
  assert.equal(resolved.source, "environment");
});

test("a configured address with no admitted box is an address the site will not use", async () => {
  // The site's tokens are derived for one box, so an address with no box behind it is an
  // address it cannot use — and saying otherwise would hide a missing enrollment behind a
  // present address.
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  setEnv("PROXY_BASE_URL", "https://configured.example.com");

  assert.equal(await resolveBoxAddress(), null);
});

test("a site with no address at all says so", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  setEnv("PROXY_BASE_URL", undefined);
  assert.equal(await resolveBoxAddress(), null);
});

// --- the routes ---

test("the registration route refuses a caller that is not the box it claims to be", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  await enrollBox("box-one");
  const { POST } = require("../app/api/proxy/box/register/route");
  const { NextRequest } = require("next/server");

  const req = new NextRequest("http://localhost/api/proxy/box/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer wrong-token",
      "x-box-id": "box-one",
    },
    body: JSON.stringify({ baseUrl: "https://box.example.com", boxId: "box-one" }),
  });

  const res = await POST(req);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.success, false);
  const row = await readBox("box-one");
  assert.equal(row?.baseUrl, "", "nothing may be kept for an unauthorized call");
});

test("the registration route keeps a registration it proved, and answers without repeating the address", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  setEnv("PROXY_BASE_URL", undefined);
  await enrollBox("box-one");

  const { POST } = require("../app/api/proxy/box/register/route");
  const { NextRequest } = require("next/server");
  const box = boxFetch({ appToken: appTokenFor("box-one") });
  const original = globalThis.fetch;
  globalThis.fetch = box.fetchImpl;

  try {
    const req = new NextRequest("http://localhost/api/proxy/box/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${appTokenFor("box-one")}`,
        "x-box-id": "box-one",
      },
      body: JSON.stringify({ baseUrl: "https://box.example.com", boxId: "box-one" }),
    });

    const res = await POST(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.box.id, "box-one");
    assert.ok(!JSON.stringify(body).includes("box.example.com"), "the answer must not repeat the address");

    const stored = await readRegisteredBox();
    assert.ok(stored);
    assert.equal(stored.baseUrl, "https://box.example.com");
  } finally {
    globalThis.fetch = original;
  }
});

test("the enrollment route hands the box its credentials and nothing else", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);

  const { POST: issue } = require("../app/api/admin/proxy/boxes/route");
  const { POST: redeem } = require("../app/api/proxy/box/enroll/route");
  const { NextRequest } = require("next/server");
  setEnv("ADMIN_SECRET_KEY", "the-admin-secret");

  const issued = await issue(
    new NextRequest("http://localhost/api/admin/proxy/boxes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": "the-admin-secret" },
      body: JSON.stringify({ boxId: "box-one" }),
    })
  );
  assert.equal(issued.status, 200);
  const issuedBody = await issued.json();
  assert.equal(issuedBody.success, true);
  assert.ok(issuedBody.enrollmentCode, "the code is in the answer, once");
  assert.ok(issuedBody.expiresAt, "the code says when it stops working");

  const redeemed = await redeem(
    new NextRequest("http://localhost/api/proxy/box/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boxId: "box-one", code: issuedBody.enrollmentCode }),
    })
  );
  assert.equal(redeemed.status, 200);
  const redeemedBody = await redeemed.json();
  assert.equal(redeemedBody.success, true);
  assert.equal(redeemedBody.tokens.app, deriveBoxToken(BOX_SECRET, "app", "box-one"));
  assert.equal(redeemedBody.tokens.admin, deriveBoxToken(BOX_SECRET, "admin", "box-one"));
  assert.equal(redeemedBody.tokens.readonly, deriveBoxToken(BOX_SECRET, "readonly", "box-one"));

  // The answer carries a credential, so it is never cached.
  assert.equal(redeemed.headers.get("cache-control"), "no-store");
});

test("the enrollment route refuses a wrong code", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);

  const { POST: issue } = require("../app/api/admin/proxy/boxes/route");
  const { POST: redeem } = require("../app/api/proxy/box/enroll/route");
  const { NextRequest } = require("next/server");
  setEnv("ADMIN_SECRET_KEY", "the-admin-secret");

  await issue(
    new NextRequest("http://localhost/api/admin/proxy/boxes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": "the-admin-secret" },
      body: JSON.stringify({ boxId: "box-one" }),
    })
  );

  const res = await redeem(
    new NextRequest("http://localhost/api/proxy/box/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boxId: "box-one", code: "not-the-code" }),
    })
  );
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.success, false);
});

test("the admin's box list needs the admin secret and holds no credential", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  setEnv("ADMIN_SECRET_KEY", "the-admin-secret");
  await enrollBox("box-one");

  const { GET } = require("../app/api/admin/proxy/boxes/route");
  const { NextRequest } = require("next/server");

  const refused = await GET(new NextRequest("http://localhost/api/admin/proxy/boxes"));
  assert.equal(refused.status, 401);

  const res = await GET(
    new NextRequest("http://localhost/api/admin/proxy/boxes", {
      headers: { "x-admin-secret": "the-admin-secret" },
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.count, 1);
  assert.equal(body.boxes[0].boxId, "box-one");
  assert.ok(
    !JSON.stringify(body).includes(deriveBoxToken(BOX_SECRET, "app", "box-one")),
    "the list must carry no credential"
  );
});

test("the admin can withdraw a box, and the box's own registration is refused afterwards", async () => {
  freshRegistryFile();
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  setEnv("ADMIN_SECRET_KEY", "the-admin-secret");
  await enrollBox("box-one");

  const { POST } = require("../app/api/admin/proxy/boxes/[id]/revoke/route");
  const { NextRequest } = require("next/server");

  const res = await POST(
    new NextRequest("http://localhost/api/admin/proxy/boxes/box-one/revoke", {
      method: "POST",
      headers: { "x-admin-secret": "the-admin-secret" },
    }),
    { params: { id: "box-one" } }
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.state, "revoked");

  const row = await readBox("box-one");
  assert.equal(row?.state, "revoked");
  assert.equal(await currentBoxToken("app"), "");
});
