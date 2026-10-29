/**
 * Tests for the site's half of the box registration (`lib/boxRegistry.ts` and the route that
 * accepts one).
 *
 * Run with `npm run test:box-registry`. No box is involved: the box's own health route is a
 * stubbed `fetch`, so the rules being executed are the same ones a deployment runs against a
 * real stream box.
 *
 * The cases that matter are the ones an operator would be hurt by if they broke: an address
 * that is not a box becoming the address this site sends its box credentials to, a
 * registration that is answered as accepted and then forgotten, and a site that keeps talking
 * to a box whose address has moved.
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
  isBoxRegisterTokenValid,
  checkBoxBaseUrl,
  verifyBoxHandshake,
  registerBox,
  readRegisteredBox,
  resolveBoxAddress,
  resetBoxRegistryCache,
} = registry;

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
const REAL_REGISTER_TOKEN = process.env.BOX_REGISTER_TOKEN;
const REAL_APP_TOKEN = process.env.PROXY_APP_TOKEN;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv("PROXY_BASE_URL", REAL_BASE_URL);
  setEnv("BOX_REGISTER_TOKEN", REAL_REGISTER_TOKEN);
  setEnv("PROXY_APP_TOKEN", REAL_APP_TOKEN);
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

/** The app token a box and its site share. */
const APP_TOKEN = "the-app-token";

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
  const appToken = options.appToken ?? APP_TOKEN;
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

// --- the credential ---

test("a site with no registration token refuses every registration", () => {
  setEnv("BOX_REGISTER_TOKEN", undefined);
  assert.equal(isBoxRegisterTokenValid("anything"), false);
  assert.equal(isBoxRegisterTokenValid(null), false);
});

