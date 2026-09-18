import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { getChannelLogo } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get("x-admin-secret");
    const { searchParams } = new URL(req.url);
    const rawSecret = authHeader || searchParams.get("secretKey") || "";
    const secretKey = rawSecret.trim();

    const expectedSecret = (process.env.ADMIN_SECRET_KEY || "supersecret123").trim();

    if (!secretKey || secretKey !== expectedSecret) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const conn = await connectToDatabase();

    if (conn) {
      // MongoDB Mode
      const totalChannels = await Channel.countDocuments();
      const totalStreams = await StreamLink.countDocuments();
      const activeStreams = await StreamLink.countDocuments({ status: "active" });
      const degradedStreams = await StreamLink.countDocuments({ status: "degraded" });
      const brokenStreams = await StreamLink.countDocuments({ status: "broken" });

      // Return ALL channels without .limit(10) so Admin Gate shows full list
      const allChannels = await Channel.find().sort({ isPinned: -1, priorityOrder: 1, name: 1 }).lean();

      const channelsWithLinks = await Promise.all(
        allChannels.map(async (ch) => {
          const streams = await StreamLink.find({ channelId: ch._id }).lean();
          return { ...ch, logo: getChannelLogo(ch.name, ch.logo), streams };
        })
      );

      return NextResponse.json({
        success: true,
        dbMode: "mongodb",
        stats: {
          totalChannels,
          totalStreams,
          activeStreams,
          degradedStreams,
          brokenStreams,
        },
        channels: channelsWithLinks,
      });
    } else {
      // In-Memory Fallback Mode
      const channels = inMemoryDb.getChannels();
      const streams = inMemoryDb.getStreams();

      const activeStreams = streams.filter((s) => s.status === "active").length;
      const degradedStreams = streams.filter((s) => s.status === "degraded").length;
      const brokenStreams = streams.filter((s) => s.status === "broken").length;

      // Return ALL channels without .slice(0, 10)
      const sortedChannels = [...channels].sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        if (a.isPinned && b.isPinned) return (a.priorityOrder ?? 99) - (b.priorityOrder ?? 99);
        return a.name.localeCompare(b.name);
      });

      const channelsWithLinks = sortedChannels.map((ch) => {
        const chStreams = streams.filter((s) => s.channelId === ch._id);
        return { ...ch, streams: chStreams };
      });

      return NextResponse.json({
        success: true,
        dbMode: "in-memory",
        stats: {
          totalChannels: channels.length,
          totalStreams: streams.length,
          activeStreams,
          degradedStreams,
          brokenStreams,
        },
        channels: channelsWithLinks,
      });
    }
  } catch (error: any) {
    console.error("GET /api/admin/stats error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch admin stats" },
      { status: 500 }
    );
  }
}
