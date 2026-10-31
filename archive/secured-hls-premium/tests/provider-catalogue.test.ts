/**
 * Tests for the site's read of one provider account's own channel list
 * (`lib/proxyControl.ts` → `readProviderCatalogue`, and the route that fronts it).
 *
 * Run with `npm run test:provider-catalogue`. No box is involved: the upstream answer is a
 * stubbed `fetch` or a local HTTP server, so the rules being executed are the ones a
 * deployment runs against a real stream box.
 *
 * Two things matter here. The first is the shape of the answer: the account's credential
 * lives in the box and nowhere else, so the only thing that may reach the browser is a list
 * of names, categories and stream ids. The second is that each way of failing is named on
 * its own — a box that is down, a box that refuses this server's credential, an account the
 * box does not hold and a provider panel that did not answer all need different things done
 * about them, so none of them is merged into "it did not work".
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

// The box registry keeps a local registration in a file. These cases are about this
// server's own configuration, so the file is pointed at a path that does not exist: the
// site then has no registered box, whatever this machine happens to hold.
const REGISTRY_FILE = path.join(os.tmpdir(), "freetv-provider-catalogue-registry", "proxy-box.json");
process.env.BOX_REGISTRY_FILE = REGISTRY_FILE;

// A blank URI is the shape of "this process has no database". It is cleared before anything
// is loaded, because `lib/db.ts` reads it once at load time.
delete process.env.MONGODB_URI;
delete process.env.VERCEL;

type Control = typeof import("../lib/proxyControl");
const control: Control = require("../lib/proxyControl");
const { readProviderCatalogue } = control;

type Registry = typeof import("../lib/boxRegistry");
const registry: Registry = require("../lib/boxRegistry");
const { resetBoxRegistryCache } = registry;

const ADMIN_SECRET = "correct-horse-battery-staple";
const BOX_SECRET = "the-master-secret-this-site-holds-for-its-boxes";
const BOX_ID = "box-under-test";
const ADMIN_TOKEN = "the-admin-token-this-site-derives-for-its-box";

/** The token the site derives for this box's admin surface. */
const DERIVED_ADMIN_TOKEN = crypto
  .createHmac("sha256", BOX_SECRET)
  .update(`soluplay-box:admin:${BOX_ID}`)
  .digest("hex");

const REAL_ADMIN_SECRET = process.env.ADMIN_SECRET_KEY;
const REAL_BASE_URL = process.env.PROXY_BASE_URL;
const REAL_BOX_SECRET = process.env.PROXY_BOX_SECRET;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fakeResponse(status: number, text: string) {
  return {
    status,
    headers: { get: () => null },
    text: async () => text,
  } as unknown as Response;
}

/** A `fetch` that answers with one reply and records every request it received. */
function stubFetch(reply: { status: number; body: unknown } | Error = { status: 200, body: { channels: [] } }) {
  const box: {
    reply: { status: number; body: unknown } | Error;
    calls: { input: string; init: RequestInit | undefined }[];
  } = { reply, calls: [] };

  const fetchImpl = (async (input: unknown, init?: unknown) => {
    box.calls.push({ input: String(input), init: init as RequestInit | undefined });
    if (box.reply instanceof Error) throw box.reply;
    const text = typeof box.reply.body === "string" ? box.reply.body : JSON.stringify(box.reply.body);
    return fakeResponse(box.reply.status, text);
  }) as unknown as typeof fetch;

  return { fetchImpl, box };
}

/**
 * Writes the one row the site keeps about a box: its name, its address and the fact that
 * it is enrolled. No credential is in it — the token is derived from the master secret.
 */
