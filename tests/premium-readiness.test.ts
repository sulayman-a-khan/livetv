/**
 * Regression tests for the Secured HLS readiness gate (`lib/premiumReadiness.ts`).
 *
 * Run with `npm run test:premium-readiness`. No box is involved: every probe here is handed
 * a stubbed `fetch` and a stubbed clock, so the rules being executed are the same ones a
 * deployment runs against a real stream box — including the ones that decide what to do when
 * the box does not answer.
 *
 * The cases the gate has to get right are the ones a viewer would notice: a box that says it
 * is down hides the rail immediately, a box that stops answering keeps the last honest answer
 * only while it is still recent, and a box that never answers at all is treated as not ready
 * rather than as an error page.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

type Readiness = typeof import("../lib/premiumReadiness");
const readiness: Readiness = require("../lib/premiumReadiness");
const { verdictFromHealth, probePremiumReadiness, readPremiumReadiness, isPremiumReady } =
  readiness;

// --- the box, as a stand-in ---

/**
 * `/healthz` as `ProxyServer/src/server.ts` actually answers it: counts, a vault report and
 * the flags that say which surfaces are mounted. Nothing in it is secret, and nothing outside
 * it is allowed to reach a verdict.
 */
function healthBody(overrides: {
  ok?: boolean;
  appApi?: boolean;
  vault?: Record<string, unknown> | null;
} = {}): Record<string, unknown> {
  return {
    ok: overrides.ok ?? true,
    service: "soluplay-stream-proxy",
    uptimeMs: 1_845_000,
    sourcesConfigured: 3,
    sessions: 1,
    maxConcurrentUpstream: 2,
    upstreamRuns: 42,
    providerBusy: {
      refusals: 0,
      lanes: [{ channels: 1, maxConnections: 2 }],
      last: null,
    },
    vault: {
      driver: "mongo",
      ready: true,
      stored: 4,
      resolvable: 4,
      unreadable: 0,
      lastRefreshMs: 800,
      error: null,
      ...(overrides.vault ?? {}),
    },
    guard: { blocked: 0 },
    admin: true,
    appApi: overrides.appApi ?? true,
  };
}

/** A reply is either a status with a body (a string body is sent verbatim, not JSON) or a throw. */
type Reply = { status: number; body: unknown } | Error;

const REACHABLE: Reply = { status: 200, body: healthBody() };
const BOX_SAYS_NO: Reply = { status: 200, body: healthBody({ vault: { ready: false } }) };

function fakeResponse(status: number, text: string) {
  return { status, text: async () => text } as unknown as Response;
}

function toReplyText(reply: Reply): { status: number; text: string } {
  if (reply instanceof Error) throw reply;
  const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
  return { status: reply.status, text: body ?? "" };
}

/**
 * A `fetch` whose answer a test can change between calls, recording every request it received
 * so a test can also say what the probe actually asked for.
 */
function stubFetch(initial: Reply = REACHABLE) {
  const box: { reply: Reply; calls: { input: string; init: RequestInit | undefined }[] } = {
    reply: initial,
    calls: [],
  };
  const fetchImpl = (async (input: unknown, init?: unknown) => {
    box.calls.push({ input: String(input), init: init as RequestInit | undefined });
    const reply = toReplyText(box.reply);
    return fakeResponse(reply.status, reply.text);
  }) as unknown as typeof fetch;
  return { fetchImpl, box };
}

/** A clock a test advances by hand, so windows are measured rather than waited for. */
function fakeClock(start = 1_000) {
  let ms = start;
  return {
    now: () => ms,
    advance: (delta: number) => {
      ms += delta;
    },
  };
}

interface ReadinessSlot {
  verdict: unknown;
  lastProbeAt: number;
  inflight: Promise<unknown> | null;
}

/** The gate logs state changes; here they go to an array a test can read instead of the run. */
const logged: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.startsWith("[premiumReadiness]")) logged.push(line);
  else realWarn(line);
};
after(() => {
  console.warn = realWarn;
});

/** The verdict cache is process-global, so each scenario starts from an unasked box. */
function resetSlot(): void {
  (globalThis as { __soluplay_premium_readiness?: ReadinessSlot }).__soluplay_premium_readiness = {
    verdict: null,
    lastProbeAt: 0,
    inflight: null,
  };
  logged.length = 0;
}

// --- the decision, with no network in it ---

