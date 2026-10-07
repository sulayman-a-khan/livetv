import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { getChannelLogo } from "@/lib/utils";
import { MAX_CONSECUTIVE_FAILURES } from "@/lib/streamHealth";
import { getCategoryBySlug, isChannelInCategory } from "@/lib/categories";

// SoluPlay Channels API Route - Force Recompile for Logo Fix
export const dynamic = "force-dynamic";

/**
 * The catalogue is read by every visitor on every page, so it is served from the
 * edge for half a minute instead of hitting Atlas per request. Stale is fine for
 * a TV grid (a pin or a recovered stream shows up within ~30s), and
 * stale-while-revalidate means a visitor never waits for a cache miss.
 */
const CATALOGUE_CACHE = "public, s-maxage=30, stale-while-revalidate=300";

/** Only the fields the grid, the rails and the watch sidebar actually render. */
const CHANNEL_FIELDS =
  "_id name logo category subCategory country tags isPinned priorityOrder streamUrl url";

/**
 * Mirror rows as they may leave the server. `headers` (upstream Referer/Origin
 * and sometimes provider credentials) and `lastCheck` diagnostics stay behind:
 * they are only ever used by the server-side prober and the admin editor.
 */
const STREAM_FIELDS = "_id channelId url priority status latency failedAttempts";

function toPublicStream(stream: {
  _id: unknown;
  url: string;
  priority?: number;
  status?: string;
  latency?: number;
  failedAttempts?: number;
}) {
  return {
    _id: String(stream._id),
    url: stream.url,
    priority: stream.priority ?? 99,
    status: stream.status || "active",
    latency: stream.latency ?? 0,
    failedAttempts: stream.failedAttempts ?? 0,
  };
}

/** active → degraded (while its failure streak is short) → nothing. */
function pickUsableStreams<T extends { status?: string; failedAttempts?: number }>(
  candidates: T[]
): T[] {
  const active = candidates.filter((stream) => stream.status === "active");
  if (active.length > 0) return active;
  const degraded = candidates.filter(
    (stream) =>
      stream.status === "degraded" && (stream.failedAttempts || 0) < MAX_CONSECUTIVE_FAILURES
  );
  return degraded;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const category = searchParams.get("category");
    const subCategory = searchParams.get("subCategory");
    const country = searchParams.get("country");
    const search = searchParams.get("search");
    // A rail is one of the six fixed display categories. The category page asks
    // for its own rail instead of downloading the whole catalogue and filtering
    // in the browser — the matching rules are shared, so the result is identical.
    const rail = searchParams.get("rail");
    const railConfig = rail ? getCategoryBySlug(rail) : undefined;

    const conn = await connectToDatabase();

    if (conn) {
      // MongoDB Mode: Find matching channels
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filter: any = {};
      if (category && category !== "All") filter.category = category;
      if (subCategory && subCategory !== "All") filter.subCategory = subCategory;
      if (country && country !== "All") filter.country = country;
      if (search) filter.name = { $regex: search, $options: "i" };

      const allChannels = await Channel.find(filter)
        .sort({ isPinned: -1, priorityOrder: 1, name: 1 })
        .select(CHANNEL_FIELDS)
        .lean();

      // Filtered before the stream lookup, so a rail request only reads the
      // mirrors it is going to send.
      const channels = railConfig
        ? allChannels.filter((c) => isChannelInCategory(c as any, railConfig))
        : allChannels;

      const channelIds = channels.map((c) => c._id);

      // Only the links a viewer could actually play: broken mirrors are internal
      // bookkeeping, and publishing one as `primaryStream` hands the player a URL
      // that is already known to be dead.
      const usableStreams = channelIds.length
        ? await StreamLink.find({
            channelId: { $in: channelIds },
            status: { $in: ["active", "degraded"] },
          })
            .sort({ priority: 1, latency: 1 })
            .select(STREAM_FIELDS)
            .lean()
        : [];

      // Group streams by channelId
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const streamMap = new Map<string, any[]>();
      for (const stream of usableStreams) {
        const cId = stream.channelId ? stream.channelId.toString() : "";
        if (!cId) continue;
        if (!streamMap.has(cId)) streamMap.set(cId, []);
        streamMap.set(cId, [...streamMap.get(cId)!, stream]);
      }

      const result = channels.map((c) => {
        const cId = c._id.toString();
        const streams = pickUsableStreams(streamMap.get(cId) || []);
        const directUrl = (c as any).streamUrl || (c as any).url;
        const primaryStream = streams.length > 0 ? toPublicStream(streams[0]) : null;

        return {
          ...c,
          _id: cId,
          logo: getChannelLogo(c.name, c.logo),
          ...(directUrl ? { streamUrl: directUrl } : {}),
          activeStreamCount: streams.length || (directUrl ? 1 : 0),
          primaryStream,
        };
      });

      return NextResponse.json(
        { success: true, count: result.length, channels: result },
        { headers: { "Cache-Control": CATALOGUE_CACHE } }
      );
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
      if (railConfig) {
        channels = channels.filter((c) => isChannelInCategory(c as any, railConfig));
      }

      const result = channels
        .map((c) => {
          const candidates = streams.filter((s) => s.channelId === c._id);
          const chActiveStreams = pickUsableStreams(candidates);
          const directUrl = (c as any).streamUrl || (c as any).url;
          const primaryStream =
            chActiveStreams.length > 0
              ? toPublicStream(chActiveStreams[0])
              : directUrl
              ? { _id: `direct_${c._id}`, url: directUrl, priority: 1, status: "active", latency: 0, failedAttempts: 0 }
              : null;

          return {
            ...c,
            logo: getChannelLogo(c.name, c.logo),
            activeStreamCount: chActiveStreams.length || (directUrl ? 1 : 0),
            primaryStream,
          };
        })
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

      return NextResponse.json(
        { success: true, count: result.length, channels: result },
        { headers: { "Cache-Control": CATALOGUE_CACHE } }
      );
    }
  } catch (error: any) {
    console.error("GET /api/channels error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch channels" },
      { status: 500 }
    );
  }
}
