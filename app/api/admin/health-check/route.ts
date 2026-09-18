import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { probeStreamUrl } from "@/lib/streamProbe";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("x-admin-secret");
    const body = await req.json().catch(() => ({}));
    const rawSecret = authHeader || body.secretKey || "";
    const secretKey = rawSecret.trim();

    const expectedSecret = (process.env.ADMIN_SECRET_KEY || "supersecret123").trim();

    if (!secretKey || secretKey !== expectedSecret) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const conn = await connectToDatabase();
    const THREE_DAYS_MS = 72 * 60 * 60 * 1000;
    const now = new Date();

    let checkedCount = 0;
    let activeCount = 0;
    let degradedCount = 0;
    let brokenCount = 0;
    let deletedCount = 0;

    if (conn) {
      // MongoDB Mode: Batch process least recently checked stream URLs
      const streamsToTest = await StreamLink.find()
        .sort({ lastCheckedAt: 1 })
        .limit(30);

      for (const stream of streamsToTest) {
        checkedCount++;
        const result = await probeStreamUrl(stream.url, 5000);

        if (result.ok) {
          stream.status = "active";
          stream.latency = result.latency;
          stream.failedAttempts = 0;
          stream.firstFailedAt = null;
          stream.lastCheckedAt = now;
          await stream.save();
          activeCount++;
        } else {
          stream.failedAttempts = (stream.failedAttempts || 0) + 1;
          if (!stream.firstFailedAt) {
            stream.firstFailedAt = now;
          }
          stream.lastCheckedAt = now;

          const failureDuration = now.getTime() - new Date(stream.firstFailedAt).getTime();
          if (failureDuration > THREE_DAYS_MS) {
            await StreamLink.findByIdAndDelete(stream._id);
            deletedCount++;
          } else if (stream.failedAttempts >= 2) {
            stream.status = "broken";
            await stream.save();
            brokenCount++;
          } else {
            stream.status = "degraded";
            await stream.save();
            degradedCount++;
          }
        }
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
      // In-Memory Mode
      const streams = inMemoryDb.getStreams();
      for (const stream of streams) {
        checkedCount++;
        const result = await probeStreamUrl(stream.url, 4000);
        if (result.ok) {
          stream.status = "active";
          stream.latency = result.latency;
          stream.failedAttempts = 0;
          stream.firstFailedAt = null;
          stream.lastCheckedAt = now;
          activeCount++;
        } else {
          stream.failedAttempts = (stream.failedAttempts || 0) + 1;
          if (!stream.firstFailedAt) {
            stream.firstFailedAt = now;
          }
          stream.lastCheckedAt = now;
          if (stream.failedAttempts >= 2) {
            stream.status = "broken";
            brokenCount++;
          } else {
            stream.status = "degraded";
            degradedCount++;
          }
        }
      }

      inMemoryDb.saveState();

      return NextResponse.json({
        success: true,
        batchSize: streams.length,
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
