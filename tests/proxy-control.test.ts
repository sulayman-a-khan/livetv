/**
 * Tests for the 24/7 proxy control tier's door to the stream box (`lib/proxyControl.ts`).
 *
 * Run with `npm run test:proxy-control`. No box is involved: every upstream answer is a
 * stubbed `fetch`, so the rules being executed are the same ones a deployment runs against
 * a real stream box.
 *
 * The cases that matter are the ones an operator would be hurt by if they broke: a panel
 * that reaches the box before it checks the admin secret, a page that carries a proxy
 * credential it has no business holding, and a status page that calls a box with a broken
 * vault "healthy" because the box said `ok`.
 */

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { afterEach, test } from "node:test";

type Control = typeof import("../lib/proxyControl");
const control: Control = require("../lib/proxyControl");
const {
  snapshotFromHealth,
  readProxyBoxSnapshot,
  proxyStatusResponse,
  isProxyAdminSecretValid,
  proxyControlConfigProblem,
} = control;

/**
 * `/healthz` as `ProxyServer/src/server.ts` actually answers it: counts, a vault report and
 * the flags that say which surfaces are mounted. Nothing in it is secret.
 */
function healthBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    service: "soluplay-stream-proxy",
    uptimeMs: 1_845_000,
    sourcesConfigured: 3,
    sessions: 1,
    maxConcurrentUpstream: 2,
    upstreamRuns: 42,
    providerBusy: {
      refusals: 3,
      lanes: [{ channels: 1, maxConnections: 2 }],
      last: { channelKey: "prem-sports-1", code: "provider_busy", holders: 1, maxConnections: 1, at: 1_700_000 },
    },
    vault: {
      driver: "mongo",
      ready: true,
      stored: 4,
      resolvable: 4,
      unreadable: 0,
      lastRefreshMs: 800,
      error: null,
    },
    guard: {
      mode: "strict",
      siteGateActive: true,
      listed: 12,
      wildcard: 0,
      absent: 4,
      foreign: 2,
      absentRefused: 1,
    },
    ownership: { mode: "shared-filesystem", held: 1, refusals: 0 },
    admin: true,
    appApi: true,
    ...overrides,
  };
}

function fakeResponse(status: number, text: string) {
  return {
    status,
    headers: { get: () => null },
    text: async () => text,
  } as unknown as Response;
}

/** A `fetch` a test can change between calls, recording every request it received. */
function stubFetch(reply: { status: number; body: unknown } | Error = { status: 200, body: healthBody() }) {
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

function fakeClock(start = 1_000) {
  let ms = start;
  return {
    now: () => ms,
    advance: (delta: number) => {
      ms += delta;
    },
  };
}

/** The verdict memory is process-global, so each scenario starts from an unasked box. */
function resetSlot(): void {
  (globalThis as { __soluplay_proxy_control?: { lastSuccessAt: number | null } }).__soluplay_proxy_control =
    { lastSuccessAt: null };
}

const REAL_ADMIN_SECRET = process.env.ADMIN_SECRET_KEY;
const REAL_BASE_URL = process.env.PROXY_BASE_URL;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv("ADMIN_SECRET_KEY", REAL_ADMIN_SECRET);
  setEnv("PROXY_BASE_URL", REAL_BASE_URL);
  resetSlot();
});

// --- the gate, before the box is ever asked ---

test("an unauthorized request is refused without the box being asked", async () => {
  resetSlot();
  setEnv("ADMIN_SECRET_KEY", "correct-horse-battery-staple");
  const { fetchImpl, box } = stubFetch();

  for (const presented of [null, "", "   ", "wrong-secret", "correct-horse-battery-stapl"]) {
    const result = await proxyStatusResponse(presented, { baseUrl: "https://box.example.com", fetchImpl });
    assert.equal(result.status, 401);
    assert.equal(result.body.success, false);
    assert.match(String(result.body.error), /Unauthorized/);
  }

  assert.equal(box.calls.length, 0, "an unauthorized call must not reach the box");
});

test("an unset admin secret locks the panel in every environment", async () => {
  resetSlot();
  setEnv("ADMIN_SECRET_KEY", undefined);
  const { fetchImpl, box } = stubFetch();

  const result = await proxyStatusResponse("anything", { baseUrl: "https://box.example.com", fetchImpl });
  assert.equal(result.status, 401);
  assert.equal(box.calls.length, 0);

  assert.equal(isProxyAdminSecretValid("anything"), false);
  assert.equal(isProxyAdminSecretValid(null), false);
});

