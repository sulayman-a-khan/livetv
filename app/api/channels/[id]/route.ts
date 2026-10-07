import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import SportsEvent from "@/models/SportsEvent";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { getChannelLogo } from "@/lib/utils";
import { MAX_CONSECUTIVE_FAILURES } from "@/lib/streamHealth";
import { resolveStreamUrl } from "@/lib/streamUrl";
import { getDynamicStreamBaseUrl } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * A channel's mirror list changes only when a probe or a viewer report moves it,
 * so it is safe to serve from the edge briefly. Playback still gets a fresh
 * manifest from the CDN — only this metadata is cached.
 */
const CHANNEL_CACHE = "public, s-maxage=15, stale-while-revalidate=120";

/**
 * `headers` (upstream Referer/Origin, sometimes provider credentials) and the
 * `lastCheck` diagnostics blob are server-side only: no browser can set a
 * Referer, so shipping them just leaks the upstream configuration.
 */
const STREAM_FIELDS = "_id url priority status latency failedAttempts";

/** Same field whitelist, applied to the in-memory store's rows. */
function projectStream(stream: {
  _id: unknown;
  url?: string;
  priority?: number;
  status?: string;
  latency?: number;
  failedAttempts?: number;
}) {
  return {
    _id: String(stream._id),
    url: stream.url,
    priority: stream.priority ?? 99,
    status: stream.status ?? "active",
    latency: stream.latency ?? 0,
    failedAttempts: stream.failedAttempts ?? 0,
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const conn = await connectToDatabase();

    // 1. If MongoDB is connected, query Channel or SportsEvent
    if (conn) {
      if (mongoose.isValidObjectId(id)) {
        const [channel, streams] = await Promise.all([
          Channel.findById(id).lean(),
          StreamLink.find({ channelId: id })
            .sort({ priority: 1, latency: 1 })
            .select(STREAM_FIELDS)
            .lean(),
        ]);

        if (channel) {
          const active = streams.filter((stream) => stream.status === "active");
          const degraded = streams.filter(
            (stream) => stream.status === "degraded" && (stream.failedAttempts || 0) < MAX_CONSECUTIVE_FAILURES
          );
          let usableStreams = active.length > 0 ? active : degraded.length > 0 ? degraded : streams;

          const directUrl = (channel as any).streamUrl || (channel as any).url;
          if (usableStreams.length === 0 && directUrl) {
            usableStreams = [
              {
                _id: `direct_${channel._id}`,
                channelId: channel._id,
                url: directUrl,
                priority: 1,
                status: "active",
                latency: 100,
              } as any,
            ];
          }

          return NextResponse.json(
            {
              success: true,
              channel: {
                ...channel,
                logo: getChannelLogo(channel.name, channel.logo),
                streams: usableStreams.map(projectStream),
              },
            },
            { headers: { "Cache-Control": CHANNEL_CACHE } }
          );
        }
      }

      // 1b. Check if this ID is a SportsEvent in MongoDB
      try {
        const sportDoc = mongoose.isValidObjectId(id)
          ? await SportsEvent.findById(id).lean()
          : await SportsEvent.findOne({ $or: [{ externalId: id }, { _id: id } as any] }).lean();

        if (sportDoc) {
          const activeBaseUrl = await getDynamicStreamBaseUrl();
          const primary = resolveStreamUrl(sportDoc.primaryStreamUrl || "", activeBaseUrl);
          const backups = (sportDoc.backupStreamUrls || []).filter(Boolean).map((u) => resolveStreamUrl(u, activeBaseUrl));
          const streams: any[] = [];
          if (primary) {
            streams.push({
              _id: `sport_primary_${sportDoc._id}`,
              channelId: String(sportDoc._id),
              url: primary,
              priority: 1,
              status: "active",
              latency: 50,
            });
          }
          backups.forEach((bUrl, i) => {
            streams.push({
              _id: `sport_backup_${sportDoc._id}_${i}`,
              channelId: String(sportDoc._id),
              url: bUrl,
              priority: i + 2,
              status: "active",
              latency: 80,
            });
          });

          return NextResponse.json(
            {
              success: true,
              channel: {
                _id: String(sportDoc._id),
                name: sportDoc.matchTitle,
                logo: getChannelLogo(sportDoc.sportType, ""),
                category: "Live Sports",
                country: "Global",
                streams,
              },
            },
            { headers: { "Cache-Control": CHANNEL_CACHE } }
          );
        }
      } catch {
        // Continue to fallback
      }
    }

    // 2. Fallback to In-Memory Mode (for custom string IDs like ch_...)
    const channels = inMemoryDb.getChannels();
    const streams = inMemoryDb.getStreams();

    const channel = channels.find((c) => c._id === id);
    if (!channel) {
      return NextResponse.json({ success: false, error: "Channel not found" }, { status: 404 });
    }

    const candidates = streams
      .filter((s) => s.channelId === id)
      .sort((a, b) => (a.priority || 99) - (b.priority || 99) || (a.latency || 0) - (b.latency || 0));
    const active = candidates.filter((stream) => stream.status === "active");
    const degraded = candidates.filter(
      (stream) => stream.status === "degraded" && (stream.failedAttempts || 0) < MAX_CONSECUTIVE_FAILURES
    );
    let chStreams = active.length > 0 ? active : degraded.length > 0 ? degraded : candidates;

    const directUrl = (channel as any).streamUrl || (channel as any).url;
    if (chStreams.length === 0 && directUrl) {
      chStreams = [
        {
          _id: `direct_${channel._id}`,
          channelId: channel._id,
          url: directUrl,
          priority: 1,
          status: "active",
          latency: 100,
          failedAttempts: 0,
          firstFailedAt: null,
          lastCheckedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
    }

    return NextResponse.json(
      {
        success: true,
        channel: {
          ...channel,
          logo: getChannelLogo(channel.name, channel.logo),
          streams: chStreams.map(projectStream),
        },
      },
      { headers: { "Cache-Control": CHANNEL_CACHE } }
    );
  } catch (error: any) {
    console.error("GET /api/channels/[id] error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch channel details" },
      { status: 500 }
    );
  }
}
