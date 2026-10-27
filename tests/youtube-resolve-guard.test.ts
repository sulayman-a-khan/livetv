/**
 * Tests for the bound in front of the public YouTube resolver (P14.6).
 *
 * Run with `npm run test:youtube-resolve-guard`.
 *
 * The rule this locks: the resolver stays open to the browser (the Direct HLS player calls
 * it, so it cannot be admin-authenticated), but it cannot be spent at will. Each request is
 * answered from a recent result when there is one, refused when the client or the instance
 * is over a limit, and only otherwise handed to the resolver.
 *
 * Nothing here reaches the network or a database: the resolver is replaced by a stand-in,
 * the clock is injected, and the catalogue is never read.
 */

import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { test } from "node:test";
import { NextRequest, NextResponse } from "next/server";

type NodeModuleWithHook = typeof Module & {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};

/**
 * The compiled modules reach their siblings through the app's `@/` alias, which the compiler
 * leaves in the emitted `require`. Point it at the compiled output so the code under test is
 * the real one.
 */
const nodeModule = Module as NodeModuleWithHook;
const originalResolve = nodeModule._resolveFilename;
const compiledRoot = path.resolve(__dirname, "..");
nodeModule._resolveFilename = function resolveAppAlias(request: string, ...rest: unknown[]) {
  if (request.startsWith("@/")) {
    return originalResolve.call(this, path.resolve(compiledRoot, request.slice(2)), ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};

delete process.env.YOUTUBE_API_KEY;

const {
  createYouTubeResolveGuard,
  createYouTubeResolveProxy,
  clientKeyFromHeaders,
  refusalPayload,
} = require("../lib/youtubeResolveGuard.js");

const RESOLVER_URL = "https://soluplay.vercel.app/api/youtube/resolve";
const CHANNEL_URL = "https://www.youtube.com/@examplechannel/live";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function resolverRequest(url: string, ip = "203.0.113.7"): NextRequest {
  return new NextRequest(RESOLVER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `${ip}, 198.51.100.4`,
    },
    body: JSON.stringify({ url }),
  });
}

/** A stand-in for the resolver: records what it was asked and answers with a video id. */
function stubResolver(answer: unknown = { success: true, videoId: "abc123" }) {
  const calls: string[] = [];
  const handler = async (request: NextRequest): Promise<Response> => {
    const body = await request.json();
    calls.push(body.url);
    return NextResponse.json(answer, { status: 200 });
  };
  return { calls, handler };
}

test("a client may spend up to its limit and is refused after it", () => {
  let clock = 1_000_000;
  const guard = createYouTubeResolveGuard({
    maxPerClient: 3,
    windowMs: 60_000,
    maxPerHour: 100,
    now: () => clock,
  });

  for (let i = 0; i < 3; i += 1) {
    assert.equal(guard.evaluate({ clientKey: "a", url: `${CHANNEL_URL}?n=${i}` }).action, "resolve");
  }

  const refused = guard.evaluate({ clientKey: "a", url: `${CHANNEL_URL}?n=4` });
  assert.equal(refused.action, "refuse");
  if (refused.action !== "refuse") return;
  assert.equal(refused.reason, "client-rate");
  assert.equal(refused.status, 429);
  assert.ok(refused.retryAfterSeconds > 0 && refused.retryAfterSeconds <= 60);
});

test("one client's spending does not touch another client's", () => {
  const guard = createYouTubeResolveGuard({ maxPerClient: 1, maxPerHour: 10 });

  assert.equal(guard.evaluate({ clientKey: "a", url: CHANNEL_URL }).action, "resolve");
  assert.equal(guard.evaluate({ clientKey: "a", url: CHANNEL_URL }).action, "refuse");
  assert.equal(guard.evaluate({ clientKey: "b", url: CHANNEL_URL }).action, "resolve");
});

test("the client's limit reopens once the window has passed", () => {
  let clock = 1_000_000;
  const guard = createYouTubeResolveGuard({
    maxPerClient: 1,
    windowMs: 60_000,
    maxPerHour: 10,
    now: () => clock,
  });

  assert.equal(guard.evaluate({ clientKey: "a", url: CHANNEL_URL }).action, "resolve");
  assert.equal(guard.evaluate({ clientKey: "a", url: CHANNEL_URL }).action, "refuse");

  clock += 60_001;
  assert.equal(guard.evaluate({ clientKey: "a", url: CHANNEL_URL }).action, "resolve");
});

test("the hourly ceiling refuses even a client that has spent nothing", () => {
  let clock = 1_000_000;
  const guard = createYouTubeResolveGuard({
    maxPerClient: 100,
    windowMs: 60_000,
    maxPerHour: 2,
    hourMs: 3_600_000,
    now: () => clock,
  });

  assert.equal(guard.evaluate({ clientKey: "a", url: `${CHANNEL_URL}?1` }).action, "resolve");
  assert.equal(guard.evaluate({ clientKey: "b", url: `${CHANNEL_URL}?2` }).action, "resolve");

  const refused = guard.evaluate({ clientKey: "c", url: `${CHANNEL_URL}?3` });
  assert.equal(refused.action, "refuse");
  if (refused.action !== "refuse") return;
  assert.equal(refused.reason, "hourly-budget");
  assert.equal(refused.status, 429);
  assert.ok(refused.retryAfterSeconds > 0 && refused.retryAfterSeconds <= 3600);

  clock += 3_600_001;
  assert.equal(guard.evaluate({ clientKey: "c", url: `${CHANNEL_URL}?4` }).action, "resolve");
});

