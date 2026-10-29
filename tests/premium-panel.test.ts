/**
 * Tests for the panel's provider and live routes.
 *
 * Run with `npm run test:premium-panel`. The box is a stubbed `fetch`: a small fake box
 * that holds providers and channels and answers the admin surface the way the real one does,
 * so the rules being executed are the ones a deployment runs — the route, the validation, the
 * retry on a taken handle and the two separate switches on a channel.
 *
 * The cases that matter are the ones an operator would be hurt by if they broke: a provider
 * password travelling back to the browser, a channel that claims a stream the box does not
 * hold, "live on the box" and "on the rail" drifting into one switch, and a refusal that
 * leaves the site and the box telling different stories.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

// The compiled modules reach their siblings through the app's `@/` alias, which the compiler
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

// The premium tier's local store writes beside the working directory, and this run must not
// touch the developer's own `data/premium-store.json`. The directory is moved before the
// store is loaded, because the store reads its path once, when it is first imported.
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "freetv-premium-panel-"));
process.chdir(WORK_DIR);

// A blank URI is the shape of "this process has no database". It is cleared before anything
// is loaded, because `lib/db.ts` reads it once at load time.
delete process.env.MONGODB_URI;
delete process.env.VERCEL;

const ADMIN_SECRET = "premium-panel-admin-secret";
const BOX_SECRET = "premium-panel-master-secret";
const BOX_ID = "premium-panel-box";
const BOX_URL = "http://box.test:9999";

process.env.ADMIN_SECRET_KEY = ADMIN_SECRET;
process.env.PROXY_BOX_SECRET = BOX_SECRET;
process.env.BOX_REGISTRY_FILE = path.join(WORK_DIR, "proxy-box.json");

/** The write credential the site derives for this box. */
const ADMIN_TOKEN = crypto
  .createHmac("sha256", BOX_SECRET)
  .update(`soluplay-box:admin:${BOX_ID}`)
  .digest("hex");

// The box this site talks to. The site keeps no token for it: it derives one from the master
// secret and the box's id, so this file holds only the id, the address and the enrollment.
fs.writeFileSync(
  process.env.BOX_REGISTRY_FILE as string,
  JSON.stringify(
    {
      boxes: [
        {
          boxId: BOX_ID,
          baseUrl: BOX_URL,
          registeredAt: new Date().toISOString(),
          state: "enrolled",
          enrolledAt: new Date().toISOString(),
        },
      ],
    },
    null,
    2
  ),
  "utf8"
);

const { NextRequest } = require("next/server");

interface FakeProvider {
  providerId: string;
  label: string;
  active: boolean;
  kind: string;
  server: string;
  usernameHint: string;
  maxConnections: number;
  ownHeaders: boolean;
  channels: string[];
  problem: string | null;
}

interface FakeChannel {
  channelKey: string;
  displayName: string;
  category: string;
  active: boolean;
  providerId: string;
  kind: string;
  backupCount: number;
  state: "serving" | "inactive" | "unusable" | null;
  problem: string | null;
  streamId: string;
  backupStreamIds: string[];
}

interface BoxCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  token: string | null;
}

interface FakeBox {
  providers: FakeProvider[];
  channels: FakeChannel[];
  calls: BoxCall[];
  /** A refusal the box returns for one path, whatever the method. */
  refuse: (method: string, path: string) => { status: number; body: Record<string, unknown> } | null;
  /** The accounts the box has, by handle. */
  accounts: Map<string, { username: string; password: string }>;
}

/**
 * The admin surface's own channel row.
 *
 * The real box answers the admin surface with the channel's own fields and a *sentence* about
 * anything wrong with it — never a code, and never a lane state. A stub that put the
 * read-only surface's codes here would let the site read a verdict from a surface that does
 * not carry one, and the panel would pass its tests while saying the wrong thing to the admin.
 */
