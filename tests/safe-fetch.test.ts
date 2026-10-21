/**
 * Focused tests for the network half of the request-forgery guard
 * (`lib/safeFetch.ts`) — the part that resolves a hostname and walks a
 * redirect chain one hop at a time.
 *
 * Run with `npm run test:ssrf-guard` — compiles the guard plus this file into
 * `.tmp-tests/` and runs it on Node's own test runner. No network and no
 * database: the resolver and the transport are injected, so every case is
 * decided by the test itself and nothing leaves the machine.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkHostResolvesPublic,
  RedirectLimitError,
  safeFetch,
  UnsafeUrlError,
  type HostResolver,
} from "../lib/safeFetch";
import { checkRedirectTarget, isIpLiteral, isPrivateOrInternalAddress } from "../lib/ssrfGuard";

interface ScriptedResponse {
  status: number;
  location?: string;
  body?: string;
}

/** A resolver that answers with whatever the test says a host resolves to. */
function resolverFor(map: Record<string, string[]>): HostResolver {
  return async (hostname) => {
    const addresses = map[hostname];
    if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
    return addresses;
  };
}

/** A transport that answers with the scripted responses and records every request. */
function transportFor(responses: ScriptedResponse[]) {
  const requested: string[] = [];
  const seen: Array<{ url: string; headers: Headers }> = [];
  const queue = [...responses];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    seen.push({ url, headers: new Headers(init?.headers) });

    const next = queue.shift();
    if (!next) throw new Error(`no scripted response for ${url}`);
    return new Response(next.body ?? "", {
      status: next.status,
      headers: next.location ? { location: next.location } : undefined,
    });
  }) as unknown as typeof fetch;

  return { requested, seen, fetchImpl };
}

const PUBLIC_RESOLVER = resolverFor({
  "cdn.example.com": ["93.184.216.34"],
  "edge.example.net": ["93.184.216.35"],
  "rebind.example.com": ["169.254.169.254"],
  "loop.example.com": ["127.0.0.1"],
});

