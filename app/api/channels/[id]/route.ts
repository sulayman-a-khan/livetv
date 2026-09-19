import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { getChannelLogo } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const conn = await connectToDatabase();

    // 1. If MongoDB is connected and id is a valid 24-char ObjectId, query MongoDB
    if (conn && mongoose.isValidObjectId(id)) {
      // These two queries don't depend on each other — running them in
      // parallel instead of sequentially shaves a full round-trip off every
      // single channel switch, which is where this lag is most noticeable.
      const [channel, streams] = await Promise.all([
        Channel.findById(id).lean(),
        StreamLink.find({ channelId: id, status: "active" }).sort({ priority: 1, latency: 1 }).lean(),
      ]);

      if (channel) {
        return NextResponse.json({
          success: true,
          channel: { ...channel, logo: getChannelLogo(channel.name, channel.logo), streams },
        });
      }
    }

    // 2. Fallback to In-Memory Mode (for custom string IDs like ch_...)
    const channels = inMemoryDb.getChannels();
    const streams = inMemoryDb.getStreams();

    const channel = channels.find((c) => c._id === id);
    if (!channel) {
      return NextResponse.json({ success: false, error: "Channel not found" }, { status: 404 });
    }

    // Serve links in priority order (maintenance guarantees priority 1 is the
    // fastest working mirror), falling back to raw latency as a tiebreaker.
    const chStreams = streams
      .filter((s) => s.channelId === id && s.status === "active")
      .sort((a, b) => (a.priority || 99) - (b.priority || 99) || (a.latency || 0) - (b.latency || 0));

    return NextResponse.json({
      success: true,
      channel: { ...channel, logo: getChannelLogo(channel.name, channel.logo), streams: chStreams },
    });
  } catch (error: any) {
    console.error("GET /api/channels/[id] error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch channel details" },
      { status: 500 }
    );
  }
}