function adminChannelOf(channel: FakeChannel) {
  const sentences: Record<string, string> = {
    provider_disabled: `provider ${channel.providerId} is disabled`,
    provider_unusable: `provider ${channel.providerId} is not usable`,
    row_unusable: "unusable row: the stream id is missing",
    unusable: "unusable row",
  };
  return {
    channelKey: channel.channelKey,
    displayName: channel.displayName,
    category: channel.category,
    logoUrl: "",
    active: channel.active,
    providerId: channel.providerId,
    kind: channel.kind,
    accountKey: channel.active ? "lane-key" : null,
    streamId: channel.streamId,
    backupCount: channel.backupCount,
    problem: channel.problem ? sentences[channel.problem] ?? "unusable row" : null,
  };
}

/** The read-only surface's channel row: the verdict, as a code. */
function readonlyChannelOf(channel: FakeChannel) {
  return {
    channelKey: channel.channelKey,
    displayName: channel.displayName,
    category: channel.category,
    active: channel.active,
    providerId: channel.providerId,
    kind: channel.kind,
    backupCount: channel.backupCount,
    state: channel.state,
    problem: channel.problem,
  };
}

/** The read-only surface's provider row: the reason, as a code. */
function readonlyProviderOf(provider: FakeProvider) {
  return {
    providerId: provider.providerId,
    label: provider.label,
    active: provider.active,
    kind: provider.kind,
    server: provider.server,
    usernameHint: provider.usernameHint,
    maxConnections: provider.maxConnections,
    ownHeaders: provider.ownHeaders,
    channels: provider.channels,
    problem: provider.problem,
  };
}

function fakeResponse(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: { get: () => null },
    text: async () => text,
  } as unknown as Response;
}

/**
 * A box that holds a provider list and a channel list and answers the admin surface.
 *
 * The refusals are the box's own codes — `provider_exists`, `provider_in_use`,
 * `unknown_channel` — because the site reads them to decide what to do next, and a stub
 * that answered with different words would prove nothing.
 */