test("the box's own health answer decides the verdict", () => {
  const at = 1_000;
  assert.deepEqual(verdictFromHealth({ status: 200, body: healthBody() }, at), {
    state: "ready",
    checkedAt: at,
    lanesOnBox: 4,
  });

  // Three ways the box can answer and still say it cannot serve: a vault that has not
  // completed its first refresh, a signing API that is not mounted, and a vault with no lane
  // it can open. All three are information, not an absence of it.
  for (const body of [
    healthBody({ vault: { ready: false } }),
    healthBody({ appApi: false }),
    healthBody({ vault: { resolvable: 0 } }),
    // A vault report this process cannot count lanes from is not a promise either.
    healthBody({ vault: { resolvable: "four" } }),
    // The config-driver shape (no registry mounted) with nothing configured.
    { ok: true, appApi: true, vault: { driver: "config" } },
  ]) {
    assert.equal(verdictFromHealth({ status: 200, body }, at).state, "unavailable");
  }

  // A body that is not the health answer at all says nothing about the box's opinion.
  assert.equal(verdictFromHealth({ status: 502, body: healthBody() }, at).state, "unknown");
  assert.equal(verdictFromHealth({ status: 200, body: null }, at).state, "unknown");
  assert.equal(verdictFromHealth({ status: 200, body: "gateway error" }, at).state, "unknown");
  assert.equal(verdictFromHealth({ status: 200, body: healthBody({ ok: false }) }, at).state, "unknown");

  assert.equal(isPremiumReady({ state: "ready", checkedAt: at, lanesOnBox: 4 }), true);
  assert.equal(isPremiumReady({ state: "unavailable", checkedAt: at, lanesOnBox: 0 }), false);
  assert.equal(isPremiumReady({ state: "unknown", checkedAt: at, lanesOnBox: 0 }), false);
});

// --- what the probe sends, and what it keeps ---

test("the probe asks /healthz with no credentials and carries nothing back out of the box", async () => {
  resetSlot();
  const { fetchImpl, box } = stubFetch({
    status: 200,
    // Error text that names a host and a credential: it stays inside the reply.
    body: healthBody({ vault: { resolvable: 9, error: "auth failed for proxy_user:hunter2@origin.internal" } }),
  });
  const clock = fakeClock();

  const verdict = await probePremiumReadiness({
    baseUrl: "https://box.example.com:8443/tunnel-prefix/",
    fetchImpl,
    now: clock.now,
  });

  assert.equal(box.calls.length, 1);
  assert.equal(box.calls[0].input, "https://box.example.com:8443/tunnel-prefix/healthz");
  assert.equal(box.calls[0].init?.method, "GET");
  assert.equal(box.calls[0].init?.cache, "no-store");
  // Nothing is attached to the request: `/healthz` asks for no token, so a readiness probe
  // must not become another place a token can be logged.
  assert.equal(box.calls[0].init?.headers, undefined);
  assert.doesNotMatch(JSON.stringify({ ...box.calls[0].init, signal: undefined }), /authorization|bearer|token/i);

  // And nothing but the verdict comes out: three fields, no address, no lane name, no
  // upstream host, no box error text.
  assert.deepEqual(Object.keys(verdict).sort(), ["checkedAt", "lanesOnBox", "state"]);
  assert.equal(verdict.state, "ready");
  assert.equal(verdict.lanesOnBox, 9);
  const said = JSON.stringify(verdict);
  for (const leak of ["box.example.com", "8443", "tunnel-prefix", "hunter2", "origin.internal", "proxy_user"]) {
    assert.ok(!said.includes(leak), `the verdict leaked ${leak}: ${said}`);
  }
});

test("a box with no configured address is unknown, and nothing is asked", async () => {
  const real = process.env.PROXY_BASE_URL;
  delete process.env.PROXY_BASE_URL;
  try {
    const { fetchImpl, box } = stubFetch();
    const verdict = await probePremiumReadiness({ fetchImpl, now: fakeClock().now });
    assert.deepEqual(verdict, { state: "unknown", checkedAt: 1_000, lanesOnBox: 0 });
    assert.equal(box.calls.length, 0);
  } finally {
    if (real !== undefined) process.env.PROXY_BASE_URL = real;
  }
});

test("a box that stops answering is cut off by the probe's own timeout instead of holding the page", async () => {
  resetSlot();
  const started = Date.now();
  const neverAnswers = (async (_input: unknown, init?: unknown) => {
    const signal = (init as { signal?: AbortSignal }).signal;
    assert.ok(signal, "the readiness probe must carry a deadline");
    return new Promise<Response>((_resolve, reject) => {
      // An open request holds the event loop alive the way a real socket does; the
      // deadline's own timer is unref'd, so without this the promise never settles.
      const open = setTimeout(() => {}, 60_000);
      signal?.addEventListener("abort", () => {
        clearTimeout(open);
        reject(new Error("This operation was aborted — the box never answered"));
      });
    });
  }) as unknown as typeof fetch;

  const verdict = await probePremiumReadiness({
    baseUrl: "https://box.example.com",
    fetchImpl: neverAnswers,
    timeoutMs: 25,
    now: fakeClock().now,
  });

  assert.equal(verdict.state, "unknown");
  assert.ok(Date.now() - started < 2_000, `the probe hung for ${Date.now() - started}ms`);
});

