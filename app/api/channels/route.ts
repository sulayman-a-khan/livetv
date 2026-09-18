import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { getChannelLogo } from "@/lib/utils";

// FreeTV Channels API Route - Force Recompile for Logo Fix
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const category = searchParams.get("category");
    const subCategory = searchParams.get("subCategory");
    const country = searchParams.get("country");
    const search = searchParams.get("search");

    const conn = await connectToDatabase();

    if (conn) {
      // MongoDB Mode: Find matching channels
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filter: any = {};
      if (category && category !== "All") filter.category = category;
      if (subCategory && subCategory !== "All") filter.subCategory = subCategory;
      if (country && country !== "All") filter.country = country;
      if (search) filter.name = { $regex: search, $options: "i" };

      const channels = await Channel.find(filter)
        .sort({ isPinned: -1, priorityOrder: 1, name: 1 })
        .lean();
      const channelIds = channels.map((c) => c._id);

      // Only fetch stream links with status === "active"
      const activeStreams = await StreamLink.find({
        channelId: { $in: channelIds },
        status: "active",
      })
        .sort({ priority: 1, latency: 1 })
        .lean();

      // Group active streams by channelId
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const streamMap = new Map<string, any[]>();
      for (const stream of activeStreams) {
        const cId = stream.channelId.toString();
        if (!streamMap.has(cId)) streamMap.set(cId, []);
        streamMap.get(cId)!.push(stream);
      }

      // Filter OUT channels with ZERO active stream links
      const result = channels
        .filter((c) => (streamMap.get(c._id.toString()) || []).length > 0)
        .map((c) => {
          const streams = streamMap.get(c._id.toString()) || [];
          return {
            ...c,
            logo: getChannelLogo(c.name, c.logo),
            activeStreamCount: streams.length,
            primaryStream: streams[0] || null,
          };
        });

      return NextResponse.json({ success: true, count: result.length, channels: result });
    } else {
      // In-Memory Fallback Mode
      let channels = inMemoryDb.getChannels();
      const streams = inMemoryDb.getStreams();

      if (category && category !== "All") {
        channels = channels.filter((c) => c.category === category);
      }
      if (subCategory && subCategory !== "All") {
        channels = channels.filter((c) => c.subCategory === subCategory);
      }
      if (country && country !== "All") {
        channels = channels.filter((c) => c.country === country);
      }
      if (search) {
        channels = channels.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));
      }

      // Filter OUT channels with ZERO active streams
      const result = channels
        .map((c) => {
          const chActiveStreams = streams.filter(
            (s) => s.channelId === c._id && s.status === "active"
          );
          return {
            ...c,
            logo: getChannelLogo(c.name, c.logo),
            activeStreamCount: chActiveStreams.length,
            primaryStream: chActiveStreams[0] || null,
          };
        })
        .filter((c) => c.activeStreamCount > 0)
        .sort((a, b) => {
          // Pinned channels first
          const aPinned = (a as any).isPinned === true ? 1 : 0;
          const bPinned = (b as any).isPinned === true ? 1 : 0;
          if (bPinned !== aPinned) return bPinned - aPinned;
          // Within pinned, sort by priorityOrder ascending
          if (aPinned && bPinned) {
            const aOrder = (a as any).priorityOrder ?? 99;
            const bOrder = (b as any).priorityOrder ?? 99;
            return aOrder - bOrder;
          }
          // Unpinned: sort alphabetically by name
          return a.name.localeCompare(b.name);
        });

      return NextResponse.json({ success: true, count: result.length, channels: result });
    }
  } catch (error: any) {
    console.error("GET /api/channels error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch channels" },
      { status: 500 }
    );
  }
}
