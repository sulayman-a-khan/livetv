import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { checkHlsStream } from "@/lib/streamProbe";
import { decideStreamHealth, type StoredStreamStatus } from "@/lib/streamHealth";
import { isAuthorizedAdmin } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

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

    let checkedCount = 0;
    let activeCount = 0;
    let degradedCount = 0;
    let brokenCount = 0;
    const deletedCount = 0;

    if (conn) {
      // Check the entire catalogue, oldest checks first.
      const streamsToTest = await StreamLink.find()
        .sort({ lastCheckedAt: 1 });

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
          now
        );

        stream.status = decision.status;
        stream.latency = decision.latency;
        stream.failedAttempts = decision.failedAttempts;
        stream.firstFailedAt = decision.firstFailedAt;
        stream.lastCheckedAt = decision.lastCheckedAt;
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
        summary: {
          checkedCount,
          activeCount,
          degradedCount,
          brokenCount,
          deletedCount,
        },
      });
    } else {
      // In-Memory Mode — mirror the MongoDB branch: bounded batch size, least-
      // recently-checked first, and probed with limited concurrency so this
      // request can't run for minutes (or hit a serverless timeout) on a
      // catalogue of hundreds/thousands of streams.
      const streams = [...inMemoryDb.getStreams()].sort((a, b) => {
        const aTime = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0;
        const bTime = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0;
        return aTime - bTime;
      });
      const streamsToTest = streams;

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
              now
            );
            stream.status = decision.status;
            stream.latency = decision.latency;
            stream.failedAttempts = decision.failedAttempts;
            stream.firstFailedAt = decision.firstFailedAt;
            stream.lastCheckedAt = decision.lastCheckedAt;
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