test("the panel's own secret is the site admin secret, compared the same way", () => {
  setEnv("ADMIN_SECRET_KEY", "correct-horse-battery-staple");
  assert.equal(isProxyAdminSecretValid("correct-horse-battery-staple"), true);
  assert.equal(isProxyAdminSecretValid("  correct-horse-battery-staple  "), true);
  assert.equal(isProxyAdminSecretValid("correct-horse-battery-stapl"), false);

  setEnv("PROXY_BASE_URL", "https://box.example.com");
  assert.equal(proxyControlConfigProblem(), null);

  setEnv("PROXY_BASE_URL", "");
  const problem = proxyControlConfigProblem();
  assert.ok(problem && problem.includes("PROXY_BASE_URL"), "a missing variable is named, not valued");
  assert.ok(!problem.includes("https://"), "the problem text must not carry a value");
});

// --- what leaves the server, and what does not ---

test("the upstream request carries no credential and asks only for the health route", async () => {
  resetSlot();
  setEnv("ADMIN_SECRET_KEY", "correct-horse-battery-staple");
  const { fetchImpl, box } = stubFetch();

  const result = await proxyStatusResponse("correct-horse-battery-staple", {
    baseUrl: "https://box.example.com:8443/tunnel-prefix/",
    fetchImpl,
  });

  assert.equal(result.status, 200);
  assert.equal(box.calls.length, 1);
  assert.equal(box.calls[0].input, "https://box.example.com:8443/tunnel-prefix/healthz");
  assert.equal(box.calls[0].init?.method, "GET");
  assert.equal(box.calls[0].init?.cache, "no-store");
  assert.equal(box.calls[0].init?.headers, undefined);
  assert.doesNotMatch(
    JSON.stringify({ ...box.calls[0].init, signal: undefined }),
    /authorization|bearer|token|secret/i
  );
});

test("nothing from the box reaches the browser except the allow-listed fields", async () => {
  resetSlot();
  setEnv("ADMIN_SECRET_KEY", "correct-horse-battery-staple");
  const { fetchImpl } = stubFetch({
    status: 200,
    body: healthBody({
      vault: {
        driver: "mongo",
        ready: true,
        stored: 4,
        resolvable: 4,
        unreadable: 0,
        error: "auth failed for proxy_user:hunter2@origin.internal",
      },
      // A field the box might grow tomorrow, carrying something it should not.
      debugDump: "mongodb://cluster0.mongodb.net/?retryWrites=true",
      guard: {
        mode: "strict",
        siteGateActive: true,
        listed: 1,
        wildcard: 0,
        absent: 0,
        foreign: 0,
        absentRefused: 0,
        budget: { allowed: 10, secret: "budget-secret" },
      },
    }),
  });

  const result = await proxyStatusResponse("correct-horse-battery-staple", {
    baseUrl: "https://box.example.com",
    fetchImpl,
  });

  const said = JSON.stringify(result.body);
  for (const leak of [
    "hunter2",
    "origin.internal",
    "proxy_user",
    "mongodb://",
    "cluster0",
    "budget-secret",
    "debugDump",
  ]) {
    assert.ok(!said.includes(leak), `the response leaked ${leak}: ${said}`);
  }

  // The admin secret must not be in the answer either, in any form.
  assert.ok(!said.includes("correct-horse-battery-staple"), "the response carried the admin secret");

  const snapshot = result.body.snapshot as Record<string, unknown>;
  const vault = snapshot.vault as Record<string, unknown>;
  assert.equal(vault.hasError, true, "the operator is told there is a problem");
  assert.equal(vault.error, undefined, "the box's own error text stays on the box");
});

// --- reachable is not the same as usable ---

test("a box that answers is not a service that works", () => {
  const at = 1_000;

  const healthy = snapshotFromHealth({ status: 200, body: healthBody() }, at);
  assert.equal(healthy.state, "usable");
  assert.equal(healthy.reachable, true);
  assert.equal(healthy.usable, true);

  // The box says `ok` but its vault is not ready: the process is up, the service is not.
  const notReady = snapshotFromHealth(
    { status: 200, body: healthBody({ vault: { driver: "mongo", ready: false, resolvable: 0 } }) },
    at
  );
  assert.equal(notReady.state, "degraded");
  assert.equal(notReady.reachable, true);
  assert.equal(notReady.usable, false, "a vault that is not ready is not a usable box");

  // A vault that reported a problem is a service that cannot deliver, whatever `ok` says.
  const broken = snapshotFromHealth(
    { status: 200, body: healthBody({ vault: { driver: "mongo", ready: true, error: "boom" } }) },
    at
  );
  assert.equal(broken.state, "degraded");
  assert.equal(broken.usable, false);

  // The box answered and reported itself not ok.
  const saysNo = snapshotFromHealth({ status: 200, body: healthBody({ ok: false }) }, at);
  assert.equal(saysNo.state, "unusable");
  assert.equal(saysNo.reachable, true);
  assert.equal(saysNo.usable, false);

  // Nothing usable came back: that is the absence of information, not a negative reading.
  for (const reply of [
    { status: 502, body: healthBody() },
    { status: 200, body: null },
    { status: 200, body: "gateway error" },
    { status: 200, body: [] },
  ]) {
    const missing = snapshotFromHealth(reply, at);
    assert.equal(missing.state, "unreachable");
    assert.equal(missing.reachable, false);
    assert.equal(missing.usable, false);
  }
});

