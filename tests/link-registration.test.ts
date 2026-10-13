/**
 * Regression tests for the two approved Direct HLS fixes.
 *
 *   1. The TLS-chain recovery branch reports the playlist leg as `responseTime`, so
 *      the existing `SLOW_LATENCY_MS` comparison and the existing ranking bands
 *      judge the same quantity they judge for every other probe result.
 *   2. Registering a new link accepts a `DEGRADED` verdict that actually held media,
 *      and still refuses one that only proved reachability.
 *
 * Both are judged through the pure rules in `lib/streamHealth.ts`, which is what the
 * add-time writers and the scheduled pass call. The recovery walk itself needs a
 * public HTTPS origin whose certificate chain Node cannot build, so it is verified
 * from its stored evidence (`lastCheck.responseTime` / `lastCheck.error`) instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SLOW_LATENCY_MS,
  classifyLinkHealth,
  decideStreamHealth,
  isUsableViewerLink,
  probeEstablishesPlayability,
  type LinkHealthInput,
  type StoredStreamStatus,
} from "../lib/streamHealth";
import { compareStreamRank, rankStreams, type MaintStream } from "../lib/channelMaintenance";

/** The narrow verdict shape the registration rule reads — no prober needed. */
type ProbeVerdict = Parameters<typeof probeEstablishesPlayability>[0];
/** What a pass hands `decideStreamHealth`. */
type CheckResult = Parameters<typeof decideStreamHealth>[3];

function verdict(over: Partial<ProbeVerdict> & Pick<ProbeVerdict, "status">): ProbeVerdict {
  return {
    ok: over.status === "ONLINE",
    errorCode: over.status === "ONLINE" ? "OK" : "UNKNOWN_ERROR",
    segmentCount: null,
    playlistType: null,
    ...over,
  };
}

function checkResult(over: Partial<CheckResult> & Pick<CheckResult, "status">): CheckResult {
  return {
    ok: over.status === "ONLINE",
    errorCode: over.status === "ONLINE" ? "OK" : "UNKNOWN_ERROR",
    latency: 0,
    responseTime: 0,
    httpStatus: over.status === "ONLINE" ? 200 : null,
    playlistType: null,
    isLive: null,
    segmentCount: null,
    latestSegment: null,
    newSegmentDetected: null,
    video: null,
    audio: null,
    resolution: null,
    codec: null,
    fps: null,
    attempts: 1,
    checkedAt: "2026-10-13T09:00:00.000Z",
    error: null,
    browserCors: null,
    browserBlocker: null,
    deliveryMisses: 0,
    ...over,
  } as CheckResult;
}

/** A stored link, defaulted to what a link looks like right after a pass wrote it. */
function stored(over: Partial<LinkHealthInput>): LinkHealthInput {
  const { status = "active", ...rest } = over;
  return {
    status: status as StoredStreamStatus,
    failedAttempts: 0,
    latency: 0,
    lastCheckedAt: new Date("2026-10-13T09:00:00.000Z"),
    ...rest,
  };
}

/** The verdict a pass writes for a link the certificate recovery walk rescued. */
function rescuedDecision(playlistMs: number) {
  return decideStreamHealth(
    "active",
    0,
    null,
    checkResult({
      status: "DEGRADED",
      errorCode: "TLS_CHAIN_UNVERIFIED",
      playlistType: "MEDIA",
      segmentCount: 6,
      latency: playlistMs,
      responseTime: playlistMs,
    }),
    new Date("2026-10-13T09:00:00.000Z")
  );
}

