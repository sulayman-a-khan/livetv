/**
 * Focused tests for the release manifest reader (`lib/appRelease.ts`).
 *
 * Run with `npm run test:app-release` — compiles the reader plus this file into
 * `.tmp-tests/` and runs it on Node's own test runner. Nothing here reaches
 * the network: the fetch is stood in for.
 *
 * The reader has one job and one rule: a document that names a build is
 * served, and a document that does not is not — and a failed read must not
 * lose the release that was read last.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isUsableManifest,
  readUpdateManifest,
  type ManifestCache,
} from "../lib/appRelease";

const PUBLISHED = JSON.stringify({
  schemaVersion: 1,
  appId: "com.soluplay.app",
  versionCode: 2,
  versionName: "0.2.0",
  apkUrl: "https://example.com/soluplay-0.2.0.apk",
  sha256: "a".repeat(64),
});

/** A fetch that answers with a body. */
function answering(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

/** A fetch that never answers. */
function failing(): typeof fetch {
  return (async () => {
    throw new Error("the address cannot be reached");
  }) as unknown as typeof fetch;
}

/** A cache of this test's own, so one test cannot leave a copy behind for another. */
function freshCache(): ManifestCache {
  return { current: null };
}

test("a document that names a build is a manifest", () => {
  assert.equal(isUsableManifest(PUBLISHED), true);
});

test("a document with no build number is not a manifest", () => {
  assert.equal(isUsableManifest(JSON.stringify({ versionCode: 0 })), false);
  assert.equal(isUsableManifest(JSON.stringify({ versionName: "0.2.0" })), false);
});

test("a body that is not JSON is not a manifest", () => {
  assert.equal(isUsableManifest("<html>not a manifest</html>"), false);
  assert.equal(isUsableManifest(""), false);
});

test("a list is not a manifest", () => {
  assert.equal(isUsableManifest("[1, 2, 3]"), false);
});

test("the manifest is served exactly as it was published", async () => {
  const cache = freshCache();

  const body = await readUpdateManifest(answering(PUBLISHED), cache);

  assert.equal(body, PUBLISHED);
});

test("a document that is not a manifest is refused and leaves the last copy alone", async () => {
  const cache = freshCache();
  await readUpdateManifest(answering(PUBLISHED), cache);

  const body = await readUpdateManifest(answering("<html>not a manifest</html>"), cache);

  assert.equal(body, PUBLISHED);
});

test("an address that cannot be reached does not lose the release", async () => {
  const cache = freshCache();
  await readUpdateManifest(answering(PUBLISHED), cache);

  const body = await readUpdateManifest(failing(), cache);

  assert.equal(body, PUBLISHED);
});

test("an address that answers with a failure is not a manifest", async () => {
  const cache = freshCache();

  const body = await readUpdateManifest(answering("not found", 404), cache);

  assert.equal(body, null);
});

test("nothing read and nothing known is nothing to serve", async () => {
  const cache = freshCache();

  const body = await readUpdateManifest(failing(), cache);

  assert.equal(body, null);
});