function enrolledBox(baseUrl = "https://box.example.com"): void {
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  fs.writeFileSync(
    REGISTRY_FILE,
    JSON.stringify(
      {
        boxes: [
          {
            boxId: BOX_ID,
            baseUrl,
            registeredAt: new Date().toISOString(),
            state: "enrolled",
            enrolledAt: new Date().toISOString(),
            revokedAt: null,
            enrollmentCodeHash: "",
            enrollmentCodeExpiresAt: null,
            enrollmentCodeUsedAt: null,
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
  resetBoxRegistryCache();
}

/** Removes the row, so the site holds no admitted box. */
function noBox(): void {
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ boxes: [] }, null, 2), "utf8");
  resetBoxRegistryCache();
}

// The registry file lives in the temporary directory, so it outlives one run and the next
// one would start with a box it did not enrol. It is emptied here and after every case.
noBox();

afterEach(() => {
  setEnv("ADMIN_SECRET_KEY", REAL_ADMIN_SECRET);
  setEnv("PROXY_BASE_URL", REAL_BASE_URL);
  setEnv("PROXY_BOX_SECRET", REAL_BOX_SECRET);
  noBox();
  resetBoxRegistryCache();
});

/** The catalogue as the box answers it: one channel row per stream. */
function catalogueBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    providerId: "provider-alpha",
    tookMs: 42,
    channels: [
      { streamId: "4411", name: "Alpha Sports", category: "Sports" },
      { streamId: "4412", name: "Alpha News", category: "News" },
    ],
    ...overrides,
  };
}

// --- what the site asks the box for ---