test("a remembered answer is served from the cache and costs no budget", () => {
  let clock = 1_000_000;
  const guard = createYouTubeResolveGuard({
    maxPerHour: 1,
    cacheTtlMs: 60_000,
    now: () => clock,
  });

  assert.equal(guard.evaluate({ clientKey: "a", url: CHANNEL_URL }).action, "resolve");
  guard.remember(CHANNEL_URL, 200, { success: true, videoId: "abc123" });

  const cached = guard.evaluate({ clientKey: "b", url: CHANNEL_URL });
  assert.equal(cached.action, "cached");
  if (cached.action !== "cached") return;
  assert.equal(cached.status, 200);
  assert.deepEqual(cached.payload, { success: true, videoId: "abc123" });
});

test("a cached answer expires", () => {
  let clock = 1_000_000;
  const guard = createYouTubeResolveGuard({ cacheTtlMs: 60_000, now: () => clock });

  guard.remember(CHANNEL_URL, 200, { success: true, videoId: "abc123" });
  assert.equal(guard.evaluate({ clientKey: "a", url: CHANNEL_URL }).action, "cached");

  clock += 60_001;
  assert.equal(guard.evaluate({ clientKey: "a", url: CHANNEL_URL }).action, "resolve");
});

test("the caller is identified from the forwarded address, with fallbacks", () => {
  const headers = (values: Record<string, string>) => ({
    get: (name: string) => values[name.toLowerCase()] ?? null,
  });

  assert.equal(
    clientKeyFromHeaders(headers({ "x-forwarded-for": "203.0.113.7, 198.51.100.4" })),
    "203.0.113.7"
  );
  assert.equal(clientKeyFromHeaders(headers({ "x-real-ip": "203.0.113.9" })), "203.0.113.9");
  assert.equal(clientKeyFromHeaders(headers({}), "203.0.113.11"), "203.0.113.11");
  assert.equal(clientKeyFromHeaders(headers({})), "unknown");
});

test("a refusal carries the shape the player reads", () => {
  const payload = refusalPayload("client-rate");
  assert.equal(payload.success, false);
  assert.equal(typeof payload.error, "string");
  assert.ok(payload.error.length > 0);
});

test("the proxy answers a repeat lookup from the cache", async () => {
  const stub = stubResolver();
  const guard = createYouTubeResolveGuard({ cacheTtlMs: 60_000 });
  const proxy = createYouTubeResolveProxy({ guard, resolve: stub.handler });

  const first = await proxy(resolverRequest(CHANNEL_URL));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { success: true, videoId: "abc123" });
  assert.equal(stub.calls.length, 1);

  const second = await proxy(resolverRequest(CHANNEL_URL));
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { success: true, videoId: "abc123" });
  assert.equal(stub.calls.length, 1, "the second lookup must not spend quota");
});

test("the proxy refuses a lookup that is over the limit", async () => {
  const stub = stubResolver();
  const guard = createYouTubeResolveGuard({ maxPerClient: 1, maxPerHour: 100 });
  const proxy = createYouTubeResolveProxy({ guard, resolve: stub.handler });

  await proxy(resolverRequest(`${CHANNEL_URL}?one`));
  const refused = await proxy(resolverRequest(`${CHANNEL_URL}?two`));

  assert.equal(refused.status, 429);
  const body = await refused.json();
  assert.equal(body.success, false);
  assert.equal(typeof body.error, "string");
  assert.ok(Number(refused.headers.get("retry-after")) > 0);
  assert.equal(stub.calls.length, 1);
});

test("the proxy leaves a URL that already names a video to the route", async () => {
  const stub = stubResolver();
  const proxy = createYouTubeResolveProxy({
    guard: createYouTubeResolveGuard(),
    resolve: stub.handler,
  });

  const response = await proxy(resolverRequest(VIDEO_URL));
  assert.equal(response.headers.get("x-middleware-next"), "1");
  assert.equal(stub.calls.length, 0);
});

test("the proxy leaves a request it cannot read to the route", async () => {
  const stub = stubResolver();
  const proxy = createYouTubeResolveProxy({
    guard: createYouTubeResolveGuard(),
    resolve: stub.handler,
  });

  const broken = new NextRequest(RESOLVER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  const response = await proxy(broken);
  assert.equal(response.headers.get("x-middleware-next"), "1");
  assert.equal(stub.calls.length, 0);
});

test("the proxy passes a failed resolution through without caching it", async () => {
  const stub = stubResolver({ success: false, error: "Channel isn't live right now" });
  const proxy = createYouTubeResolveProxy({
    guard: createYouTubeResolveGuard(),
    resolve: stub.handler,
  });

  const response = await proxy(resolverRequest(CHANNEL_URL));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: false, error: "Channel isn't live right now" });
  assert.equal(stub.calls.length, 1);
});

test("the middleware matches only the resolver and bounds only POST", async () => {
  const { config, middleware } = require("../middleware.js");

  assert.deepEqual(config.matcher, "/api/youtube/resolve");

  const get = await middleware(new NextRequest(RESOLVER_URL, { method: "GET" }));
  assert.equal(get.headers.get("x-middleware-next"), "1");
});

test("the middleware hands a channel-style lookup to the real resolver", async () => {
  const { middleware } = require("../middleware.js");

  // The real resolver, with no API key configured, answers 501 for a channel-style URL.
  // The bound must hand that answer over untouched — same status, same body — rather
  // than answering for it.
  const response = await middleware(resolverRequest(CHANNEL_URL));

  assert.equal(response.status, 501);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.match(body.error, /YOUTUBE_API_KEY/);
  assert.notEqual(body.error, refusalPayload("client-rate").error);
});
