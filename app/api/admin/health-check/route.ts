import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase, databaseUnavailable } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { checkHlsStream, type HlsCheckResult } from "@/lib/streamProbe";
import {
  decideStreamHealth,
  toLastCheckDetail,
  type StreamHealthDecision,
  type StoredStreamStatus,
} from "@/lib/streamHealth";
import { refreshChannelLinks, runMaintenance } from "@/lib/maintenanceRunner";
import { rankingShifted } from "@/lib/channelMaintenance";
import { authorizeAdminRequest } from "@/lib/adminAuth";
import {
  applyBatchOutcome,
  beginHealthRun,
  completeHealthRun,
  recordHealthRunSweep,
  saveHealthRun,
} from "@/lib/healthRunState";

export const dynamic = "force-dynamic";
/**
 * One batch must be able to finish inside the request: every link in it is
 * saved before the response, so a killed function loses that work and the admin
 * sees no progress. 60s is well above the worst case below.
 */
export const maxDuration = 60;

// Keep each serverless request short; the admin UI repeats batches until done.
// The batch is a single parallel wave (concurrency === limit), so the worst-case
// wall clock is one probe budget (8s x 2 attempts) plus the second look below,
// plus save time — no chance of a second wave being cut off mid-flight. A link
// that misses the 10s delivery budget adds the 15s confirmation wait, and a link
// that still misses it is asked once more before anything is written; both fit
// inside 60s because the second look is deliberately a single cheap attempt.
const BATCH_LIMIT = 12;
const BATCH_CONCURRENCY = BATCH_LIMIT;
const PROBE_OPTS = {
  timeoutMs: 8000,
  checkLiveRefresh: false,
  useFfprobe: false,
  maxAttempts: 2,
  segmentSampleSize: 1,
} as const;

/**
 * Pass 2's probe. Pass 1 already spent two attempts on the link, so the second
 * look exists for one reason: to ask "still nothing?" a few seconds later. One
 * attempt, no confirming wait — that is what keeps the pair inside the request
 * budget instead of doubling it.
 */
const SECOND_LOOK_PROBE_OPTS = {
  timeoutMs: 8000,
  checkLiveRefresh: false,
  useFfprobe: false,
  maxAttempts: 1,
  segmentSampleSize: 1,
  deliveryConfirmDelayMs: 0,
} as const;

/** The stored delivery verdict, in the shape `decideStreamHealth` asks for. */
function storedDelivery(stream: {
  deliveryHidden?: boolean | null;
  deliveryMisses?: number | null;
  lastDeliveryMissAt?: Date | string | null;
}) {
  return {
    deliveryHidden: Boolean(stream.deliveryHidden),
    deliveryMisses: stream.deliveryMisses || 0,
    lastDeliveryMissAt: stream.lastDeliveryMissAt ?? null,
  };
}

/**
 * Probe a link, and if the first look came back with no media — the only thing
 * that can hide a link outright — probe it again before writing anything.
 *
 * A hide is the loudest thing this pass does: the channel leaves the catalogue
 * viewers see. One lookup through a congested runner used to be enough to cause
 * that, which is the false failure this rule exists to prevent. So the first
 * look never decides alone:
 *
 *   - first look delivers (or fails for a non-delivery reason) → one probe, as
 *     before, nothing held;
 *   - second look delivers → judged from the state the run arrived to, so the
 *     flap clears the streak and the misses exactly as a healthy pass would;
 *   - second look also gets no media → hidden, with the first look's evidence
 *     carried in as the prior verdict.
 *
 * A `browserBlocker` is never held: mixed content and a withheld CORS grant are
 * facts about the origin, not about this minute, and the second look would
 * report the same thing a few seconds later.
 */