test("the catalogue read asks the box's own catalogue route, with the token in the header", async () => {
  const { fetchImpl, box } = stubFetch({ status: 200, body: catalogueBody() });

  const result = await readProviderCatalogue("Provider-Alpha", {
    baseUrl: "https://box.example.com:8443/tunnel-prefix/",
    token: ADMIN_TOKEN,
    fetchImpl,
  });

  assert.equal(result.refusal, null);
  assert.equal(result.reachable, true);
  assert.equal(result.authorized, true);
  assert.equal(result.providerId, "provider-alpha", "the provider id is matched the way the box stores it");

  assert.equal(box.calls.length, 1);
  assert.equal(
    box.calls[0].input,
    "https://box.example.com:8443/tunnel-prefix/admin/providers/provider-alpha/channels"
  );
  assert.equal(box.calls[0].init?.method, "GET");
  assert.equal(box.calls[0].init?.cache, "no-store");
  const headers = (box.calls[0].init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${ADMIN_TOKEN}`);
  assert.ok(!String(box.calls[0].input).includes(ADMIN_TOKEN), "the token must not travel in the URL");
});

test("only names, categories and ids come back from the box", async () => {
  const { fetchImpl } = stubFetch({
    status: 200,
    body: catalogueBody({
      channels: [
        { streamId: "4411", name: "Alpha Sports", category: "Sports", username: "someone", password: "s3cr3t" },
        { streamId: "4412", name: "Alpha News", category: "News" },
        { name: "A Row With No Id", category: "News" },
      ],
    }),
  });

  const result = await readProviderCatalogue("provider-alpha", {
    baseUrl: "https://box.example.com",
    token: ADMIN_TOKEN,
    fetchImpl,
  });

  assert.deepEqual(result.channels, [
    { streamId: "4411", name: "Alpha Sports", category: "Sports" },
    { streamId: "4412", name: "Alpha News", category: "News" },
  ]);
  assert.ok(!JSON.stringify(result).includes("s3cr3t"), "no credential may travel in the answer");
  assert.ok(!JSON.stringify(result).includes("someone"), "no username may travel in the answer");
});

test("a free-text name is stripped of control characters and capped", async () => {
  const { fetchImpl } = stubFetch({
    status: 200,
    body: {
      channels: [
        { streamId: "4411", name: `Alpha\u0000 Sports ${"x".repeat(200)}`, category: "S".repeat(120) },
      ],
    },
  });

  const result = await readProviderCatalogue("provider-alpha", {
    baseUrl: "https://box.example.com",
    token: ADMIN_TOKEN,
    fetchImpl,
  });

  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].name.length, 120);
  assert.equal(result.channels[0].category.length, 60);
  assert.ok(!result.channels[0].name.includes("\u0000"));
});

// --- every way this can fail ---

test("every way the box can refuse is named, not merged", async () => {
  const cases: { status: number; refusal: string }[] = [
    { status: 401, refusal: "unauthorized" },
    { status: 403, refusal: "unauthorized" },
    { status: 404, refusal: "unknown_provider" },
    { status: 502, refusal: "catalogue_unavailable" },
    { status: 500, refusal: "error" },
  ];

  for (const entry of cases) {
    const { fetchImpl } = stubFetch({ status: entry.status, body: { ok: false, code: "x", message: "no" } });
    const result = await readProviderCatalogue("provider-alpha", {
      baseUrl: "https://box.example.com",
      token: ADMIN_TOKEN,
      fetchImpl,
    });
    assert.equal(result.refusal, entry.refusal, `status ${entry.status}`);
    assert.equal(result.channels.length, 0);
    assert.equal(result.reachable, true, "a box that answered is reachable");
    assert.equal(result.authorized, entry.refusal !== "unauthorized");
  }
});

test("a box that does not answer at all is unreachable, not broken", async () => {
  const { fetchImpl } = stubFetch(new Error("the tunnel is down"));

  const result = await readProviderCatalogue("provider-alpha", {
    baseUrl: "https://box.example.com",
    token: ADMIN_TOKEN,
    fetchImpl,
  });

  assert.equal(result.refusal, "unreachable");
  assert.equal(result.reachable, false);
  assert.equal(result.channels.length, 0);
});

test("an answer that is not JSON is refused rather than half-read", async () => {
  const { fetchImpl } = stubFetch({ status: 200, body: "<html>not json</html>" });

  const result = await readProviderCatalogue("provider-alpha", {
    baseUrl: "https://box.example.com",
    token: ADMIN_TOKEN,
    fetchImpl,
  });

  assert.equal(result.refusal, "error");
  assert.equal(result.channels.length, 0);
});

test("a server with no address or no token asks the box nothing at all", async () => {
  const { fetchImpl, box } = stubFetch({ status: 200, body: catalogueBody() });

  const noAddress = await readProviderCatalogue("provider-alpha", {
    baseUrl: "",
    token: ADMIN_TOKEN,
    fetchImpl,
  });
  assert.equal(noAddress.refusal, "not_configured");

  const noToken = await readProviderCatalogue("provider-alpha", {
    baseUrl: "https://box.example.com",
    token: "",
    fetchImpl,
  });
  assert.equal(noToken.refusal, "not_configured");

  assert.equal(box.calls.length, 0, "nothing may be asked without both an address and a token");
});

test("a name that is not a provider id never reaches the box", async () => {
  const { fetchImpl, box } = stubFetch({ status: 200, body: catalogueBody() });

  for (const presented of ["", "   ", "provider alpha", "provider/alpha", "a".repeat(65)]) {
    const result = await readProviderCatalogue(presented, {
      baseUrl: "https://box.example.com",
      token: ADMIN_TOKEN,
      fetchImpl,
    });
    assert.equal(result.refusal, "error", `id ${JSON.stringify(presented)}`);
    assert.equal(result.channels.length, 0);
  }

  assert.equal(box.calls.length, 0);
});

// --- the route that fronts it ---

const nodeModule = require("node:module") as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};

/**
 * The route files import through the `@/` alias. TypeScript resolves that alias for types and
 * leaves it in the emitted JavaScript, so the resolver is pointed at the compiled output
 * before a route is required. Without this the route could not be exercised at all.
 */
function installAliasResolver(): void {
  const patched = nodeModule as { __catalogueAliasPatched?: boolean };
  if (patched.__catalogueAliasPatched) return;
  const original = nodeModule._resolveFilename;
  nodeModule._resolveFilename = (request: string, ...rest: unknown[]) => {
    const resolved =
      typeof request === "string" && request.startsWith("@/")
        ? path.join(__dirname, "..", request.slice(2))
        : request;
    return original.call(nodeModule, resolved, ...rest);
  };
  patched.__catalogueAliasPatched = true;
}

/** A box that answers one route and records what it was asked. */
async function startRecordingBox(
  reply: { status: number; body: unknown } = { status: 200, body: catalogueBody() }
) {
  const requests: { method: string; url: string; authorization?: string }[] = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: req.headers.authorization,
    });
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    hits: () => requests.length,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("the route refuses an unauthorized caller before the box is asked", async () => {
  installAliasResolver();
  const { NextRequest } = require("next/server");
  const { GET } = require("../app/api/admin/premium/providers/[id]/channels/route.js");

  setEnv("ADMIN_SECRET_KEY", ADMIN_SECRET);
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  enrolledBox();
  const box = await startRecordingBox();
  setEnv("PROXY_BASE_URL", box.url);

  const get = (headers: Record<string, string>) =>
    new NextRequest("http://localhost/api/admin/premium/providers/provider-alpha/channels", { headers });

  try {
    const refused = await GET(get({}), { params: { id: "provider-alpha" } });
    assert.equal(refused.status, 401);
    assert.equal(box.hits(), 0, "an unauthorized call must not reach the box");

    const wrong = await GET(get({ "x-admin-secret": "not-the-key" }), { params: { id: "provider-alpha" } });
    assert.equal(wrong.status, 401);
    assert.equal(box.hits(), 0, "a wrong key must not reach the box either");
  } finally {
    await box.close();
  }
});

test("the route answers an authorized caller with the account's own channel list", async () => {
  installAliasResolver();
  const { NextRequest } = require("next/server");
  const { GET } = require("../app/api/admin/premium/providers/[id]/channels/route.js");

  setEnv("ADMIN_SECRET_KEY", ADMIN_SECRET);
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);
  enrolledBox();
  const box = await startRecordingBox();
  setEnv("PROXY_BASE_URL", box.url);

  const get = () =>
    new NextRequest("http://localhost/api/admin/premium/providers/provider-alpha/channels", {
      headers: { "x-admin-secret": ADMIN_SECRET },
    });

  try {
    const allowed = await GET(get(), { params: { id: "provider-alpha" } });
    assert.equal(allowed.status, 200);

    const json = (await allowed.json()) as Record<string, unknown>;
    assert.equal(json.success, true);
    assert.equal(json.providerId, "provider-alpha");
    assert.equal(json.count, 2);
    assert.deepEqual(json.channels, [
      { streamId: "4411", name: "Alpha Sports", category: "Sports" },
      { streamId: "4412", name: "Alpha News", category: "News" },
    ]);

    assert.equal(box.hits(), 1);
    const asked = box.requests[0];
    assert.equal(asked.method, "GET");
    assert.equal(asked.url, "/admin/providers/provider-alpha/channels");
    assert.equal(asked.authorization, `Bearer ${DERIVED_ADMIN_TOKEN}`);
    assert.ok(!asked.url.includes(DERIVED_ADMIN_TOKEN), "the token must not travel in the URL");
  } finally {
    await box.close();
  }
});

test("the route turns each refusal into the status an operator can act on", async () => {
  installAliasResolver();
  const { NextRequest } = require("next/server");
  const { GET } = require("../app/api/admin/premium/providers/[id]/channels/route.js");

  setEnv("ADMIN_SECRET_KEY", ADMIN_SECRET);
  setEnv("PROXY_BOX_SECRET", BOX_SECRET);

  const get = () =>
    new NextRequest("http://localhost/api/admin/premium/providers/provider-alpha/channels", {
      headers: { "x-admin-secret": ADMIN_SECRET },
    });

  const cases: { status: number; answer: { status: number; body: unknown }; expected: number }[] = [
    {
      status: 401,
      answer: { status: 401, body: { ok: false, code: "unauthorized" } },
      expected: 401,
    },
    {
      status: 404,
      answer: { status: 404, body: { ok: false, code: "unknown_provider" } },
      expected: 404,
    },
    {
      status: 502,
      answer: { status: 502, body: { ok: false, code: "catalogue_unavailable" } },
      expected: 502,
    },
  ];

  for (const entry of cases) {
    enrolledBox();
    const box = await startRecordingBox(entry.answer);
    setEnv("PROXY_BASE_URL", box.url);
    try {
      const result = await GET(get(), { params: { id: "provider-alpha" } });
      assert.equal(result.status, entry.expected, `box answered ${entry.status}`);
      const json = (await result.json()) as Record<string, unknown>;
      assert.equal(json.success, false);
      assert.ok(String(json.error).length > 0, "a refusal must say what happened");
      assert.ok(!JSON.stringify(json).includes("s3cr3t"));
    } finally {
      await box.close();
    }
  }
});
