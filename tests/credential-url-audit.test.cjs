/**
 * Tests for the credential-URL audit (`scripts/audit-credential-urls.mjs`).
 *
 * The script runs against a real database only when invoked, so these tests
 * exercise its pure half: detection, redaction and the two quarantine
 * documents. The central rule is that no report line may contain a secret.
 *
 * Run with `npm run test:credential-audit`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../scripts/audit-credential-urls.mjs");

test("userinfo is detected on HTTP and HTTPS addresses", async () => {
  const { credentialEvidence } = await load();

  const https = credentialEvidence("https://alice:s3cret@stream.example:8443/live/a.m3u8");
  assert.deepEqual(https, {
    scheme: "https",
    host: "stream.example:8443",
    username: true,
    password: true,
  });

  assert.equal(credentialEvidence("http://token@stream.example/a.ts").username, true);
  assert.equal(credentialEvidence("http://token@stream.example/a.ts").password, false);
});

test("an @ in the path or query is not a credential", async () => {
  const { credentialEvidence } = await load();

  assert.equal(credentialEvidence("https://stream.example/a@b/playlist.m3u8"), null);
  assert.equal(credentialEvidence("https://stream.example/a.m3u8?contact=user@example.com"), null);
  assert.equal(credentialEvidence("https://stream.example/a.m3u8"), null);
  assert.equal(credentialEvidence(""), null);
  assert.equal(credentialEvidence(null), null);
});

test("redaction removes the userinfo and keeps the rest byte for byte", async () => {
  const { redactUserinfo } = await load();

  assert.equal(
    redactUserinfo("https://alice:s3cret@stream.example:8443/Live/A%2Fb.m3u8?token=AbC#frag"),
    "https://stream.example:8443/Live/A%2Fb.m3u8?token=AbC#frag"
  );
  assert.equal(
    redactUserinfo("HTTP://user:p%40ss@stream.example/a.ts"),
    "HTTP://stream.example/a.ts"
  );
  assert.equal(
    redactUserinfo("https://stream.example/a.m3u8"),
    "https://stream.example/a.m3u8"
  );
});

test("the report line never names the username or password", async () => {
  const { credentialEvidence, reportLine } = await load();

  const line = reportLine(
    "streamlinks",
    "64b5c72de29c995275489eaa",
    "url",
    credentialEvidence("https://alice:s3cret@stream.example/live/a.m3u8")
  );

  assert.match(line, /collection=streamlinks/);
  assert.match(line, /host=stream\.example/);
  assert.match(line, /password=yes/);
  assert.doesNotMatch(line, /alice/);
  assert.doesNotMatch(line, /s3cret/);
  assert.doesNotMatch(line, /\/live\//);
});

test("a malformed legacy address is still found and redacted", async () => {
  const { credentialEvidence, redactUserinfo } = await load();

  // The WHATWG parser rejects an address with no host; the fallback still has
  // to see the userinfo, because a legacy row is exactly where it turns up.
  const evidence = credentialEvidence("http://user:pass@");
  assert.ok(evidence);
  assert.equal(redactUserinfo("http://user:pass@"), "http://");
});

test("quarantining a stream link disables it and strips the credential", async () => {
  const { streamLinkQuarantine } = await load();

  const update = streamLinkQuarantine(
    {
      url: "http://alice:s3cret@stream.example/a.ts",
      failedAttempts: 0,
      firstFailedAt: null,
      lastCheck: { finalUrl: "http://alice:s3cret@cdn.example/a.ts" },
    },
    "2026-11-07T00:00:00.000Z"
  );

  assert.equal(update.$set.adminDisabled, true);
  assert.equal(update.$set.status, "broken");
  assert.equal(update.$set.failedAttempts, 1);
  assert.equal(update.$set.firstFailedAt, "2026-11-07T00:00:00.000Z");
  assert.equal(update.$set.url, "http://stream.example/a.ts");
  assert.equal(update.$set.browserBlocker, null);
  assert.deepEqual(update.$unset, { "lastCheck.finalUrl": "" });
  assert.doesNotMatch(JSON.stringify(update.$set), /alice|s3cret/);
});

test("quarantining a playlist entry marks it missing and strips both keys", async () => {
  const { playlistEntryQuarantine } = await load();

  const update = playlistEntryQuarantine(
    {
      url: "https://alice:s3cret@stream.example/a.m3u8",
      canonicalUrl: "https://alice:s3cret@stream.example/a.m3u8",
    },
    "2026-11-07T00:00:00.000Z"
  );

  assert.equal(update.$set.status, "missing");
  assert.equal(update.$set.lastMissingAt, "2026-11-07T00:00:00.000Z");
  assert.equal(update.$set.url, "https://stream.example/a.m3u8");
  assert.equal(update.$set.canonicalUrl, "https://stream.example/a.m3u8");
  assert.doesNotMatch(JSON.stringify(update.$set), /alice|s3cret/);
});