test("the panel never claims the cap is enforced across two machines", () => {
  const snapshot = snapshotFromHealth({ status: 200, body: healthBody() }, 1_000);
  assert.equal(snapshot.ownership.mode, "shared-filesystem");
  assert.equal(snapshot.ownership.crossMachineEnforced, false);

  const processLocal = snapshotFromHealth(
    { status: 200, body: healthBody({ ownership: { mode: "process-local", held: 0, refusals: 0 } }) },
    1_000
  );
  assert.equal(processLocal.ownership.mode, "process-local");
  assert.equal(processLocal.ownership.crossMachineEnforced, false);

  // A mode the project does not have is not passed through as if it did.
  const unknown = snapshotFromHealth(
    { status: 200, body: healthBody({ ownership: { mode: "cluster-elected", held: 0, refusals: 0 } }) },
    1_000
  );
  assert.equal(unknown.ownership.mode, null);
});

// --- the windows and the timeouts ---

test("a box with no configured address is unreachable and nothing is asked", async () => {
  resetSlot();
  const { fetchImpl, box } = stubFetch();
  const snapshot = await readProxyBoxSnapshot({ fetchImpl });

  assert.equal(snapshot.state, "unreachable");
  assert.equal(box.calls.length, 0);
});

test("a box that stops answering is cut off by the probe's own timeout", async () => {
  resetSlot();
  const started = Date.now();
  const neverAnswers = (async (_input: unknown, init?: unknown) => {
    const signal = (init as { signal?: AbortSignal }).signal;
    assert.ok(signal, "the probe must carry a deadline");
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
    });
  }) as unknown as typeof fetch;

  const snapshot = await readProxyBoxSnapshot({
    baseUrl: "https://box.example.com",
    fetchImpl: neverAnswers,
    timeoutMs: 25,
  });

  assert.equal(snapshot.state, "unreachable");
  assert.ok(Date.now() - started < 2_000, `the probe hung for ${Date.now() - started}ms`);
});

test("the last successful answer is remembered, and a failure does not overwrite it", async () => {
  resetSlot();
  const { fetchImpl, box } = stubFetch();
  const clock = fakeClock();
  const deps = { baseUrl: "https://box.example.com", fetchImpl, now: clock.now };

  const first = await readProxyBoxSnapshot(deps);
  assert.equal(first.reachable, true);
  assert.equal(first.checkedAt, 1_000);
  assert.equal(first.lastSuccessAt, 1_000, "a successful read is itself the latest success");

  box.reply = new Error("socket hang up");
  clock.advance(5_000);
  const duringOutage = await readProxyBoxSnapshot(deps);
  assert.equal(duringOutage.state, "unreachable");
  assert.equal(
    duringOutage.lastSuccessAt,
    1_000,
    "a failed probe must not forget when the box last worked"
  );

  // The box answering again moves that point on, because a snapshot is a successful *read* —
  // whether the box says it is healthy is a separate question the panel answers separately.
  box.reply = { status: 200, body: healthBody() };
  clock.advance(5_000);
  const recovered = await readProxyBoxSnapshot(deps);
  assert.equal(recovered.reachable, true);
  assert.equal(recovered.lastSuccessAt, 11_000);
});

// --- the route itself, not only the function behind it ---

const nodeModule = require("node:module") as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};

/**
 * The route files import through the `@/` alias. TypeScript resolves that alias for types and
 * leaves it in the emitted JavaScript, so the resolver is pointed at the compiled output
 * before a route is required. Without this the route could not be exercised at all.
 */