function installFakeBox(overrides: Partial<FakeBox> = {}): FakeBox {
  const box: FakeBox = {
    providers: [],
    channels: [],
    calls: [],
    refuse: () => null,
    accounts: new Map(),
    ...overrides,
  };

  const impl = (async (input: unknown, init?: unknown) => {
    const url = new URL(String(input));
    const request = (init ?? {}) as RequestInit;
    const method = String(request.method || "GET").toUpperCase();
    const body = request.body ? (JSON.parse(String(request.body)) as Record<string, unknown>) : null;
    const headers = (request.headers ?? {}) as Record<string, string>;
    const token = headers.authorization ? headers.authorization.replace(/^Bearer\s+/i, "") : null;
    box.calls.push({ method, path: url.pathname, body, token });

    const refusal = box.refuse(method, url.pathname);
    if (refusal) return fakeResponse(refusal.status, refusal.body);

    if (method === "GET" && url.pathname === "/admin/channels") {
      return fakeResponse(200, {
        ok: true,
        registry: { providers: box.providers.length, stored: box.channels.length, resolvable: box.channels.length },
        accounts: [],
        providers: box.providers.map((provider) => ({
          ...provider,
          problem: provider.problem ? "credential cannot be decrypted" : null,
        })),
        channels: box.channels.map(adminChannelOf),
      });
    }

    // The read-only surface: the one that says what the box makes of a lane, in codes.
    if (method === "GET" && url.pathname === "/readonly/channels") {
      return fakeResponse(200, { ok: true, channels: box.channels.map(readonlyChannelOf) });
    }
    if (method === "GET" && url.pathname === "/readonly/providers") {
      return fakeResponse(200, { ok: true, providers: box.providers.map(readonlyProviderOf) });
    }
    if (method === "GET" && url.pathname === "/readonly/accounts") {
      return fakeResponse(200, { ok: true, accounts: [], lanes: [] });
    }
    if (method === "GET" && url.pathname === "/readonly/status") {
      return fakeResponse(200, {
        ok: true,
        vault: {
          driver: "memory",
          ready: true,
          providers: box.providers.length,
          stored: box.channels.length,
          resolvable: box.channels.length,
          unreadable: 0,
          hasError: false,
        },
        ownership: { mode: "process-local", held: 0, refusals: 0 },
        capacity: {
          providerBusy: false,
          maxConcurrentUpstream: 0,
          sourcesConfigured: 0,
          upstreamRuns: 0,
          last: null,
        },
      });
    }

    if (method === "POST" && url.pathname === "/admin/providers") {
      const providerId = String(body?.providerId || "");
      if (box.providers.some((p) => p.providerId === providerId)) {
        return fakeResponse(409, { ok: false, code: "provider_exists", message: "taken" });
      }
      const provider: FakeProvider = {
        providerId,
        label: String(body?.label || ""),
        active: true,
        kind: "xtream",
        server: String(body?.serverUrl || ""),
        usernameHint: "te***",
        maxConnections: 1,
        ownHeaders: false,
        channels: [],
        problem: null,
      };
      box.providers.push(provider);
      return fakeResponse(201, { ok: true, provider });
    }

    if (method === "PATCH" && url.pathname.startsWith("/admin/providers/")) {
      const providerId = url.pathname.slice("/admin/providers/".length);
      const provider = box.providers.find((p) => p.providerId === providerId);
      if (!provider) return fakeResponse(404, { ok: false, code: "unknown_provider" });
      if (typeof body?.active === "boolean") provider.active = body.active as boolean;
      if (typeof body?.label === "string") provider.label = body.label as string;
      return fakeResponse(200, { ok: true, provider });
    }

    if (method === "DELETE" && url.pathname.startsWith("/admin/providers/")) {
      const providerId = url.pathname.slice("/admin/providers/".length);
      if (box.channels.some((c) => c.providerId === providerId)) {
        return fakeResponse(409, { ok: false, code: "provider_in_use", message: "in use" });
      }
      box.providers = box.providers.filter((p) => p.providerId !== providerId);
      return fakeResponse(200, { ok: true, removed: providerId });
    }

    if (method === "POST" && url.pathname === "/admin/channels") {
      const channelKey = String(body?.channelKey || "");
      if (box.channels.some((c) => c.channelKey === channelKey)) {
        return fakeResponse(409, { ok: false, code: "channel_exists", message: "taken" });
      }
      const channel: FakeChannel = {
        channelKey,
        displayName: String(body?.displayName || ""),
        category: String(body?.category || ""),
        active: body?.active !== false,
        providerId: String(body?.providerId || ""),
        kind: "xtream",
        backupCount: Array.isArray(body?.backupStreamIds) ? (body!.backupStreamIds as string[]).length : 0,
        state: "serving",
        problem: null,
        streamId: String(body?.streamId || ""),
        backupStreamIds: Array.isArray(body?.backupStreamIds) ? (body!.backupStreamIds as string[]) : [],
      };
      box.channels.push(channel);
      return fakeResponse(201, { ok: true, channel });
    }

    if (method === "PATCH" && url.pathname.startsWith("/admin/channels/")) {
      const channelKey = url.pathname.slice("/admin/channels/".length);
      const channel = box.channels.find((c) => c.channelKey === channelKey);
      if (!channel) return fakeResponse(404, { ok: false, code: "unknown_channel" });
      if (typeof body?.active === "boolean") {
        channel.active = body.active as boolean;
        channel.state = channel.active ? "serving" : "inactive";
      }
      if (typeof body?.displayName === "string") channel.displayName = body.displayName as string;
      if (typeof body?.providerId === "string") channel.providerId = body.providerId as string;
      if (typeof body?.streamId === "string") channel.streamId = body.streamId as string;
      if (Array.isArray(body?.backupStreamIds)) {
        channel.backupStreamIds = body!.backupStreamIds as string[];
        channel.backupCount = channel.backupStreamIds.length;
      }
      return fakeResponse(200, { ok: true, channel });
    }

    return fakeResponse(404, { ok: false, code: "not_found" });
  }) as unknown as typeof fetch;

  globalThis.fetch = impl;
  return box;
}

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  // The premium tier's local store keeps its rows in a process-wide array, so a case that
  // created one would leave it standing for the next. Every case starts from an empty rail,
  // and the store is told so directly rather than by deleting the file it writes.
  globalThis.__freetv_premium_channels = [];
  globalThis.__freetv_premium_fixtures = [];
});