async function probeWithSecondLook(
  stream: {
    url: string;
    status: StoredStreamStatus;
    failedAttempts?: number | null;
    firstFailedAt?: Date | string | null;
    lastCountedFailureDay?: string | null;
    deliveryHidden?: boolean | null;
    deliveryMisses?: number | null;
    lastDeliveryMissAt?: Date | string | null;
    headers?: Record<string, string>;
  },
  now: Date
): Promise<{ result: HlsCheckResult; decision: StreamHealthDecision; retried: boolean }> {
  const first = await checkHlsStream(stream.url, {
    ...PROBE_OPTS,
    headers: stream.headers,
  });
  const firstDecision = decideStreamHealth(
    stream.status,
    stream.failedAttempts || 0,
    stream.firstFailedAt ? new Date(stream.firstFailedAt) : null,
    first,
    now,
    stream.lastCountedFailureDay,
    storedDelivery(stream)
  );

  if (!firstDecision.deliveryHidden) {
    return { result: first, decision: firstDecision, retried: false };
  }

  const second = await checkHlsStream(stream.url, {
    ...SECOND_LOOK_PROBE_OPTS,
    headers: stream.headers,
  });
  const secondDecision = decideStreamHealth(
    stream.status,
    stream.failedAttempts || 0,
    stream.firstFailedAt ? new Date(stream.firstFailedAt) : null,
    second,
    now,
    stream.lastCountedFailureDay,
    // Both looks got no media: the first one's misses are evidence the second
    // stands on, not history to forget.
    firstDecision
  );
  return { result: second, decision: secondDecision, retried: true };
}

/**
 * Links due for a pass: on a pinned channel, not switched off by the admin, and
 * without a verdict newer than the pass cursor. Shared by the count and the
 * select so `remaining` can never disagree with what the next batch would pick.
 */
function pendingFilter(cutoff: Date, pinnedChannelIds: string[]) {
  return {
    adminDisabled: { $ne: true },
    channelId: { $in: pinnedChannelIds },
    $or: [{ lastCheckedAt: null }, { lastCheckedAt: { $lt: cutoff } }],
  };
}

/** The same three counts in both storage modes, measured against one cursor. */
async function measurePending(
  mongo: boolean,
  cutoff: Date,
  pinnedChannelIds: string[]
): Promise<{ pending: number; pinnedTotal: number; skippedDisabled: number }> {
  if (mongo) {
    return {
      pending: await StreamLink.countDocuments(pendingFilter(cutoff, pinnedChannelIds)),
      // Reported so the admin can see the run skipped nothing they own.
      skippedDisabled: await StreamLink.countDocuments({
        adminDisabled: true,
        channelId: { $in: pinnedChannelIds },
      }),
      pinnedTotal: await StreamLink.countDocuments({
        adminDisabled: { $ne: true },
        channelId: { $in: pinnedChannelIds },
      }),
    };
  }

  const pinned = new Set(pinnedChannelIds);
  const pinnedStreams = [...inMemoryDb.getStreams()].filter((s) => pinned.has(s.channelId));
  const testable = pinnedStreams.filter((s) => !s.adminDisabled);
  const due = testable.filter(
    (s) =>
      !s.lastCheckedAt || new Date(s.lastCheckedAt).getTime() < cutoff.getTime()
  );
  return {
    pending: due.length,
    pinnedTotal: testable.length,
    skippedDisabled: pinnedStreams.length - testable.length,
  };
}