function mirror(over: Partial<MaintStream> & { _id: string }): MaintStream {
  return {
    channelId: "ch1",
    url: `https://${over._id}.cdn.tv/live.m3u8`,
    priority: 1,
    status: "active",
    latency: 0,
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * Fix 1 — a corrected measurement, judged by rules that did not move.
 * ------------------------------------------------------------------ */

test("the slow threshold and its boundary are the values the fix was judged against", () => {
  assert.equal(SLOW_LATENCY_MS, 1200);
  assert.equal(classifyLinkHealth(stored({ latency: 1200 })), "healthy");
  assert.equal(classifyLinkHealth(stored({ latency: 1201 })), "slow");
});

test("a recovered link is stored on its playlist leg, not on the whole walk", () => {
  const d = rescuedDecision(640);
  assert.equal(d.latency, 640);
  assert.equal(classifyLinkHealth(stored({ latency: d.latency })), "healthy");
});

test("a recovered link whose playlist genuinely is slow still reads slow", () => {
  const d = rescuedDecision(2100);
  assert.equal(d.latency, 2100);
  assert.equal(classifyLinkHealth(stored({ latency: d.latency })), "slow");
});

test("ranking still asks the same two questions of a recovered link: health, then speed band", () => {
  const recoveredFast = mirror({ _id: "recovered", priority: 1, latency: 640 });
  const onlineFaster = mirror({ _id: "online", priority: 2, latency: 200 });
  // Different bands (1 vs 0): the quicker mirror keeps Server 1 — no promotion.
  assert.ok(compareStreamRank(onlineFaster, recoveredFast) < 0);

  const onlineSameBand = mirror({ _id: "online", priority: 2, latency: 700 });
  // Same band (1 vs 1) and same health: the stored priority decides, as before.
  assert.ok(compareStreamRank(recoveredFast, onlineSameBand) < 0);
  assert.deepEqual(rankStreams([onlineSameBand, recoveredFast]).map((m) => m._id), ["recovered", "online"]);

  const notDelivering = mirror({ _id: "sick", priority: 1, latency: 60, deliveryMisses: 1 });
  // A recovered link still cannot beat a link the catalogue refuses.
  assert.ok(compareStreamRank(recoveredFast, notDelivering) < 0);
});

/* ------------------------------------------------------------------ *
 * Fix 2 — the evidence a new link must show to be registered working.
 * ------------------------------------------------------------------ */

test("a probe that held media registers the link as working", () => {
  assert.equal(
    probeEstablishesPlayability(verdict({ status: "ONLINE", ok: true, playlistType: "MEDIA", segmentCount: 12 })),
    true
  );
  for (const delivered of [
    verdict({ status: "DEGRADED", errorCode: "TLS_CHAIN_UNVERIFIED", playlistType: "MEDIA", segmentCount: 4 }),
    verdict({ status: "DEGRADED", errorCode: "PARTIAL_SEGMENTS_UNAVAILABLE", playlistType: "MEDIA", segmentCount: 3 }),
    verdict({ status: "DEGRADED", errorCode: "FFPROBE_DECODE_FAILED", playlistType: "MEDIA", segmentCount: 6 }),
    // A raw `.ts` feed lists no playlist; bytes on the wire are its media evidence.
    verdict({ status: "DEGRADED", errorCode: "TLS_CHAIN_UNVERIFIED", playlistType: null, segmentCount: null }),
  ]) {
    assert.equal(probeEstablishesPlayability(delivered), true);
  }
});

test("a degraded answer with no media in hand does not register as working", () => {
  for (const noMedia of [
    // Manifest served, nothing listed to download yet.
    verdict({ status: "DEGRADED", errorCode: "NO_SEGMENTS_LISTED", playlistType: "MEDIA", segmentCount: 0 }),
    // The same gap reported through the recovery walk.
    verdict({ status: "DEGRADED", errorCode: "TLS_CHAIN_UNVERIFIED", playlistType: "MEDIA", segmentCount: 0 }),
    // A 429: reachable, and it asked us to come back later.
    verdict({ status: "DEGRADED", errorCode: "RATE_LIMITED", playlistType: null, segmentCount: null }),
  ]) {
    assert.equal(probeEstablishesPlayability(noMedia), false);
  }
});

test("every other failure status keeps its existing registration behaviour", () => {
  for (const failed of [
    verdict({ status: "OFFLINE", errorCode: "SEGMENTS_UNAVAILABLE", playlistType: "MEDIA", segmentCount: 9 }),
    verdict({ status: "TIMEOUT", errorCode: "TIMEOUT", playlistType: null, segmentCount: null }),
    verdict({ status: "UNDELIVERABLE", errorCode: "DELIVERY_DEADLINE", playlistType: null, segmentCount: null }),
    verdict({ status: "INVALID", errorCode: "HTML_ERROR_PAGE", playlistType: null, segmentCount: null }),
    verdict({ status: "EXPIRED", errorCode: "TOKEN_EXPIRED", playlistType: null, segmentCount: null }),
    verdict({ status: "BLOCKED", errorCode: "ACCESS_DENIED", playlistType: null, segmentCount: null }),
    verdict({ status: "UNPLAYABLE", errorCode: "BROWSER_CORS_BLOCKED", playlistType: "MEDIA", segmentCount: 8 }),
  ]) {
    assert.equal(probeEstablishesPlayability(failed), false);
  }
});

/* ------------------------------------------------------------------ *
 * What must not have moved: the pass rules and the visibility gates.
 * ------------------------------------------------------------------ */

test("the pass still counts a degraded verdict that delivered as working", () => {
  const d = decideStreamHealth(
    "broken",
    2,
    new Date("2026-10-12T09:00:00.000Z"),
    checkResult({
      status: "DEGRADED",
      errorCode: "TLS_CHAIN_UNVERIFIED",
      playlistType: "MEDIA",
      segmentCount: 4,
      latency: 700,
    }),
    new Date("2026-10-13T09:00:00.000Z")
  );
  assert.equal(d.status, "active");
  assert.equal(d.failedAttempts, 0);
  assert.equal(d.firstFailedAt, null);
  assert.equal(d.deliveryMisses, 0);
  assert.equal(d.deliveryHidden, false);
});

test("a starved link is still hidden by the unchanged delivery rule", () => {
  const d = decideStreamHealth(
    "active",
    0,
    null,
    checkResult({ status: "UNDELIVERABLE", errorCode: "DELIVERY_DEADLINE", deliveryMisses: 2 }),
    new Date("2026-10-13T09:00:00.000Z")
  );
  assert.equal(d.status, "broken");
  assert.equal(d.deliveryHidden, true);
  assert.equal(
    isUsableViewerLink({ status: d.status, deliveryHidden: d.deliveryHidden, deliveryMisses: d.deliveryMisses }),
    false
  );
});

test("classification precedence is untouched: blocked, not delivering, dead, disabled", () => {
  assert.equal(classifyLinkHealth(stored({ status: "broken", browserBlocker: "CORS_BLOCKED", latency: 40 })), "unplayable");
  assert.equal(classifyLinkHealth(stored({ status: "active", deliveryMisses: 1, latency: 40 })), "delivery-failed");
  assert.equal(classifyLinkHealth(stored({ status: "broken", deliveryMisses: 0 })), "dead");
  assert.equal(classifyLinkHealth(stored({ status: "active", adminDisabled: true, latency: 40 })), "disabled");
  assert.equal(classifyLinkHealth(stored({ status: "active", failedAttempts: 1 })), "temporarily-failed");
  assert.equal(classifyLinkHealth(stored({ status: "active", lastCheckedAt: null })), "unverified");
});

test("a slow-but-working link stays in the viewer catalogue", () => {
  assert.equal(classifyLinkHealth(stored({ latency: 4000 })), "slow");
  assert.equal(isUsableViewerLink({ status: "active", deliveryMisses: 0, deliveryHidden: false }), true);
});