/** A request the admin routes accept: the secret in the header it is read from. */
function adminRequest(path: string, body?: Record<string, unknown>, secret = ADMIN_SECRET) {
  return new NextRequest(`http://localhost${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-admin-secret": secret } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function providersRoute() {
  return require("../app/api/admin/premium/providers/route");
}
function providerRoute() {
  return require("../app/api/admin/premium/providers/[id]/route");
}
function liveRoute() {
  return require("../app/api/admin/premium/live/route");
}
function channelsRoute() {
  return require("../app/api/admin/premium/channels/route");
}

// --- the gate ---

test("the provider routes refuse a caller that does not have the admin secret", async () => {
  const box = installFakeBox();
  const { GET, POST } = providersRoute();

  const read = await GET(adminRequest("/api/admin/premium/providers", undefined, ""));
  assert.equal(read.status, 401);

  const write = await POST(adminRequest("/api/admin/premium/providers", { label: "X" }, ""));
  assert.equal(write.status, 401);

  assert.equal(box.calls.length, 0, "the box is never asked for an unauthorized caller");
});

test("the provider list comes from the box and carries no credential", async () => {
  installFakeBox({
    providers: [
      {
        providerId: "example",
        label: "Example Sports",
        active: true,
        kind: "xtream",
        server: "http://provider.test:8080",
        usernameHint: "te***",
        maxConnections: 1,
        ownHeaders: false,
        channels: ["example-1"],
        problem: null,
      },
    ],
  });

  const { GET } = providersRoute();
  const res = await GET(adminRequest("/api/admin/premium/providers"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.count, 1);
  assert.equal(body.providers[0].providerId, "example");
  assert.equal(body.providers[0].server, "http://provider.test:8080");
  assert.equal(body.providers[0].usernameHint, "te***");
  // The projection is the box's own: a password, a stream id and the lane identity are not
  // in it, and the site does not invent them.
  assert.equal(body.providers[0].password, undefined);
  assert.equal(body.providers[0].accountKey, undefined);
});

test("the provider list says why an account cannot be used, in the box's own code", async () => {
  installFakeBox({
    providers: [
      {
        providerId: "example",
        label: "Example Sports",
        active: false,
        kind: "xtream",
        server: "http://provider.test:8080",
        usernameHint: "te***",
        maxConnections: 1,
        ownHeaders: false,
        channels: [],
        problem: "undecryptable",
      },
    ],
  });

  const { GET } = providersRoute();
  const res = await GET(adminRequest("/api/admin/premium/providers"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.providers[0].problem, "undecryptable");
});

test("a box that refuses this server's credential is not reported as a box with no providers", async () => {
  installFakeBox({
    refuse: () => ({ status: 401, body: { ok: false, code: "unauthorized" } }),
  });

  const { GET } = providersRoute();
  const res = await GET(adminRequest("/api/admin/premium/providers"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.reachable, true);
  assert.equal(body.authorized, false);
  assert.deepEqual(body.providers, []);
});

// --- adding a provider ---

test("a provider without a password is refused before the box is asked", async () => {
  const box = installFakeBox();
  const { POST } = providersRoute();

  const res = await POST(
    adminRequest("/api/admin/premium/providers", {
      label: "Example Sports",
      serverUrl: "http://provider.test:8080",
      username: "tester",
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Password is required/);
  assert.equal(box.calls.length, 0, "the box is never asked for an invalid registration");
});

test("a provider is registered on the box and its password never comes back", async () => {
  const box = installFakeBox();
  const { POST } = providersRoute();

  const res = await POST(
    adminRequest("/api/admin/premium/providers", {
      label: "Example Sports",
      serverUrl: "http://provider.test:8080",
      username: "tester",
      password: "s3cr3tpass",
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.providerId, "example-sports");

  const created = box.calls.find((call) => call.method === "POST" && call.path === "/admin/providers");
  assert.ok(created, "the box was asked to register the account");
  assert.equal(created?.body?.username, "tester");
  assert.equal(created?.body?.password, "s3cr3tpass");

  // The answer names the account and its handle, and nothing that could sign in to it.
  const text = JSON.stringify(body);
  assert.equal(text.includes("s3cr3tpass"), false);
  assert.equal(text.includes("tester"), false);
});

test("a handle that is taken is tried under another name rather than refused", async () => {
  const box = installFakeBox({
    providers: [
      {
        providerId: "example-sports",
        label: "Example Sports",
        active: true,
        kind: "xtream",
        server: "http://provider.test:8080",
        usernameHint: "te***",
        maxConnections: 1,
        ownHeaders: false,
        channels: [],
        problem: null,
      },
    ],
  });

  const { POST } = providersRoute();
  const res = await POST(
    adminRequest("/api/admin/premium/providers", {
      label: "Example Sports",
      serverUrl: "http://provider.test:8080",
      username: "tester",
      password: "s3cr3tpass",
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.providerId, "example-sports-2");

  const tries = box.calls.filter((call) => call.method === "POST" && call.path === "/admin/providers");
  assert.equal(tries.length, 2);
  assert.equal(tries[0].body?.providerId, "example-sports");
  assert.equal(tries[1].body?.providerId, "example-sports-2");
});

test("a duplicate credential is not retried under another name", async () => {
  const box = installFakeBox({
    refuse: (method, path) =>
      method === "POST" && path === "/admin/providers"
        ? { status: 409, body: { ok: false, code: "duplicate_credential", message: "same credential" } }
        : null,
  });

  const { POST } = providersRoute();
  const res = await POST(
    adminRequest("/api/admin/premium/providers", {
      label: "Example Sports",
      serverUrl: "http://provider.test:8080",
      username: "tester",
      password: "s3cr3tpass",
    })
  );
  assert.equal(res.status, 409);

  const tries = box.calls.filter((call) => call.method === "POST" && call.path === "/admin/providers");
  assert.equal(tries.length, 1, "a second name would not change the credential");
});

// --- editing and removing a provider ---

test("an edit that changes nothing is refused", async () => {
  const box = installFakeBox();
  const { PATCH } = providerRoute();

  const req = new NextRequest("http://localhost/api/admin/premium/providers/example", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-admin-secret": ADMIN_SECRET },
    body: JSON.stringify({}),
  });
  const res = await PATCH(req, { params: { id: "example" } });
  assert.equal(res.status, 400);
  assert.equal(box.calls.length, 0);
});

test("an account is renamed on the box and taken out of service", async () => {
  const box = installFakeBox({
    providers: [
      {
        providerId: "example",
        label: "Example Sports",
        active: true,
        kind: "xtream",
        server: "http://provider.test:8080",
        usernameHint: "te***",
        maxConnections: 1,
        ownHeaders: false,
        channels: [],
        problem: null,
      },
    ],
  });
  const { PATCH } = providerRoute();

  const rename = await PATCH(
    new NextRequest("http://localhost/api/admin/premium/providers/example", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-admin-secret": ADMIN_SECRET },
      body: JSON.stringify({ label: "Example Sports HD" }),
    }),
    { params: { id: "example" } }
  );
  assert.equal(rename.status, 200);
  assert.equal(box.providers[0].label, "Example Sports HD");

  const off = await PATCH(
    new NextRequest("http://localhost/api/admin/premium/providers/example", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-admin-secret": ADMIN_SECRET },
      body: JSON.stringify({ active: false }),
    }),
    { params: { id: "example" } }
  );
  assert.equal(off.status, 200);
  assert.equal(box.providers[0].active, false, "the account is out of service on the box");
});

test("an account a channel still plays from cannot be removed", async () => {
  const box = installFakeBox({
    providers: [
      {
        providerId: "example",
        label: "Example Sports",
        active: true,
        kind: "xtream",
        server: "http://provider.test:8080",
        usernameHint: "te***",
        maxConnections: 1,
        ownHeaders: false,
        channels: ["example-1"],
        problem: null,
      },
    ],
    // The channel the account is playing for. The box refuses to take the account while one
    // of its channels still points at it.
    channels: [
      {
        channelKey: "example-1",
        displayName: "Example Sports HD",
        category: "Sports",
        active: true,
        providerId: "example",
        kind: "xtream",
        backupCount: 0,
        state: "serving",
        problem: null,
        streamId: "4411",
        backupStreamIds: [],
      },
    ],
  });
  const { DELETE } = providerRoute();

  const res = await DELETE(
    new NextRequest("http://localhost/api/admin/premium/providers/example", {
      method: "DELETE",
      headers: { "x-admin-secret": ADMIN_SECRET },
    }),
    { params: { id: "example" } }
  );
  assert.equal(res.status, 409);
  assert.equal(box.providers.length, 1, "the account is still on the box");
  assert.equal(box.channels.length, 1, "and so is the channel it plays for");
});

// --- a channel that plays from a provider ---

test("a channel with a provider is written here and on the box, with its failover order", async () => {
  const box = installFakeBox();

  const { POST } = channelsRoute();
  const res = await POST(
    adminRequest("/api/admin/premium/channels", {
      name: "Example Sports HD",
      category: "Sports",
      logoUrl: "https://host.example/logo.png",
      providerId: "example",
      streamId: "4411",
      backupStreamIds: ["4412", "4413"],
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.channel.providerId, "example");
  assert.equal(body.channel.streamId, "4411");
  assert.deepEqual(body.channel.backupStreamIds, ["4412", "4413"]);
  assert.ok(body.channel.proxyChannelKey, "the row keeps the handle it is filed under on the box");

  const created = box.calls.find((call) => call.method === "POST" && call.path === "/admin/channels");
  assert.ok(created, "the box was asked to hold the channel");
  assert.equal(created?.body?.providerId, "example");
  assert.equal(created?.body?.streamId, "4411");
  assert.deepEqual(created?.body?.backupStreamIds, ["4412", "4413"], "the failover order is kept");
});

test("a channel the box refuses is not left behind claiming the stream", async () => {
  installFakeBox({
    refuse: (method, path) =>
      method === "POST" && path === "/admin/channels"
        ? { status: 400, body: { ok: false, code: "invalid_stream", message: "no such stream" } }
        : null,
  });

  const { POST, GET } = channelsRoute();
  const res = await POST(
    adminRequest("/api/admin/premium/channels", {
      name: "Example Sports HD",
      providerId: "example",
      streamId: "9999",
      backupStreamIds: [],
    })
  );
  assert.equal(res.status, 400);

  const list = await GET(adminRequest("/api/admin/premium/channels"));
  const body = await list.json();
  assert.equal(body.count, 0, "the row went with the change it made");
});

// --- live on server ---

test("the live list reports the two switches of a channel separately", async () => {
  const box = installFakeBox();

  // A channel that plays from a provider, written here first.
  const { POST: createChannel } = channelsRoute();
  await createChannel(
    adminRequest("/api/admin/premium/channels", {
      name: "Example Sports HD",
      category: "Sports",
      providerId: "example",
      streamId: "4411",
      backupStreamIds: ["4412", "4413"],
    })
  );

  // The lane is off air on the box, while the row is still on the rail. Those are two
  // switches, and the list has to report them separately rather than as one "active".
  box.channels[0].active = false;
  box.channels[0].state = "inactive";

  const { GET } = liveRoute();
  const res = await GET(adminRequest("/api/admin/premium/live"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.count, 1);
  const row = body.channels[0];
  assert.equal(row.name, "Example Sports HD");
  assert.equal(row.visible, true, "the row is on the rail");
  assert.equal(row.live, false, "the lane is off air on the box");
  assert.equal(row.onBox, true);
  assert.equal(row.boxState, "inactive");
  assert.equal(row.backups, 2);
  assert.equal(box.channels.length, 1);
});

test("the lane verdict is the one the box's read-only surface gives", async () => {
  const box = installFakeBox();

  const { POST: createChannel } = channelsRoute();
  await createChannel(
    adminRequest("/api/admin/premium/channels", {
      name: "Example Sports HD",
      category: "Sports",
      providerId: "example",
      streamId: "4411",
      backupStreamIds: ["4412"],
    })
  );

  const { GET } = liveRoute();
  const serving = await (await GET(adminRequest("/api/admin/premium/live"))).json();
  assert.equal(serving.channels[0].boxState, "serving", "the box says the lane is serving");

  // The provider behind the lane is switched off on the box, so the lane cannot be served.
  // The read-only surface says that with a code; the admin surface says it in a sentence and
  // carries no code and no state at all, so a verdict read from there would be missing.
  box.channels[0].state = "unusable";
  box.channels[0].problem = "provider_disabled";

  const unusable = await (await GET(adminRequest("/api/admin/premium/live"))).json();
  assert.equal(unusable.channels[0].boxState, "unusable");
  assert.equal(unusable.channels[0].boxProblem, "provider_disabled");
  assert.equal(unusable.channels[0].live, true, "the lane is still switched on; it cannot be served");
});

test("the live switch and the visible switch move one thing each", async () => {
  const box = installFakeBox();

  const { POST: createChannel } = channelsRoute();
  await createChannel(
    adminRequest("/api/admin/premium/channels", {
      name: "Example Sports HD",
      providerId: "example",
      streamId: "4411",
      backupStreamIds: [],
    })
  );

  const { GET: getLive, POST: postLive } = liveRoute();
  const before = await (await getLive(adminRequest("/api/admin/premium/live"))).json();
  const channelId = before.channels[0].channelId;

  const offAir = await postLive(
    adminRequest("/api/admin/premium/live", { scope: "live", channelId, active: false })
  );
  assert.equal(offAir.status, 200);
  assert.equal(box.channels[0].active, false, "the lane is off air on the box");

  const afterAir = await (await getLive(adminRequest("/api/admin/premium/live"))).json();
  assert.equal(afterAir.channels[0].live, false);
  assert.equal(afterAir.channels[0].visible, true, "the row is still on the rail");

  const hidden = await postLive(
    adminRequest("/api/admin/premium/live", { scope: "visible", channelId, active: false })
  );
  assert.equal(hidden.status, 200);
  const afterHidden = await (await getLive(adminRequest("/api/admin/premium/live"))).json();
  assert.equal(afterHidden.channels[0].visible, false, "the row is off the rail");
  assert.equal(afterHidden.channels[0].live, false, "and the lane is still off air");
  assert.equal(box.channels[0].active, false, "the box was not switched by the rail switch");
});

test("a switch that names nothing is refused", async () => {
  installFakeBox();
  const { POST } = liveRoute();

  const scope = await POST(
    adminRequest("/api/admin/premium/live", { scope: "everything", channelId: "x", active: true })
  );
  assert.equal(scope.status, 400);

  const missing = await POST(
    adminRequest("/api/admin/premium/live", { scope: "live", active: true })
  );
  assert.equal(missing.status, 400);
});

test("a lane the box does not know is named as such", async () => {
  installFakeBox();
  const { POST: createChannel } = channelsRoute();
  await createChannel(
    adminRequest("/api/admin/premium/channels", {
      name: "Example Sports HD",
      providerId: "example",
      streamId: "4411",
      backupStreamIds: [],
    })
  );

  const { GET: getLive, POST: postLive } = liveRoute();
  const before = await (await getLive(adminRequest("/api/admin/premium/live"))).json();
  const channelId = before.channels[0].channelId;

  // The box forgets the lane between the create and the switch.
  const empty = installFakeBox();
  const res = await postLive(
    adminRequest("/api/admin/premium/live", { scope: "live", channelId, active: false })
  );
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "This channel is not on the stream box yet");

  // The one thing the box was asked was the lane itself, and it said it had never heard of it.
  assert.equal(empty.calls.length, 1);
  assert.equal(empty.calls[0].method, "PATCH");
  assert.match(empty.calls[0].path, /^\/admin\/channels\//);
});