export async function POST(req: NextRequest) {
  try {
    // Two credentials, deliberately not the same one. The dashboard presents the
    // admin secret; the external runner presents `HEALTH_CHECK_SECRET`, which is
    // accepted by this route only — it cannot delete links, edit channels or run
    // maintenance, so the machine that schedules the pass never holds the key
    // that owns the admin area. Both paths fail closed when their variable is
    // unset, so an unconfigured deployment simply has no external runner.
    // The credential is settled before the body is read, so a request that
    // presents a wrong one is rejected without the server buffering a payload.
    const auth = await authorizeAdminRequest(req, { bearerEnv: "HEALTH_CHECK_SECRET" });
    if (!auth.ok) {
      return NextResponse.json(
        { success: false, error: auth.error },
        { status: auth.status }
      );
    }
    const body = auth.body;

    const conn = await connectToDatabase();
    // A pass that could not reach the catalogue must not probe the seed store:
    // its verdicts would be written against links no viewer has, and the batch
    // would report a clean run. The runner retries a 503 as a batch failure.
    const unavailable = databaseUnavailable(conn, "Database unavailable — this batch checked nothing");
    if (unavailable) return unavailable;
    const now = new Date();
    const requestedCursor =
      typeof body.before === "string" && !Number.isNaN(Date.parse(body.before))
        ? new Date(body.before).toISOString()
        : null;

    // Only curated (pinned) channels are batch health-checked, here exactly as in
    // the scheduled GitHub passes — which call this same endpoint. An unpinned
    // channel's links are still testable one by one from its edit card; a batch
    // run simply never touches them, and zero pinned channels means zero targets
    // rather than a fallback to the whole store.
    const pinnedChannelIds = conn
      ? (await Channel.find({ isPinned: true }).select("_id").lean()).map((c) => String(c._id))
      : inMemoryDb
          .getChannels()
          .filter((c) => c.isPinned)
          .map((c) => c._id);

    if (pinnedChannelIds.length === 0) {
      return NextResponse.json({
        success: true,
        batchSize: 0,
        runStartedAt: now.toISOString(),
        hasMore: false,
        pinnedTotal: 0,
        remaining: 0,
        skipped: "No pinned channels — nothing to health-check",
        summary: {
          checkedCount: 0,
          activeCount: 0,
          degradedCount: 0,
          brokenCount: 0,
          unplayableCount: 0,
          notDeliveringCount: 0,
          secondLookCount: 0,
          deletedCount: 0,
        },
      });
    }

    const mongo = Boolean(conn);
    let measure = await measurePending(mongo, new Date(requestedCursor ?? now), pinnedChannelIds);

    // The server owns the pass cursor and its counters, so a runner that dies
    // mid-pass leaves a checkpoint instead of a mystery: the next request picks
    // the same pass up where it stopped. A request that arrives while a pass is
    // genuinely mid-flight is refused rather than allowed to test the same links
    // a second time and count them twice.
    const begun = await beginHealthRun({
      trigger: auth.credential === "bearer" ? "github" : "admin",
      requestedCursor,
      eligible: measure.pending,
      now,
    });
    if (begun.status === "active") {
      const active = begun.progress;
      return NextResponse.json(
        {
          success: false,
          error: "A health-check pass is already running",
          detail:
            `${active.remaining} link(s) are still due on the pass that started at ` +
            `${active.startedAt} (last batch ${active.completed} tested). Let it finish, or ` +
            `let it go quiet for 12 minutes — the next request then resumes it.`,
          runStartedAt: active.startedAt,
          activeRun: active,
        },
        { status: 409 }
      );
    }

    const cutoff = new Date(begun.progress.startedAt);
    if (cutoff.getTime() !== new Date(requestedCursor ?? now).getTime()) {
      measure = await measurePending(mongo, cutoff, pinnedChannelIds);
    }

    let checkedCount = 0;
    let activeCount = 0;
    let degradedCount = 0;
    let brokenCount = 0;
    /** Links the origin serves but no viewer's browser may fetch — hidden at once. */
    let unplayableCount = 0;
    /** Links that would not hand over media inside the 10-second budget. */
    let notDeliveringCount = 0;
    /**
     * Links whose first look got no media and were therefore asked again before
     * anything was written. Reported because the hide count is the number an
     * admin reads as "these channels just disappeared", and a hide that took two
     * looks is a different claim from one that took a single lookup.
     */
    let secondLookCount = 0;
    /**
     * Probed but not written: the verdict never landed, so the link is still due
     * and the pass cannot honestly claim it. Before this existed a rejected
     * promise here was silent, and a batch whose saves all failed still reported
     * a finished-looking progress line.
     */
    let inconclusiveCount = 0;

    /** Fold one saved verdict into this batch's counters. */
    const tally = (decision: StreamHealthDecision) => {
      checkedCount++;
      if (decision.browserBlocker) unplayableCount++;
      if (decision.deliveryHidden) notDeliveringCount++;
      if (decision.status === "active") activeCount++;
      else if (decision.status === "degraded") degradedCount++;
      else brokenCount++;
    };

    /**
     * Channels whose links this batch moved in the ladder. Their priorities are
     * renumbered below, so a healthy backup becomes Server 1 for the next viewer
     * instead of waiting for a maintenance sweep to notice.
     */
    const changedChannelIds = new Set<string>();

    if (mongo) {
      // Admin-disabled links are excluded: only an admin puts them back in
      // service, so a batch run has no business re-probing or re-enabling them.
      const streamsToTest = await StreamLink.find(pendingFilter(cutoff, pinnedChannelIds))
        .sort({ lastCheckedAt: 1 })
        .limit(BATCH_LIMIT);

      for (let i = 0; i < streamsToTest.length; i += BATCH_CONCURRENCY) {
        const batch = streamsToTest.slice(i, i + BATCH_CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (stream) => {
            const previous = stream.status as StoredStreamStatus;
            const before = {
              status: previous,
              latency: stream.latency,
              failedAttempts: stream.failedAttempts,
              deliveryHidden: stream.deliveryHidden,
              deliveryMisses: stream.deliveryMisses,
              adminDisabled: stream.adminDisabled,
            };
            // The first look never hides a link on its own — see
            // `probeWithSecondLook`.
            const { result, decision, retried } = await probeWithSecondLook(stream, now);
            if (retried) secondLookCount++;

            stream.status = decision.status;
            stream.latency = decision.latency;
            stream.failedAttempts = decision.failedAttempts;
            stream.firstFailedAt = decision.firstFailedAt;
            stream.lastCheckedAt = decision.lastCheckedAt;
            stream.lastCountedFailureDay = decision.lastCountedFailureDay;
            stream.browserBlocker = decision.browserBlocker;
            stream.deliveryMisses = decision.deliveryMisses;
            stream.lastDeliveryMissAt = decision.lastDeliveryMissAt;
            stream.deliveryHidden = decision.deliveryHidden;
            // What the probe actually saw, kept with the link. Without this a batch
            // run changes the verdict but leaves the row describing the previous
            // pass, so the admin cannot tell that this press is what decided it.
            stream.lastCheck = toLastCheckDetail(result);
            await stream.save();
            if (rankingShifted(before, stream)) {
              changedChannelIds.add(String(stream.channelId));
            }
            tally(decision);
          })
        );
        // No error text is logged: a probe or save failure can carry the stream
        // URL, which is exactly what a credential-bearing link cannot afford.
        inconclusiveCount += settled.filter((r) => r.status === "rejected").length;
      }
    } else {
      // In-Memory Mode — mirrors the MongoDB branch exactly: only pinned
      // channels, never an admin-disabled link, one bounded batch of
      // least-recently-checked streams per request.
      const pinned = new Set(pinnedChannelIds);
      const pinnedStreams = [...inMemoryDb.getStreams()].filter(
        (stream) => pinned.has(stream.channelId)
      );
      const streamsToTest = pinnedStreams
        .filter((stream) => !stream.adminDisabled)
        .sort((a, b) => {
          const aTime = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0;
          const bTime = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0;
          return aTime - bTime;
        })
        .filter(
          (stream) =>
            !stream.lastCheckedAt ||
            new Date(stream.lastCheckedAt).getTime() < cutoff.getTime()
        )
        .slice(0, BATCH_LIMIT);

      for (let i = 0; i < streamsToTest.length; i += BATCH_CONCURRENCY) {
        const batch = streamsToTest.slice(i, i + BATCH_CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (stream) => {
            const previous = stream.status as StoredStreamStatus;
            const before = {
              status: previous,
              latency: stream.latency,
              failedAttempts: stream.failedAttempts,
              deliveryHidden: stream.deliveryHidden,
              deliveryMisses: stream.deliveryMisses,
              adminDisabled: stream.adminDisabled,
            };
            const { result, decision, retried } = await probeWithSecondLook(stream, now);
            if (retried) secondLookCount++;
            stream.lastCheck = toLastCheckDetail(result);
            stream.status = decision.status;
            stream.latency = decision.latency;
            stream.failedAttempts = decision.failedAttempts;
            stream.firstFailedAt = decision.firstFailedAt;
            stream.lastCheckedAt = decision.lastCheckedAt;
            stream.lastCountedFailureDay = decision.lastCountedFailureDay;
            stream.browserBlocker = decision.browserBlocker;
            stream.deliveryMisses = decision.deliveryMisses;
            stream.lastDeliveryMissAt = decision.lastDeliveryMissAt;
            stream.deliveryHidden = decision.deliveryHidden;
            if (rankingShifted(before, stream)) {
              changedChannelIds.add(String(stream.channelId));
            }
            tally(decision);
          })
        );
        inconclusiveCount += settled.filter((r) => r.status === "rejected").length;
      }

      inMemoryDb.saveState();
    }

    // A verdict that moved a link between tiers or speed bands changes which
    // mirror the next viewer should be handed first, so exactly those channels
    // have their ladder renumbered now, bounded to this batch instead of a
    // catalogue-wide rerun.
    for (const channelId of changedChannelIds) {
      try {
        await refreshChannelLinks(channelId);
      } catch {
        // No error text is logged: a failed write can carry the stream URL.
        console.error(`[HealthCheck] link re-rank failed for ${channelId}`);
      }
    }

    const remaining = (await measurePending(mongo, cutoff, pinnedChannelIds)).pending;
    const finishedAt = new Date();
    const progress = applyBatchOutcome(
      begun.progress,
      {
        checked: checkedCount,
        active: activeCount,
        degraded: degradedCount,
        broken: brokenCount,
        unplayable: unplayableCount,
        notDelivering: notDeliveringCount,
        inconclusive: inconclusiveCount,
      },
      remaining,
      finishedAt
    );

    // Nothing was due when the pass opened, so the pass is complete on arrival.
    // That is recorded rather than answered silently: a run that reaches this
    // app and finds every link already fresher than its cursor is still proof
    // the scheduled pass arrived.
    let finalReport = null;
    /** Links this request deleted — set by the closing sweep, always 0 before it. */
    let deletedCount = 0;
    if (remaining === 0) {
      finalReport = await completeHealthRun(progress, finishedAt);

      // The batch that empties the queue also runs the catalogue sweep: merges,
      // dedupe, re-ranking and the dead-link purge. This was the auto health
      // checker's job until the Vercel crons went, and nothing has scheduled it
      // since — so the pass that has just measured every link is the one that
      // decides what those measurements mean for the catalogue.
      //
      // The report is written first on purpose. A sweep over the whole catalogue
      // is the long part of this request, and a request that ran out of time in
      // it would otherwise lose the proof the pass finished at all. The verdicts
      // are already saved link by link, so the sweep's only cost is its own
      // summary, which is attached after it lands.
      //
      // Skipped when this request tested nothing: a runner arriving to find every
      // link already fresh is proof of arrival, not a reason to rewrite the
      // catalogue a second time in the same slot.
      if (checkedCount > 0) {
        try {
          const sweep = await runMaintenance();
          deletedCount = Math.max(0, sweep.streamsBefore - sweep.streamsAfter);
          finalReport = await recordHealthRunSweep(finalReport, {
            mode: sweep.mode,
            channelsMerged: sweep.channelsMerged,
            duplicateLinksRemoved: sweep.duplicateLinksRemoved,
            placeholderLinksPurged: sweep.placeholderLinksPurged,
            deadLinksPurged: sweep.deadLinksPurged,
            channelsReordered: sweep.channelsReordered,
            streamsRemoved: deletedCount,
          });
          console.log(
            `[HealthCheck] sweep: ${sweep.channelsMerged} merged, ` +
              `${sweep.duplicateLinksRemoved} duplicate, ${sweep.placeholderLinksPurged} test, ` +
              `${sweep.deadLinksPurged} dead link(s) removed`
          );
        } catch {
          // No error text is logged: a failed write can carry a stream URL.
          console.error("[HealthCheck] maintenance sweep failed — pass report still stands");
        }
      }
    } else {
      await saveHealthRun(progress);
    }

    return NextResponse.json({
      success: true,
      batchSize: checkedCount + inconclusiveCount,
      runStartedAt: begun.progress.startedAt,
      hasMore: remaining > 0,
      pinnedTotal: measure.pinnedTotal,
      remaining,
      skippedDisabled: measure.skippedDisabled,
      runId: begun.progress.runId,
      /** started | resumed | replaced — which pass this batch belongs to. */
      runStatus: begun.status,
      /** Everything tested so far across every batch of this pass. */
      progress,
      /** Set only by the batch that emptied the queue; null for every batch before it. */
      finalReport,
      summary: {
        checkedCount,
        activeCount,
        degradedCount,
        brokenCount,
        unplayableCount,
        notDeliveringCount,
        secondLookCount,
        deletedCount,
        inconclusiveCount,
      },
    });
  } catch (error: any) {
    console.error("POST /api/admin/health-check error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Health check failed" },
      { status: 500 }
    );
  }
}
