import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { getChannelLogo } from "@/lib/utils";
import { isAuthorizedAdmin } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    if (!isAuthorizedAdmin(req)) {
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

      // Single query for every stream instead of one query per channel
      // (was an N+1 query pattern — 1300+ round trips on this catalogue size).
      const allStreams = await StreamLink.find({
        channelId: { $in: allChannels.map((ch) => ch._id) },
      }).lean();
      const streamsByChannel = new Map<string, typeof allStreams>();
      for (const s of allStreams) {
        const key = String(s.channelId);
        const list = streamsByChannel.get(key);
        if (list) list.push(s);
        else streamsByChannel.set(key, [s]);
      }

      const channelsWithLinks = allChannels.map((ch) => ({
        ...ch,
        logo: getChannelLogo(ch.name, ch.logo),
        streams: streamsByChannel.get(String(ch._id)) || [],
      }));

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
