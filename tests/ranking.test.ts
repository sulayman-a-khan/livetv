/**
 * Focused tests for SoluPlay's link ranking rule (`lib/channelMaintenance.ts`).
 *
 * Run with `npm run test:ranking` — that compiles the pure rule modules plus this
 * file into `.tmp-tests/` and runs it on Node's own test runner. Nothing here
 * touches MongoDB, the network, or a running server.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareStreamRank,
  planChannelLinkRefresh,
  planMaintenance,
  rankStreams,
  rankingShifted,
  type MaintChannel,
  type MaintStream,
} from "../lib/channelMaintenance";
import {
  decideStreamHealth,
  isUsableViewerLink,
  type StreamHealthDecision,
} from "../lib/streamHealth";

/** What `decideStreamHealth` is handed, without pulling the prober into the test. */
type ProbeResult = Parameters<typeof decideStreamHealth>[3];

/** A check that put media in the player's hands in `latency` ms. */
const delivered = (latency: number): ProbeResult =>
  ({ ok: true, status: "DEGRADED", latency, deliveryMisses: 0 }) as unknown as ProbeResult;

/** A check that got nothing inside the delivery budget, twice over. */
const starved = (): ProbeResult =>
  ({ ok: false, status: "NO_MEDIA", latency: 0, deliveryMisses: 2 }) as unknown as ProbeResult;

/** A stored link, defaulted to the fields every ranked row carries. */
function link(over: Partial<MaintStream> & { _id: string }): MaintStream {
  return {
    channelId: "c1",
    url: `https://${over._id}.cdn.tv/live.m3u8`,
    priority: 1,
    status: "active",
    latency: 0,
    ...over,
  };
}

/** A link as it looks after a health pass wrote its verdict. */
function withDecision(s: MaintStream, d: StreamHealthDecision): MaintStream {
  return {
    ...s,
    status: d.status,
    latency: d.latency,
    failedAttempts: d.failedAttempts,
    deliveryHidden: d.deliveryHidden,
    deliveryMisses: d.deliveryMisses,
  };
}

const ids = (streams: MaintStream[]) => streams.map((s) => s._id);

test("video that actually arrives beats a quicker link that keeps failing", () => {
  const steady = link({ _id: "steady", priority: 2, latency: 900 });
  const streaked = link({ _id: "streaked", priority: 1, latency: 90, failedAttempts: 2 });

  assert.deepEqual(ids(rankStreams([streaked, steady])), ["steady", "streaked"]);
});

test(`a link already labelled "Not delivering" is never Server 1`, () => {
  const delivering = link({ _id: "delivering", priority: 2, latency: 700 });
  // `status` is still `active` — only the unpaid delivery miss says otherwise,
  // which is exactly the link the catalogue refuses and the rank must match.
  const notDelivering = link({ _id: "not-delivering", latency: 120, deliveryMisses: 1 });

  assert.equal(isUsableViewerLink(notDelivering), false);
  assert.deepEqual(ids(rankStreams([notDelivering, delivering])), ["delivering", "not-delivering"]);
});

test("unusable links rank below every usable one, in order of how far they are from playing", () => {
  const usable = link({ _id: "usable", latency: 800 });
  const streaked = link({ _id: "streaked", latency: 800, failedAttempts: 1 });
  const retrying = link({ _id: "retrying", status: "degraded", latency: 100 });
  const dead = link({ _id: "dead", status: "broken" });
  const disabled = link({ _id: "disabled", adminDisabled: true, latency: 40 });

  assert.deepEqual(
    ids(rankStreams([disabled, dead, retrying, streaked, usable])),
    ["usable", "streaked", "retrying", "dead", "disabled"]
  );
});

test("a link the checker never timed does not lead on a 0 ms latency", () => {
  const measured = link({ _id: "measured", priority: 2, latency: 400 });
  const fresh = link({ _id: "fresh", priority: 1, latency: 0 });

  assert.deepEqual(ids(rankStreams([fresh, measured])), ["measured", "fresh"]);
});

test("response times within one band keep the ladder where it was", () => {
  const first = link({ _id: "first", priority: 1, latency: 300 });
  const quicker = link({ _id: "quicker", priority: 2, latency: 120 });
  assert.deepEqual(ids(rankStreams([first, quicker])), ["first", "quicker"]);
  assert.equal(rankingShifted(first, { ...first, latency: 340 }), false);

  // A real gap — a different band — does move it, priority number or not.
  const fast = link({ _id: "fast", priority: 2, latency: 520 });
  const slow = link({ _id: "slow", priority: 1, latency: 1500 });
  assert.deepEqual(ids(rankStreams([slow, fast])), ["fast", "slow"]);
});

test("links with nothing to separate them rank deterministically", () => {
  const a = link({ _id: "aaa" });
  const b = link({ _id: "bbb" });

  assert.deepEqual(ids(rankStreams([b, a])), ["aaa", "bbb"]);
  assert.equal(compareStreamRank(a, a), 0);
});

test("a recovering link becomes eligible, is ranked again, and asks for a refresh", () => {
  const holding = link({ _id: "holding", latency: 700 });
  const recovering = link({
    _id: "recovering",
    priority: 2,
    status: "broken",
    failedAttempts: 3,
    deliveryHidden: true,
    deliveryMisses: 2,
    lastCountedFailureDay: "2026-10-11",
  });
  assert.deepEqual(ids(rankStreams([holding, recovering])), ["holding", "recovering"]);

  const recovered = withDecision(
    recovering,
    decideStreamHealth(
      recovering.status,
      recovering.failedAttempts || 0,
      null,
      delivered(210),
      new Date("2026-10-12T06:00:00Z"),
      recovering.lastCountedFailureDay,
      { deliveryHidden: true, deliveryMisses: 2 }
    )
  );

  assert.equal(isUsableViewerLink(recovered), true);
  assert.equal(rankingShifted(recovering, recovered), true);
  assert.deepEqual(ids(rankStreams([holding, recovered])), ["recovering", "holding"]);
});

