import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { getChannelLogo } from "@/lib/utils";
import { isUsableViewerLink } from "@/lib/streamHealth";
import { rankStreams } from "@/lib/channelMaintenance";

export const dynamic = "force-dynamic";

/**
 * A channel's mirror list changes only when a probe or a viewer report moves it,
 * so it is safe to serve from the edge briefly. Playback still gets a fresh
 * manifest from the CDN — only this metadata is cached.
 */
const CHANNEL_CACHE = "public, s-maxage=15, stale-while-revalidate=120";

// Curated-only, the same rule the catalogue list uses: an unpinned channel
// answers 404 here, so a saved or guessed `/watch/<id>` link cannot bypass the
// pin.

/**
 * `headers` (upstream Referer/Origin, sometimes provider credentials) and the
 * `lastCheck` diagnostics blob are server-side only: no browser can set a
 * Referer, so shipping them just leaks the upstream configuration.
 */
const STREAM_FIELDS = "_id url priority status latency failedAttempts";

/**
 * Read for the visibility gate only, and stripped by `projectStream` on the way
 * out: a link already labelled "Not delivering" is not allowed to be the reason
 * this channel still looks playable.
 */
const STREAM_GATE_FIELDS = " deliveryHidden deliveryMisses";

/**
 * Same field whitelist, applied to the in-memory store's rows. `rank` is the place
 * in the ladder this channel was just ranked into — players step through `streams`
 * by `priority`, so the published number has to be the one the ranking rule gave.
 */
function projectStream(
  stream: {
    _id: unknown;
    url?: string;
    priority?: number;
    status?: string;
    latency?: number;
    failedAttempts?: number;
  },
  rank: number
) {
  return {
    _id: String(stream._id),
    url: stream.url,
    priority: rank,
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

    // 1. If MongoDB is connected, query the Channel catalogue
    if (conn) {
      if (mongoose.isValidObjectId(id)) {
        const [channel, streams] = await Promise.all([
          Channel.findOne({ _id: id, isPinned: true }).lean(),
          // The stored rank is the ladder; `_id` only breaks a tie. Sorting by
          // `latency` here would let an unprobed link (stored 0 ms) lead the very
          // list the player walks on failover.
          StreamLink.find({ channelId: id, adminDisabled: { $ne: true } })
            .sort({ priority: 1, _id: 1 })
            .select(STREAM_FIELDS + STREAM_GATE_FIELDS)
            .lean(),
        ]);

        if (channel) {
          // Same rule as the catalogue: a viewer is only ever handed a link the
          // checker last saw delivering media. A `degraded` link is "Retrying" —
          // monitored in the admin gate, not offered here — so a channel whose
          // only link failed a check reports `playable: false` instead of handing
          // the player a URL that is already known to stall. The same holds for a
          // link already marked "Not delivering": another usable mirror on this
          // channel still carries it, but that link alone no longer does.
          const usableStreams = rankStreams(streams.filter(isUsableViewerLink));

          return NextResponse.json(
            {
              success: true,
              playable: usableStreams.length > 0,
              channel: {
                ...channel,
                logo: getChannelLogo(channel.name, channel.logo),
                streams: usableStreams.map((stream, rank) => projectStream(stream, rank + 1)),
              },
            },
            { headers: { "Cache-Control": CHANNEL_CACHE } }
          );
        }
      }
    }

    // 2. Fallback to In-Memory Mode (for custom string IDs like ch_...)
    const channels = inMemoryDb.getChannels();
    const streams = inMemoryDb.getStreams();

    // Curated-only, exactly as the MongoDB branch above.
    const channel = channels.find((c) => c._id === id && c.isPinned === true);
    if (!channel) {
      return NextResponse.json({ success: false, error: "Channel not found" }, { status: 404 });
    }

    const candidates = streams.filter((s) => s.channelId === id && !s.adminDisabled);
    const chStreams = rankStreams(candidates.filter(isUsableViewerLink));

    return NextResponse.json(
      {
        success: true,
        playable: chStreams.length > 0,
        channel: {
          ...channel,
          logo: getChannelLogo(channel.name, channel.logo),
          streams: chStreams.map((stream, rank) => projectStream(stream, rank + 1)),
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
