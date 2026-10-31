/**
 * Focused tests for the premium tier's entry rules (`lib/premiumFixtures.ts`): what a valid
 * premium channel row is, and what a push to the stream box must carry.
 *
 * Run with `npm run test:premium-channels` — that compiles the pure rule module plus this file
 * into `.tmp-tests/` and runs them on Node's own test runner. Nothing here touches MongoDB, the
 * network or a running server.
 *
 * The rules for a match card are not here: a card is the Direct HLS panel's own row, and its
 * rules live in `lib/fixtures.ts` (`npm run test:fixtures`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validatePremiumChannelInput,
  validatePremiumSourcePush,
} from "../lib/premiumFixtures";

const GOOD_CHANNEL = {
  name: "Example Sports HD",
  proxyChannelKey: "prem-example-sports",
};

test("a premium channel needs a name, and its box handle must be a lane name", () => {
  assert.deepEqual(validatePremiumChannelInput({}, true).errors, ["Channel name is required"]);

  // A handle is the only thing a row keeps about where the stream comes from, so it has to
  // be spellable by the box: a space or a slash would be refused there over an unrelated field.
  const badKey = validatePremiumChannelInput(
    { name: "X", proxyChannelKey: "Prem Example/sports" },
    true
  );
  assert.deepEqual(badKey.errors, [
    "Stream box handle must be 2-64 characters of letters, digits, - or _",
  ]);

  const good = validatePremiumChannelInput(GOOD_CHANNEL, true);
  assert.deepEqual(good.errors, []);
  // The fields the admin left alone arrive as their defaults, so a stored row is
  // always complete rather than partly absent.
  assert.equal(good.value.category, "Premium");
  assert.equal(good.value.active, true);
  assert.equal(good.value.sortOrder, 99);
  assert.equal(good.value.proxyChannelKey, "prem-example-sports");

  const noKey = validatePremiumChannelInput({ name: "X" }, true);
  assert.deepEqual(noKey.errors, []);
  assert.equal(noKey.value.proxyChannelKey, "");

  // Entered in any case, stored in the box's own.
  assert.equal(
    validatePremiumChannelInput({ proxyChannelKey: "Prem-MixEd1" }, false).value.proxyChannelKey,
    "prem-mixed1"
  );
});

test("a patch only validates the keys that were sent", () => {
  // A single switch flip is the commonest write and must never re-ask for the name.
  const toggle = validatePremiumChannelInput({ active: false }, false);
  assert.deepEqual(toggle.errors, []);
  assert.deepEqual(toggle.value, { active: false });

  // With `creating` the same body is rejected, so a create cannot arrive half-empty.
  assert.equal(validatePremiumChannelInput({ active: false }, true).errors.length, 1);
});

test("a rail position outside the form's own range is refused", () => {
  assert.equal(validatePremiumChannelInput({ sortOrder: 0 }, false).errors.length, 1);
  assert.equal(validatePremiumChannelInput({ sortOrder: 1000 }, false).errors.length, 1);
  assert.equal(validatePremiumChannelInput({ sortOrder: 3 }, false).value.sortOrder, 3);
});

test("a push to the box carries one manifest URL and at most two headers", () => {
  assert.deepEqual(validatePremiumSourcePush({}).errors, ["Source URL is required"]);
  assert.deepEqual(validatePremiumSourcePush({ sourceUrl: "ftp://host/one.m3u8" }).errors, [
    "Source URL must be a valid http(s) URL",
  ]);
  assert.deepEqual(
    validatePremiumSourcePush({ sourceUrl: `https://host/${"x".repeat(2100)}` }).errors,
    ["Source URL must be a valid http(s) URL"]
  );

  const ok = validatePremiumSourcePush({
    sourceUrl: "https://host/live/one/index.m3u8?token=abc",
    userAgent: "Mozilla/5.0",
    referer: "https://partner.example",
  });
  assert.deepEqual(ok.errors, []);
  // All three keys are always answered, so the route that pushes never has to guess at
  // an absent header.
  assert.deepEqual(ok.value, {
    sourceUrl: "https://host/live/one/index.m3u8?token=abc",
    userAgent: "Mozilla/5.0",
    referer: "https://partner.example",
  });

  // A header value with a line break in it is a second header by the time it reaches the
  // origin, so it is refused here rather than arriving as an unexplained transport error.
  assert.deepEqual(validatePremiumSourcePush({ sourceUrl: "https://h/a.m3u8", userAgent: "A\r\nX-Injected: 1" }).errors, [
    "User-Agent must not contain a line break",
  ]);
  assert.deepEqual(validatePremiumSourcePush({ sourceUrl: "https://h/a.m3u8", referer: "/relative" }).errors, [
    "Referer must be an absolute URL, or empty",
  ]);
  assert.deepEqual(validatePremiumSourcePush({ sourceUrl: "https://h/a.m3u8", referer: "ftp://h" }).errors, [
    "Referer must be an http(s) URL",
  ]);
  // No headers at all is the normal case: the source needs nothing of its own.
  assert.deepEqual(validatePremiumSourcePush({ sourceUrl: "https://h/a.m3u8" }).value, {
    sourceUrl: "https://h/a.m3u8",
    userAgent: "",
    referer: "",
  });
});