test("the registration token is compared the way every other secret here is", () => {
  setEnv("BOX_REGISTER_TOKEN", "correct-horse-battery-staple");
  assert.equal(isBoxRegisterTokenValid("correct-horse-battery-staple"), true);
  assert.equal(isBoxRegisterTokenValid("  correct-horse-battery-staple  "), true);
  assert.equal(isBoxRegisterTokenValid("correct-horse-battery-stapl"), false);
  assert.equal(isBoxRegisterTokenValid(""), false);
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
  const box = boxFetch();
  const good = await verifyBoxHandshake("https://box.example.com", {
    fetchImpl: box.fetchImpl,
    attempts: 1,
    appToken: APP_TOKEN,
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
    appToken: APP_TOKEN,
  });
  assert.equal(notABox.ok, false);
  assert.ok(notABox.reason, "a refusal says why");

  const silent = stubFetch(new Error("connection refused"));
  const dead = await verifyBoxHandshake("https://dead.example.com", {
    fetchImpl: silent.fetchImpl,
    attempts: 1,
    appToken: APP_TOKEN,
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
    appToken: APP_TOKEN,
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
  const box = boxFetch();
  await verifyBoxHandshake("https://box.example.com", {
    fetchImpl: box.fetchImpl,
    attempts: 1,
    appToken: APP_TOKEN,
  });

  const health = box.calls[0];
  assert.equal(health.init?.headers, undefined, "the health read must not carry a header");

  const catalogue = box.calls[1];
  const headers = (catalogue.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${APP_TOKEN}`);
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
    appToken: APP_TOKEN,
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

// --- registering ---

test("a registration is checked, proved and kept, and the site then uses that address", async () => {
  freshRegistryFile();
  setEnv("PROXY_BASE_URL", undefined);
  setEnv("BOX_REGISTER_TOKEN", "the-token");
  const box = boxFetch();

  const result = await registerBox(
    { baseUrl: "https://box.example.com/", boxId: "abc123" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: APP_TOKEN }
  );

  assert.equal(result.ok, true);
  assert.ok(!("error" in result) || result.ok);

  const stored = await readRegisteredBox();
  assert.ok(stored, "the registration was not kept");
  assert.equal(stored.boxId, "abc123");
  assert.equal(stored.baseUrl, "https://box.example.com", "the address is kept as an origin");

  const resolved = await resolveBoxAddress();
  assert.ok(resolved);
  assert.equal(resolved.baseUrl, "https://box.example.com");
  assert.equal(resolved.source, "registered");
  assert.equal(resolved.boxId, "abc123");

  // The file it was kept in is the tier's own, never the catalogue's.
  assert.ok(fs.existsSync(registryFile));
  assert.ok(!fs.existsSync(path.join(process.cwd(), "data", "store.json.tmp")));
});

test("an address that cannot be proved to be a box is never kept", async () => {
  freshRegistryFile();
  setEnv("PROXY_BASE_URL", undefined);
  const box = boxFetch({ health: { not: "a box" } });

  const result = await registerBox(
    { baseUrl: "https://elsewhere.example.com", boxId: "abc123" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: APP_TOKEN }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unverified");
  assert.equal(await readRegisteredBox(), null, "an unproved address must not be kept");
});

test("a registration that does not name the box is refused before anything is asked", async () => {
  freshRegistryFile();
  const box = boxFetch();
  const result = await registerBox(
    { baseUrl: "https://box.example.com", boxId: "" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: APP_TOKEN }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.equal(box.calls.length, 0, "a refused registration must not reach the network");
});

test("an address with a credential in it is refused before anything is asked", async () => {
  freshRegistryFile();
  const box = boxFetch();
  const result = await registerBox(
    { baseUrl: "https://user:pass@box.example.com", boxId: "abc123" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: APP_TOKEN }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.equal(box.calls.length, 0);
});

test("a deployment with no database refuses the registration rather than forgetting it", async () => {
  freshRegistryFile();
  setEnv("VERCEL", "1");
  const box = boxFetch();
  const result = await registerBox(
    { baseUrl: "https://box.example.com", boxId: "abc123" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: APP_TOKEN }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_persisted");
});

test("an address the operator configured wins over one a box registered", async () => {
  freshRegistryFile();
  setEnv("PROXY_BASE_URL", "https://configured.example.com");
  const box = boxFetch();
  await registerBox(
    { baseUrl: "https://registered.example.com", boxId: "abc123" },
    { fetchImpl: box.fetchImpl, attempts: 1, appToken: APP_TOKEN }
  );

  const resolved = await resolveBoxAddress();
  assert.ok(resolved);
  assert.equal(resolved.baseUrl, "https://configured.example.com");
  assert.equal(resolved.source, "environment");
});

test("a site with no address at all says so", async () => {
  freshRegistryFile();
  setEnv("PROXY_BASE_URL", undefined);
  assert.equal(await resolveBoxAddress(), null);
});

// --- the route ---

test("the route refuses an unauthorized call without touching the network", async () => {
  freshRegistryFile();
  setEnv("BOX_REGISTER_TOKEN", "the-token");
  const { POST } = require("../app/api/proxy/box/register/route");
  const { NextRequest } = require("next/server");

  const req = new NextRequest("http://localhost/api/proxy/box/register", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
    body: JSON.stringify({ baseUrl: "https://box.example.com", boxId: "abc123" }),
  });

  const res = await POST(req);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(await readRegisteredBox(), null, "nothing may be kept for an unauthorized call");
});

test("the route keeps a registration it proved, and answers without repeating the address", async () => {
  freshRegistryFile();
  setEnv("PROXY_BASE_URL", undefined);
  setEnv("BOX_REGISTER_TOKEN", "the-token");
  setEnv("PROXY_APP_TOKEN", APP_TOKEN);

  const { POST } = require("../app/api/proxy/box/register/route");
  const { NextRequest } = require("next/server");
  const box = boxFetch();
  const original = globalThis.fetch;
  globalThis.fetch = box.fetchImpl;

  try {
    const req = new NextRequest("http://localhost/api/proxy/box/register", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer the-token" },
      body: JSON.stringify({ baseUrl: "https://box.example.com", boxId: "abc123" }),
    });

    const res = await POST(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.box.id, "abc123");
    assert.ok(!JSON.stringify(body).includes("box.example.com"), "the answer must not repeat the address");

    const stored = await readRegisteredBox();
    assert.ok(stored);
    assert.equal(stored.baseUrl, "https://box.example.com");
  } finally {
    globalThis.fetch = original;
  }
});
