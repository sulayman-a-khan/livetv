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
  "http://100.63.0.1/stream.m3u8", // just below the 100.64/10 carrier-grade NAT band
  "http://100.128.0.1/stream.m3u8", // just above the 100.64/10 carrier-grade NAT band
  "http://198.17.0.1/stream.m3u8", // just below the 198.18/15 benchmarking band
  "http://198.20.0.1/stream.m3u8", // just above the 198.18/15 benchmarking band
  "http://223.255.255.255/stream.m3u8", // just below the multicast band
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
  // carrier-grade NAT
  "http://100.64.0.1/x",
  "http://100.127.255.254/x",
  "http://100.100.100.200/latest/meta-data/",
  // "this" network
  "http://0.0.0.0/x",
  // never routable: protocol assignments, documentation, benchmarking,
  // multicast and reserved
  "http://192.0.0.1/x",
  "http://192.0.2.1/x",
  "http://198.18.0.1/x",
  "http://198.51.100.1/x",
  "http://203.0.113.1/x",
  "http://224.0.0.1/x",
  "http://239.255.255.255/x",
  "http://240.0.0.1/x",
  "http://255.255.255.255/x",
  // IPv6 loopback / unspecified / unique-local / link-local
  "http://[::1]/x",
  "http://[::]/x",
  "http://[fc00::1]/x",
  "http://[fd12:3456::1]/x",
  "http://[fe80::1]/x",
  // IPv6 multicast, documentation and NAT64
  "http://[ff02::1]/x",
  "http://[2001:db8::1]/x",
  "http://[64:ff9b::1]/x",
  "http://[64:ff9b:1::1]/x",
  // IPv4-mapped IPv6 — Node normalises the dotted form to hex; both must block
  "http://[::ffff:127.0.0.1]/x",
  "http://[::ffff:7f00:1]/x",
  "http://[::ffff:169.254.169.254]/x",
  // IPv4-compatible IPv6
  "http://[::127.0.0.1]/x",
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
    "100.64.0.1", "100.127.255.254", "192.0.0.1", "198.18.0.1",
    "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "[::1]", "::1", "[::]", "::", "[fc00::1]", "[fe80::1]",
    "[ff02::1]", "[2001:db8::1]", "[64:ff9b::1]",
    "[::ffff:7f00:1]", "[::ffff:127.0.0.1]",
  ];
  for (const h of internal) {
    assert.equal(isPrivateOrInternalHost(h), true, `expected internal: ${h}`);
  }
  const publicHosts = [
    "example.com", "210.4.72.204", "172.15.0.1", "172.32.0.1",
    "100.63.0.1", "100.128.0.1", "198.17.0.1", "198.20.0.1",
    "223.255.255.255", "2606:2800:220:1::1",
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