test("a link that stops delivering is moved out of the way by the same rule", () => {
  const clean = link({ _id: "clean", latency: 600 });
  const failing = link({ _id: "failing", latency: 600 });

  const hidden = withDecision(
    failing,
    decideStreamHealth(
      failing.status,
      failing.failedAttempts || 0,
      null,
      starved(),
      new Date("2026-10-12T06:00:00Z"),
      null,
      { deliveryHidden: false, deliveryMisses: 0 }
    )
  );

  assert.equal(hidden.deliveryHidden, true);
  assert.equal(rankingShifted(failing, hidden), true);
  assert.deepEqual(ids(rankStreams([hidden, clean])), ["clean", "failing"]);
});

test("priority refresh renumbers only the links that are out of place", () => {
  const ladder = [
    link({ _id: "dead", priority: 1, status: "broken" }),
    link({ _id: "quick", priority: 3, latency: 400 }),
    link({ _id: "slow", priority: 2, latency: 1500 }),
  ];

  const { streamPatches } = planChannelLinkRefresh("c1", ladder);
  // `slow` already holds the number the new order gives it, so it is not rewritten.
  assert.deepEqual(streamPatches, [
    { _id: "quick", channelId: "c1", priority: 1 },
    { _id: "dead", channelId: "c1", priority: 3 },
  ]);

  // Applying those patches leaves the next pass with nothing to write at all.
  const reranked = ladder.map((s) => {
    const patch = streamPatches.find((p) => p._id === s._id);
    return patch ? { ...s, priority: patch.priority } : s;
  });
  assert.deepEqual(planChannelLinkRefresh("c1", reranked).streamPatches, []);
});

test("a refresh re-ranks an admin-disabled link but never touches the switch", () => {
  const ladder = [
    link({ _id: "disabled", priority: 1, adminDisabled: true, latency: 100 }),
    link({ _id: "serving", priority: 2, latency: 900 }),
  ];

  const { streamPatches } = planChannelLinkRefresh("c1", ladder);
  assert.deepEqual(streamPatches, [
    { _id: "serving", channelId: "c1", priority: 1 },
    { _id: "disabled", channelId: "c1", priority: 2 },
  ]);
  // A patch carries nothing but an owner and a number, so no automation applying
  // it can re-enable a link an admin took out of service.
  for (const patch of streamPatches) {
    assert.deepEqual(Object.keys(patch).sort(), ["_id", "channelId", "priority"]);
  }
});

test("the catalogue pass ranks the delivering link first and leaves a clean one alone", () => {
  const channel: MaintChannel = { _id: "c1", name: "Sports One", isPinned: true };
  const working = link({ _id: "working", priority: 2, latency: 350 });
  const dead = link({ _id: "dead", priority: 1, status: "broken" });

  const ranked = planMaintenance([channel], [dead, working], null);
  assert.deepEqual(ranked.streamPatches, [
    { _id: "working", channelId: "c1", priority: 1 },
    { _id: "dead", channelId: "c1", priority: 2 },
  ]);
  assert.equal(ranked.stats.channelsReordered, 1);

  const alreadyRight = planMaintenance([channel], [
    { ...working, priority: 1 },
    { ...dead, priority: 2 },
  ]);
  assert.deepEqual(alreadyRight.streamPatches, []);
  assert.deepEqual(alreadyRight.streamsToDelete, []);
  assert.equal(alreadyRight.stats.channelsReordered, 0);
});

/**
 * The whole loop a viewer depends on: a health verdict flags the channel, the
 * refresh renumbers the ladder, and the catalogue read path (gate → rank → number
 * by position, as `app/api/channels/route.ts` does it) publishes the same order.
 * If the two ever drift apart, the player steps a ladder no pass ever wrote.
 */
test("a health verdict, the refresh it triggers, and the published ladder agree", () => {
  const now = new Date("2026-10-12T06:00:00Z");
  const backup = link({ _id: "backup", priority: 2, latency: 320 });
  const serving = link({ _id: "serving", priority: 3, latency: 300 });
  const stalled = link({ _id: "stalled", priority: 1, latency: 300 });

  const verdict = decideStreamHealth(
    stalled.status,
    stalled.failedAttempts || 0,
    null,
    starved(),
    now,
    null,
    { deliveryHidden: false, deliveryMisses: 0 }
  );
  const moved = withDecision(stalled, verdict);
  assert.equal(rankingShifted(stalled, moved), true);

  const ladder = [backup, serving, moved];
  const { streamPatches } = planChannelLinkRefresh("c1", ladder);
  const refreshed = ladder.map((s) => {
    const patch = streamPatches.find((p) => p._id === s._id);
    return patch ? { ...s, priority: patch.priority } : s;
  });

  // The catalogue's read path, rows arriving in whatever order the store gave them.
  const published = rankStreams(
    refreshed.filter((s) => !s.adminDisabled && isUsableViewerLink(s))
  ).map((stream, rank) => ({ _id: stream._id, priority: rank + 1 }));

  assert.deepEqual(published, [
    { _id: "backup", priority: 1 },
    { _id: "serving", priority: 2 },
  ]);
  // The link that stopped delivering is out of the ladder entirely, and the two
  // that remain are numbered exactly the way the refresh stored them.
  for (const { _id, priority } of published) {
    assert.equal(refreshed.find((s) => s._id === _id)?.priority, priority);
  }
  assert.deepEqual(planChannelLinkRefresh("c1", refreshed).streamPatches, []);
});