test("a public URL is fetched once, unchanged", async () => {
  const { requested, fetchImpl } = transportFor([{ status: 200, body: "ok" }]);
  const response = await safeFetch("https://cdn.example.com/live.m3u8", {}, {
    resolver: PUBLIC_RESOLVER,
    fetchImpl,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(requested, ["https://cdn.example.com/live.m3u8"]);
});

test("a redirect to a public host is followed", async () => {
  const { requested, fetchImpl } = transportFor([
    { status: 302, location: "https://edge.example.net/live.m3u8" },
    { status: 200, body: "ok" },
  ]);
  const response = await safeFetch("https://cdn.example.com/live.m3u8", {}, {
    resolver: PUBLIC_RESOLVER,
    fetchImpl,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(requested, ["https://cdn.example.com/live.m3u8", "https://edge.example.net/live.m3u8"]);
});

test("a redirect into the server's own network is refused and never requested", async () => {
  const { requested, fetchImpl } = transportFor([
    { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
  ]);
  await assert.rejects(
    () =>
      safeFetch("https://cdn.example.com/live.m3u8", {}, {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
      }),
    (err: unknown) => err instanceof UnsafeUrlError
  );
  assert.deepEqual(requested, ["https://cdn.example.com/live.m3u8"]);
});

test("a redirect to a host that resolves into the server's own network is refused", async () => {
  const { requested, fetchImpl } = transportFor([
    { status: 302, location: "https://loop.example.com/secret" },
  ]);
  await assert.rejects(
    () =>
      safeFetch("https://cdn.example.com/live.m3u8", {}, {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
      }),
    (err: unknown) => err instanceof UnsafeUrlError
  );
  assert.deepEqual(requested, ["https://cdn.example.com/live.m3u8"]);
});

test("a first URL whose host resolves into the server's own network never reaches the transport", async () => {
  const { requested, fetchImpl } = transportFor([{ status: 200 }]);
  await assert.rejects(
    () =>
      safeFetch("https://rebind.example.com/live.m3u8", {}, {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
      }),
    (err: unknown) => err instanceof UnsafeUrlError
  );
  assert.deepEqual(requested, []);
});

test("a private literal never reaches the transport", async () => {
  const { requested, fetchImpl } = transportFor([{ status: 200 }]);
  await assert.rejects(
    () =>
      safeFetch("http://127.0.0.1:3000/admin", {}, {
        resolver: resolverFor({}),
        fetchImpl,
      }),
    (err: unknown) => err instanceof UnsafeUrlError
  );
  assert.deepEqual(requested, []);
});

test("a redirect chain longer than the limit is refused", async () => {
  const { fetchImpl } = transportFor(
    Array.from({ length: 8 }, () => ({ status: 302, location: "https://cdn.example.com/next" }))
  );
  await assert.rejects(
    () =>
      safeFetch("https://cdn.example.com/start", {}, {
        resolver: PUBLIC_RESOLVER,
        fetchImpl,
        maxRedirects: 3,
      }),
    (err: unknown) => err instanceof RedirectLimitError
  );
});

test("a redirect without a location is returned as it is", async () => {
  const { requested, fetchImpl } = transportFor([{ status: 302 }]);
  const response = await safeFetch("https://cdn.example.com/live.m3u8", {}, {
    resolver: PUBLIC_RESOLVER,
    fetchImpl,
  });
  assert.equal(response.status, 302);
  assert.deepEqual(requested, ["https://cdn.example.com/live.m3u8"]);
});

test("stored credentials do not travel to another origin", async () => {
  const { seen, fetchImpl } = transportFor([
    { status: 302, location: "https://edge.example.net/live.m3u8" },
    { status: 200 },
  ]);
  await safeFetch(
    "https://cdn.example.com/live.m3u8",
    { headers: { Authorization: "Bearer secret", Cookie: "sid=1" } },
    { resolver: PUBLIC_RESOLVER, fetchImpl }
  );
  assert.equal(seen[0].headers.get("authorization"), "Bearer secret");
  assert.equal(seen[1].headers.get("authorization"), null);
  assert.equal(seen[1].headers.get("cookie"), null);
});

test("stored credentials survive a same-origin redirect", async () => {
  const { seen, fetchImpl } = transportFor([
    { status: 302, location: "https://cdn.example.com/other.m3u8" },
    { status: 200 },
  ]);
  await safeFetch(
    "https://cdn.example.com/live.m3u8",
    { headers: { Authorization: "Bearer secret" } },
    { resolver: PUBLIC_RESOLVER, fetchImpl }
  );
  assert.equal(seen[1].headers.get("authorization"), "Bearer secret");
});

test("a name that does not resolve is left to the request to report", async () => {
  const verdict = await checkHostResolvesPublic("gone.example.com", resolverFor({}));
  assert.equal(verdict.ok, true);
});

test("a name that resolves into the server's own network is refused", async () => {
  const verdict = await checkHostResolvesPublic("loop.example.com", PUBLIC_RESOLVER);
  assert.equal(verdict.ok, false);
  assert.ok((verdict.reason || "").length > 0);
});

test("a redirect target is resolved against the URL that produced it", () => {
  const verdict = checkRedirectTarget("https://cdn.example.com/a/b.m3u8", "../c.m3u8");
  assert.equal(verdict.ok, true);
  assert.equal(verdict.url, "https://cdn.example.com/c.m3u8");
});

test("a redirect target into the server's own network is refused", () => {
  const verdict = checkRedirectTarget(
    "https://cdn.example.com/a.m3u8",
    "http://169.254.169.254/latest/meta-data/"
  );
  assert.equal(verdict.ok, false);
  assert.ok((verdict.reason || "").length > 0);
});

test("isPrivateOrInternalAddress classifies addresses, not names", () => {
  const internal = [
    "127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.0.1", "172.31.0.1",
    "169.254.169.254", "0.0.0.0", "::1", "::", "fc00::1", "fd12:3456::1",
    "fe80::1", "::ffff:7f00:1", "::ffff:127.0.0.1", "::ffff:169.254.169.254",
  ];
  for (const address of internal) {
    assert.equal(isPrivateOrInternalAddress(address), true, `expected internal: ${address}`);
  }

  const publicAddresses = ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.15.0.1", "2606:2800:220:1::1"];
  for (const address of publicAddresses) {
    assert.equal(isPrivateOrInternalAddress(address), false, `expected public: ${address}`);
  }
});

test("isIpLiteral tells an address from a name", () => {
  for (const literal of ["127.0.0.1", "1.2.3.4", "::1", "[::1]", "fc00::1", "fe80::1%eth0"]) {
    assert.equal(isIpLiteral(literal), true, `expected literal: ${literal}`);
  }
  for (const name of ["example.com", "cdn.example.net", "gpcdn.net", ""]) {
    assert.equal(isIpLiteral(name), false, `expected name: ${name}`);
  }
});
