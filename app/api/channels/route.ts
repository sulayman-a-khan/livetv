import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { getChannelLogo } from "@/lib/utils";
import { MAX_CONSECUTIVE_FAILURES } from "@/lib/streamHealth";
import { getCategoryBySlug, isChannelCategory } from "@/lib/categories";

// SoluPlay Channels API Route - Force Recompile for Logo Fix
export const dynamic = "force-dynamic";

/**
 * The public catalogue is the curated one: only channels an admin has pinned are
 * ever listed here, in any mode, for any parameter combination. An unpinned
 * channel exists in the database and in the Admin Dashboard only.
 *
 * The catalogue is read by every visitor on every page, so it is served from the
 * edge for half a minute instead of hitting Atlas per request. Stale is fine for
 * a TV grid (a pin or a recovered stream shows up within ~30s), and
 * stale-while-revalidate means a visitor never waits for a cache miss.
 */
const CATALOGUE_CACHE = "public, s-maxage=30, stale-while-revalidate=300";

/** Only the fields the grid, the rails and the watch sidebar actually render. */
const CHANNEL_FIELDS =
  "_id name logo category tags isPinned priorityOrder streamUrl url";

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
    const search = searchParams.get("search");
    // A rail is one of the five fixed display categories. The category page asks
    // for its own rail instead of downloading the whole catalogue and filtering
    // in the browser — the matching rules are shared, so the result is identical.
    const rail = searchParams.get("rail");
    const railConfig = rail ? getCategoryBySlug(rail) : undefined;

    // A rail slug nobody recognises lists nothing. Falling back to the whole
    // catalogue would turn a stale link into an uncurated browse page.
    if (rail && !railConfig) {
      return NextResponse.json(
        { success: true, count: 0, channels: [] },
        { headers: { "Cache-Control": CATALOGUE_CACHE } }
      );
    }

    // `rail` and `category` are the same axis now that a channel has exactly one
    // category, so the rail simply supplies the category value.
    const requestedCategory = railConfig ? railConfig.category : category;
    if (requestedCategory && !isChannelCategory(requestedCategory)) {
      return NextResponse.json(
        { success: true, count: 0, channels: [] },
        { headers: { "Cache-Control": CATALOGUE_CACHE } }
      );
    }

    const conn = await connectToDatabase();

    if (conn) {
      // MongoDB Mode: the pinned catalogue only, then the optional filters.
      const filter: Record<string, unknown> = { isPinned: true };
      if (requestedCategory && requestedCategory !== "All") filter.category = requestedCategory;
      if (search) filter.name = { $regex: search, $options: "i" };

      const channels = await Channel.find(filter)
        .sort({ isPinned: -1, priorityOrder: 1, name: 1 })
        .select(CHANNEL_FIELDS)
        .lean();

      const channelIds = channels.map((c) => c._id);

      // Only the links a viewer could actually play: broken mirrors are internal
      // bookkeeping, and publishing one as `primaryStream` hands the player a URL
      // that is already known to be dead.
      const usableStreams = channelIds.length
        ? await StreamLink.find({
            channelId: { $in: channelIds },
            status: { $in: ["active", "degraded"] },
            adminDisabled: { $ne: true },
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

      const result = channels
        .map((c) => {
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
        })
        // A channel whose every link has failed its daily window is hidden, not
        // listed with an unplayable URL: a tile a viewer can click must be a
        // tile that plays. It reappears by itself the moment a check passes.
        .filter((c) => c.primaryStream !== null);

      return NextResponse.json(
        { success: true, count: result.length, channels: result },
        { headers: { "Cache-Control": CATALOGUE_CACHE } }
      );
    } else {
      // In-Memory Fallback Mode — the same pinned-only rule as the MongoDB branch.
      let channels = inMemoryDb.getChannels().filter((c) => c.isPinned === true);
      const streams = inMemoryDb.getStreams();

      if (requestedCategory && requestedCategory !== "All") {
        channels = channels.filter((c) => c.category === requestedCategory);
      }
      if (search) {
        channels = channels.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));
      }

      const result = channels
        .map((c) => {
          const candidates = streams.filter((s) => s.channelId === c._id && !s.adminDisabled);
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
        .filter((c) => c.primaryStream !== null)
        .sort((a, b) => {
          // Everything left is pinned, so the admin's board order is the only one.
          const aOrder = a.priorityOrder ?? 99;
          const bOrder = b.priorityOrder ?? 99;
          if (aOrder !== bOrder) return aOrder - bOrder;
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
