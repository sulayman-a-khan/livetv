import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { checkHlsStream } from "@/lib/streamProbe";
import {
  decideStreamHealth,
  type StreamHealthDecision,
  type StoredStreamStatus,
} from "@/lib/streamHealth";
import { toLastCheckDetail } from "@/lib/autoHealthChecker";
import { isAuthorizedAdmin, isAuthorizedByBearer } from "@/lib/adminAuth";
import {
  applyBatchOutcome,
  beginHealthRun,
  completeHealthRun,
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
// wall clock is one probe budget (8s x 2 attempts) plus save time — no chance of
// a second wave being cut off mid-flight. A link that misses the 10s delivery
// budget adds the 15s confirmation wait, which still lands well inside 60s.
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
    const body = await req.json().catch(() => ({}));

    // Two credentials, deliberately not the same one. The dashboard presents the
    // admin secret; the external runner presents `HEALTH_CHECK_SECRET`, which is
    // accepted by this route only — it cannot delete links, edit channels or run
    // maintenance, so the machine that schedules the pass never holds the key
    // that owns the admin area. Both paths fail closed when their variable is
    // unset, so an unconfigured deployment simply has no external runner.
    const viaRunCredential = isAuthorizedByBearer(req, "HEALTH_CHECK_SECRET");
    if (!viaRunCredential && !isAuthorizedAdmin(req, body.secretKey)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const conn = await connectToDatabase();
    const now = new Date();
    const requestedCursor =
      typeof body.before === "string" && !Number.isNaN(Date.parse(body.before))
        ? new Date(body.before).toISOString()
        : null;

    // Only curated (pinned) channels are batch health-checked, here exactly as in
    // the cron passes. An unpinned channel's links are still testable one by one
    // from its edit card; a batch run simply never touches them, and zero pinned
    // channels means zero targets rather than a fallback to the whole store.
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
      trigger: viaRunCredential ? "github" : "admin",
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
    const deletedCount = 0;
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
            const result = await checkHlsStream(stream.url, {
              ...PROBE_OPTS,
              headers: stream.headers,
            });
            const previous = stream.status as StoredStreamStatus;
            const decision = decideStreamHealth(
              previous,
              stream.failedAttempts || 0,
              stream.firstFailedAt,
              result,
              now,
              stream.lastCountedFailureDay,
              {
                deliveryHidden: stream.deliveryHidden,
                deliveryMisses: stream.deliveryMisses,
                lastDeliveryMissAt: stream.lastDeliveryMissAt,
              }
            );

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
            // run changes the verdict but leaves the row describing the last cron
            // pass, so the admin cannot tell that this press is what decided it.
            stream.lastCheck = toLastCheckDetail(result);
            await stream.save();
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
            const result = await checkHlsStream(stream.url, {
              ...PROBE_OPTS,
              headers: stream.headers,
            });
            stream.lastCheck = {
              healthStatus: result.status,
              errorCode: result.errorCode,
              httpStatus: result.httpStatus,
              responseTime: result.responseTime,
              playlistType: result.playlistType,
              isLive: result.isLive,
              segmentCount: result.segmentCount,
              newSegmentDetected: result.newSegmentDetected,
              video: result.video,
              audio: result.audio,
              resolution: result.resolution,
              codec: result.codec,
              fps: result.fps,
              attempts: result.attempts,
              error: result.error,
              checkedAt: result.checkedAt,
              browserCors: result.browserCors,
              browserBlocker: result.browserBlocker,
              deliveryMisses: result.deliveryMisses,
            };
            const previous = stream.status as StoredStreamStatus;
            const decision = decideStreamHealth(
              previous,
              stream.failedAttempts || 0,
              stream.firstFailedAt,
              result,
              now,
              stream.lastCountedFailureDay,
              {
                deliveryHidden: stream.deliveryHidden,
                deliveryMisses: stream.deliveryMisses,
                lastDeliveryMissAt: stream.lastDeliveryMissAt,
              }
            );
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
            tally(decision);
          })
        );
        inconclusiveCount += settled.filter((r) => r.status === "rejected").length;
      }

      inMemoryDb.saveState();
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
    // the scheduler arrived.
    let finalReport = null;
    if (remaining === 0) {
      finalReport = await completeHealthRun(progress, finishedAt);
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