// --- the windows: fresh reuse, single flight, stale unknown, recovery ---

test("one verdict per window, shared by concurrent readers", async () => {
  resetSlot();
  const { fetchImpl, box } = stubFetch();
  const clock = fakeClock();
  const deps = { baseUrl: "https://box.example.com", fetchImpl, now: clock.now };

  const first = await readPremiumReadiness(deps);
  clock.advance(5_000);
  const cached = await readPremiumReadiness(deps);
  assert.equal(cached, first);
  assert.equal(box.calls.length, 1, "a read inside the fresh window must not ask the box again");

  // Two readers arriving while the first probe is still in flight share that probe, so a busy
  // homepage costs the box one request rather than one per viewer.
  resetSlot();
  box.calls.length = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slowFetch = (async () => {
    box.calls.push({ input: "slow", init: undefined });
    await gate;
    return fakeResponse(200, JSON.stringify(healthBody()));
  }) as unknown as typeof fetch;
  const pending = Promise.all([
    readPremiumReadiness({ ...deps, fetchImpl: slowFetch }),
    readPremiumReadiness({ ...deps, fetchImpl: slowFetch }),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [a, b] = await pending;
  assert.equal(box.calls.length, 1);
  assert.equal(a.state, "ready");
  assert.equal(b, a);
});

test("a box that stops answering keeps the last honest answer only while it is recent", async () => {
  resetSlot();
  const { fetchImpl, box } = stubFetch();
  const clock = fakeClock();
  const deps = { baseUrl: "https://box.example.com", fetchImpl, now: clock.now };

  const ready = await readPremiumReadiness(deps);
  assert.equal(ready.state, "ready");

  // A tunnel blip is not the box saying it is down, so the working rail stays up: the answer
  // the box actually gave is still trusted inside `MAX_USEFUL_AGE_MS`.
  box.reply = new Error("socket hang up");
  clock.advance(19_000); // past the 15s fresh window, so this read does ask
  const kept = await readPremiumReadiness(deps);
  assert.equal(kept.state, "ready");
  assert.equal(kept.checkedAt, 1_000);

  // Past that age nobody knows whether the box can serve, and the surface fails closed rather
  // than promising a stream on the strength of an answer from a minute ago.
  clock.advance(30_000);
  const stale = await readPremiumReadiness(deps);
  assert.equal(stale.state, "unknown");
  assert.equal(isPremiumReady(stale), false);

  // The first read of a box that has never answered is unknown at once: there is no older
  // answer to lean on.
  resetSlot();
  const cold = await readPremiumReadiness(deps);
  assert.equal(cold.state, "unknown");
});

test("an outage is honoured as soon as it is read, and the rail returns only when the box says so", async () => {
  resetSlot();
  const { fetchImpl, box } = stubFetch();
  const clock = fakeClock();
  const deps = { baseUrl: "https://box.example.com", fetchImpl, now: clock.now };

  await readPremiumReadiness(deps);
  assert.match(logged.join("\n"), /unasked -> ready/);

  // The box answers, and answers "not ready": that is information, so it replaces a trusted
  // `ready` immediately instead of being held back by the age window.
  box.reply = BOX_SAYS_NO;
  clock.advance(19_000);
  logged.length = 0;
  const during = await readPremiumReadiness(deps);
  assert.equal(during.state, "unavailable");
  assert.equal(logged.length, 1, "a steady outage must log once, not on every request");
  // Counts only: what the box said about itself, never the address it was asked or a lane name.
  assert.match(logged[0], /ready -> unavailable, 4 lane\(s\) resolvable on the box/);
  assert.ok(!/box\.example\.com|healthz/.test(logged.join("\n")), "the log must not name the box");

  // A box that is steadily down is not asked again until the fresh window turns over.
  const callsBefore = box.calls.length;
  clock.advance(5_000);
  await readPremiumReadiness(deps);
  assert.equal(box.calls.length, callsBefore);
  assert.equal(logged.length, 1, "a steady outage must not repeat itself");

  // Recovery is the box's own reading, not a timer: the rail returns on the next answer that
  // says it can serve.
  box.reply = REACHABLE;
  clock.advance(19_000);
  const restored = await readPremiumReadiness(deps);
  assert.equal(restored.state, "ready");
  assert.match(logged[logged.length - 1], /unavailable -> ready/);
});
