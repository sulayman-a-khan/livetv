import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { checkHlsStream } from "@/lib/streamProbe";
import { decideStreamHealth, type StoredStreamStatus } from "@/lib/streamHealth";
import { isAuthorizedAdmin } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

// Keep each serverless request short; the admin UI repeats batches until done.
const BATCH_LIMIT = 12;
const BATCH_CONCURRENCY = 6;
const PROBE_OPTS = {
  timeoutMs: 8000,
  checkLiveRefresh: false,
  useFfprobe: false,
  maxAttempts: 2,
  segmentSampleSize: 1,
} as const;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    if (!isAuthorizedAdmin(req, body.secretKey)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const conn = await connectToDatabase();
    const now = new Date();
    const requestedCutoff = typeof body.before === "string" ? new Date(body.before) : null;
    const cutoff = requestedCutoff && !Number.isNaN(requestedCutoff.getTime()) ? requestedCutoff : now;

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
        runStartedAt: cutoff.toISOString(),
        hasMore: false,
        skipped: "No pinned channels — nothing to health-check",
        summary: {
          checkedCount: 0,
          activeCount: 0,
          degradedCount: 0,
          brokenCount: 0,
          deletedCount: 0,
        },
      });
    }

    let checkedCount = 0;
    let activeCount = 0;
    let degradedCount = 0;
    let brokenCount = 0;
    const deletedCount = 0;

    if (conn) {
      // Admin-disabled links are excluded: only an admin puts them back in
      // service, so a batch run has no business re-probing or re-enabling them.
      const pendingFilter = {
        adminDisabled: { $ne: true },
        channelId: { $in: pinnedChannelIds },
        $or: [{ lastCheckedAt: null }, { lastCheckedAt: { $lt: cutoff } }],
      };
      const streamsToTest = await StreamLink.find(pendingFilter)
        .sort({ lastCheckedAt: 1 })
        .limit(BATCH_LIMIT);

      for (let i = 0; i < streamsToTest.length; i += BATCH_CONCURRENCY) {
        const batch = streamsToTest.slice(i, i + BATCH_CONCURRENCY);
        await Promise.allSettled(batch.map(async (stream) => {
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
          stream.lastCountedFailureDay
        );

        stream.status = decision.status;
        stream.latency = decision.latency;
        stream.failedAttempts = decision.failedAttempts;
        stream.firstFailedAt = decision.firstFailedAt;
        stream.lastCheckedAt = decision.lastCheckedAt;
        stream.lastCountedFailureDay = decision.lastCountedFailureDay;
        await stream.save();
        checkedCount++;
        if (decision.status === "active") activeCount++;
        else if (decision.status === "degraded") degradedCount++;
        else brokenCount++;
        }));
      }

      return NextResponse.json({
        success: true,
        batchSize: streamsToTest.length,
        runStartedAt: cutoff.toISOString(),
        hasMore: (await StreamLink.countDocuments(pendingFilter)) > 0,
        summary: {
          checkedCount,
          activeCount,
          degradedCount,
          brokenCount,
          deletedCount,
        },
      });
    } else {
      // In-Memory Mode — mirror the MongoDB branch: only pinned channels, no
      // admin-disabled links, bounded batch size, least-recently-checked first,
      // and probed with limited concurrency so this request can't run for minutes
      // (or hit a serverless timeout) on a catalogue of hundreds/thousands of
      // streams.
      const pinned = new Set(pinnedChannelIds);
      const streams = [...inMemoryDb.getStreams()]
        .filter((stream) => !stream.adminDisabled && pinned.has(stream.channelId))
        .sort((a, b) => {
          const aTime = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0;
          const bTime = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0;
          return aTime - bTime;
        });
      const streamsToTest = streams
        .filter((stream) => !stream.lastCheckedAt || new Date(stream.lastCheckedAt).getTime() < cutoff.getTime())
        .slice(0, BATCH_LIMIT);

      for (let i = 0; i < streamsToTest.length; i += BATCH_CONCURRENCY) {
        const batch = streamsToTest.slice(i, i + BATCH_CONCURRENCY);
        await Promise.allSettled(
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
            };
            const previous = stream.status as StoredStreamStatus;
            const decision = decideStreamHealth(
              previous,
              stream.failedAttempts || 0,
              stream.firstFailedAt,
              result,
              now,
              stream.lastCountedFailureDay
            );
            stream.status = decision.status;
            stream.latency = decision.latency;
            stream.failedAttempts = decision.failedAttempts;
            stream.firstFailedAt = decision.firstFailedAt;
            stream.lastCheckedAt = decision.lastCheckedAt;
            stream.lastCountedFailureDay = decision.lastCountedFailureDay;
            checkedCount++;
            if (decision.status === "active") activeCount++;
            else if (decision.status === "degraded") degradedCount++;
            else brokenCount++;
          })
        );
      }

      inMemoryDb.saveState();

      return NextResponse.json({
        success: true,
        batchSize: streamsToTest.length,
        runStartedAt: cutoff.toISOString(),
        hasMore: streams.some(
          (stream) => !stream.lastCheckedAt || new Date(stream.lastCheckedAt).getTime() < cutoff.getTime()
        ),
        summary: {
          checkedCount,
          activeCount,
          degradedCount,
          brokenCount,
          deletedCount: 0,
        },
      });
    }
  } catch (error: any) {
    console.error("POST /api/admin/health-check error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Health check failed" },
      { status: 500 }
    );
  }
}
