import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { recordStreamFailure, type StoredStreamStatus } from "@/lib/streamHealth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { streamId } = await req.json().catch(() => ({}));

    if (!streamId || typeof streamId !== "string") {
      return NextResponse.json({ success: false, error: "Missing streamId" }, { status: 400 });
    }

    const conn = await connectToDatabase();
    const now = new Date();

    if (conn && mongoose.isValidObjectId(streamId)) {
      const stream = await StreamLink.findById(streamId);
      if (stream) {
        const decision = recordStreamFailure(
          stream.status as StoredStreamStatus, stream.failedAttempts || 0, stream.firstFailedAt, now
        );
        stream.status = decision.status;
        stream.failedAttempts = decision.failedAttempts;
        stream.firstFailedAt = decision.firstFailedAt;
        stream.lastCheckedAt = decision.lastCheckedAt;

        await stream.save();

        // The client uses this to decide whether to drop the channel from the
        // playlist immediately rather than waiting for the next poll.
        const remainingActive = await StreamLink.countDocuments({
          channelId: stream.channelId,
          status: "active",
        });

        return NextResponse.json({
          success: true,
          status: stream.status,
          failedAttempts: stream.failedAttempts,
          channelId: String(stream.channelId),
          remainingActiveStreams: remainingActive,
          channelHidden: remainingActive === 0,
        });
      }
    }

    // Fallback to inMemoryDb
    const streams = inMemoryDb.getStreams();
    const stream = streams.find((s) => s._id === streamId);
    if (stream) {
      const decision = recordStreamFailure(
        stream.status as StoredStreamStatus, stream.failedAttempts || 0, stream.firstFailedAt, now
      );
      stream.status = decision.status;
      stream.failedAttempts = decision.failedAttempts;
      stream.firstFailedAt = decision.firstFailedAt;
      stream.lastCheckedAt = decision.lastCheckedAt;
      inMemoryDb.saveState();

      const remainingActive = streams.filter(
        (s) => s.channelId === stream.channelId && s.status === "active"
      ).length;

      return NextResponse.json({
        success: true,
        status: stream.status,
        failedAttempts: stream.failedAttempts,
        channelId: stream.channelId,
        remainingActiveStreams: remainingActive,
        channelHidden: remainingActive === 0,
      });
    }

    return NextResponse.json({ success: false, error: "Stream link not found" }, { status: 404 });
  } catch (error: any) {
    console.error("POST /api/streams/report-broken error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to report broken stream" },
      { status: 500 }
    );
  }
}
