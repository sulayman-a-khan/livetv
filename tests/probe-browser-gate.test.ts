/**
 * Tests for when a probe result may become a browser verdict
 * (`lib/streamProbe.ts`'s `browserGateApplies`).
 *
 * The failure this prevents: a CDN answers the probe with HTTP 429 and no CORS
 * header. Filing that as "the browser is blocked" hides a working link from the
 * website until a later probe happens to get through. A rate limit is a health
 * answer, not a statement about the viewer's browser.
 *
 * Run with `npm run test:probe-gate`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { browserGateApplies } from "../lib/browserGate";

test("a rate-limited answer is not a browser verdict", () => {
  assert.equal(browserGateApplies("DEGRADED", "RATE_LIMITED"), false);
});

test("media-serving verdicts may become browser verdicts", () => {
  assert.equal(browserGateApplies("ONLINE", "OK"), true);
  assert.equal(browserGateApplies("DEGRADED", "NO_SEGMENTS_LISTED"), true);
  assert.equal(browserGateApplies("DEGRADED", "PARTIAL_SEGMENTS_UNAVAILABLE"), true);
});

test("a failed probe is not a browser verdict", () => {
  assert.equal(browserGateApplies("OFFLINE", "SERVER_ERROR"), false);
  assert.equal(browserGateApplies("BLOCKED", "ACCESS_DENIED"), false);
  assert.equal(browserGateApplies("EXPIRED", "TOKEN_EXPIRED"), false);
});