function installAliasResolver(): void {
  const patched = nodeModule as { __d1AliasPatched?: boolean };
  if (patched.__d1AliasPatched) return;
  const original = nodeModule._resolveFilename;
  nodeModule._resolveFilename = (request: string, ...rest: unknown[]) => {
    const resolved =
      typeof request === "string" && request.startsWith("@/")
        ? path.join(__dirname, "..", request.slice(2))
        : request;
    return original.call(nodeModule, resolved, ...rest);
  };
  patched.__d1AliasPatched = true;
}

/** A box that counts what it was asked, so a caller that never reached it can be shown. */
async function startCountingBox(): Promise<{
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}> {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(healthBody()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("the status route refuses an unauthorized caller before the box is asked", async () => {
  installAliasResolver();
  const { NextRequest } = require("next/server");
  const { GET } = require("../app/api/admin/proxy/status/route.js");

  setEnv("ADMIN_SECRET_KEY", "local-d1-verify-only");
  const box = await startCountingBox();
  setEnv("PROXY_BASE_URL", box.url);
  resetSlot();

  try {
    const refused = await GET(new NextRequest("http://localhost/api/admin/proxy/status"));
    assert.equal(refused.status, 401);
    assert.equal(box.hits(), 0, "an unauthorized call must not reach the box");

    const wrong = await GET(
      new NextRequest("http://localhost/api/admin/proxy/status", {
        headers: { "x-admin-secret": "not-the-key" },
      })
    );
    assert.equal(wrong.status, 401);
    assert.equal(box.hits(), 0, "a wrong key must not reach the box either");

    const allowed = await GET(
      new NextRequest("http://localhost/api/admin/proxy/status", {
        headers: { "x-admin-secret": "local-d1-verify-only" },
      })
    );
    assert.equal(allowed.status, 200);
    assert.equal(box.hits(), 1, "the authorized call is the one that reaches the box");

    const body = await allowed.json();
    assert.equal(body.success, true);
    assert.equal(body.snapshot.state, "usable");
    assert.equal(body.snapshot.vault.driver, "mongo");
    assert.equal(body.snapshot.ownership.mode, "shared-filesystem");

    // Neither the admin secret nor the box's address is anywhere in the answer.
    const said = JSON.stringify(body);
    assert.ok(!said.includes("local-d1-verify-only"), "the admin secret reached the browser");
    assert.ok(!said.includes("127.0.0.1"), "the box's address reached the browser");
    assert.ok(!said.includes("/healthz"), "the upstream path reached the browser");
  } finally {
    await box.close();
  }
});

test("an upstream that cannot be reached produces a safe reading, not an error page", async () => {
  installAliasResolver();
  const { NextRequest } = require("next/server");
  const { GET } = require("../app/api/admin/proxy/status/route.js");

  setEnv("ADMIN_SECRET_KEY", "local-d1-verify-only");
  // A port nothing listens on: the transport fails, exactly as a dead tunnel would.
  setEnv("PROXY_BASE_URL", "http://127.0.0.1:1");
  resetSlot();

  const res = await GET(
    new NextRequest("http://localhost/api/admin/proxy/status", {
      headers: { "x-admin-secret": "local-d1-verify-only" },
    })
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.snapshot.state, "unreachable");
  assert.equal(body.snapshot.reachable, false);
  assert.equal(body.snapshot.usable, false);

  const said = JSON.stringify(body);
  assert.ok(!said.includes("ECONNREFUSED"), "the transport's own error text reached the browser");
  assert.ok(!said.includes("127.0.0.1"), "the box's address reached the browser");
  assert.ok(!/at\s+\w+\s+\(/.test(said), "a stack trace reached the browser");
});

test("the session route answers about this server and asks the box nothing", async () => {
  installAliasResolver();
  const { NextRequest } = require("next/server");
  const { GET } = require("../app/api/admin/proxy/session/route.js");

  setEnv("ADMIN_SECRET_KEY", "local-d1-verify-only");
  const box = await startCountingBox();
  setEnv("PROXY_BASE_URL", box.url);

  try {
    const refused = await GET(new NextRequest("http://localhost/api/admin/proxy/session"));
    assert.equal(refused.status, 401);
    assert.equal(box.hits(), 0, "signing in must not ask the box anything");

    const allowed = await GET(
      new NextRequest("http://localhost/api/admin/proxy/session", {
        headers: { "x-admin-secret": "local-d1-verify-only" },
      })
    );
    assert.equal(allowed.status, 200);
    assert.equal(box.hits(), 0, "the session route never touches the upstream");

    const body = await allowed.json();
    assert.equal(body.success, true);
    assert.equal(body.boxConfigured, true);
    assert.ok(!JSON.stringify(body).includes(box.url), "the address reached the browser");
  } finally {
    await box.close();
  }
});
