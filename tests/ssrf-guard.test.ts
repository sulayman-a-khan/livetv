/**
 * Focused tests for the server-side request-forgery guard (`lib/ssrfGuard.ts`).
 *
 * Run with `npm run test:ssrf-guard` — compiles the pure guard plus this file
 * into `.tmp-tests/` and runs it on Node's own test runner. No network, no DB.
 *
 * The guard is a hostname-literal + scheme check: it must reject every private,
 * loopback, link-local and metadata literal (and any non-http(s) scheme) while
 * allowing the public http/https origins the catalogue actually uses. Vectors
 * here are pinned against Node's real `new URL(...).hostname` output, including
 * the hex-normalised IPv4-mapped IPv6 form that a dotted-decimal check misses.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPublicUrlSafety, isPrivateOrInternalHost } from "../lib/ssrfGuard";

const ALLOWED = [
  "https://example.com/playlist.m3u8",
  "http://210.4.72.204/hls-live/livepkgr/_definst_/liveevent/livestream.m3u8",
  "https://byphdgllyk.gpcdn.net/hls/deeptotv/0_1/index.m3u8",
  "https://www.youtube.com/watch?v=5FW9ZVMR_7M",
  "http://172.15.0.1/stream.m3u8", // just below the 172.16/12 private band
  "http://172.32.0.1/stream.m3u8", // just above the 172.16/12 private band
  "https://sub.domain.co.uk/a/b?c=d#e",
];

const REJECTED = [
  // loopback
  "http://127.0.0.1:3000/admin",
  "http://127.1/x",
  "http://localhost/secret",
  "http://api.localhost/x",
  // cloud metadata + link-local
  "http://169.254.169.254/latest/meta-data/",
  "http://169.254.1.1/x",
  // private ranges
  "http://10.0.0.5/internal",
  "http://192.168.1.1/router",
  "http://172.16.0.1/x",
  "http://172.31.255.255/x",
  // "this" network
  "http://0.0.0.0/x",
  // IPv6 loopback / unspecified / unique-local / link-local
  "http://[::1]/x",
  "http://[::]/x",
  "http://[fc00::1]/x",
  "http://[fd12:3456::1]/x",
  "http://[fe80::1]/x",
  // IPv4-mapped IPv6 — Node normalises the dotted form to hex; both must block
  "http://[::ffff:127.0.0.1]/x",
  "http://[::ffff:7f00:1]/x",
  "http://[::ffff:169.254.169.254]/x",
  // disallowed schemes
  "file:///etc/passwd",
  "gopher://internal/x",
  "ftp://10.0.0.1/x",
  // not absolute / empty
  "example.com/no-scheme",
  "",
  "   ",
];

test("public http(s) origins are allowed", () => {
  for (const url of ALLOWED) {
    const verdict = checkPublicUrlSafety(url);
    assert.equal(verdict.ok, true, `expected ALLOW for ${url} (got: ${verdict.reason})`);
    assert.equal(typeof verdict.url, "string");
  }
});

test("private/internal/metadata/bad-scheme URLs are rejected", () => {
  for (const url of REJECTED) {
    const verdict = checkPublicUrlSafety(url);
    assert.equal(verdict.ok, false, `expected REJECT for ${url}`);
    assert.equal(typeof verdict.reason, "string");
    assert.ok((verdict.reason || "").length > 0, `expected a reason for ${url}`);
  }
});

test("isPrivateOrInternalHost classifies host literals", () => {
  const internal = [
    "localhost", "a.localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1",
    "172.16.0.1", "172.31.0.1", "169.254.169.254", "0.0.0.0",
    "[::1]", "::1", "[::]", "::", "[fc00::1]", "[fe80::1]",
    "[::ffff:7f00:1]", "[::ffff:127.0.0.1]",
  ];
  for (const h of internal) {
    assert.equal(isPrivateOrInternalHost(h), true, `expected internal: ${h}`);
  }
  const publicHosts = [
    "example.com", "210.4.72.204", "172.15.0.1", "172.32.0.1",
    "8.8.8.8", "gpcdn.net", "1.1.1.1",
  ];
  for (const h of publicHosts) {
    assert.equal(isPrivateOrInternalHost(h), false, `expected public: ${h}`);
  }
});

test("rejection never throws and always carries a reason", () => {
  const odd = [null, undefined, 123, {}, "http://", "https://"];
  for (const value of odd as unknown as string[]) {
    let verdict;
    assert.doesNotThrow(() => { verdict = checkPublicUrlSafety(value); });
    // "http://" / "https://" parse but have an empty host, which is not a
    // private literal — they are allowed by the host check; we only assert the
    // call is total and returns a well-shaped verdict.
    assert.equal(typeof verdict!.ok, "boolean");
    if (!verdict!.ok) assert.equal(typeof verdict!.reason, "string");
  }
});
