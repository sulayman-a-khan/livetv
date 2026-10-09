import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb, type InMemoryChannel } from "@/lib/inMemoryStore";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import { canonicalChannelKey } from "@/lib/channelIdentity";
import { probeStreamUrl } from "@/lib/streamProbe";
import { normalizeCategory } from "@/lib/categories";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/channels — Manual Channel Entry.
 *
 * Creates one curated channel from scratch: name, logo, exactly one of the five
 * categories and its first M3U8/MPEG-TS link. The stream is probed
 * before it is stored so the link lands with a real latency and the fastest-first
 * ordering is correct from the start.
 *
 * The new channel is always **unpinned**: nothing an admin types reaches viewers
 * until they pin it from the pinned board. It is marked `isManuallyEdited`, so no
 * automated pass may rewrite its category or delete its hand-added link.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    if (!isAuthorizedAdmin(req, body.secretKey)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const name = String(body.name || "").trim();
    const logo = String(body.logo || "").trim();
    const url = String(body.streamUrl || "").trim();
    const category = normalizeCategory(String(body.category || ""), name);

    if (!name) {
      return NextResponse.json(
        { success: false, error: "Channel name is required" },
        { status: 400 }
      );
    }
    if (!/^https?:\/\//i.test(url)) {
      return NextResponse.json(
        { success: false, error: "A valid http(s) M3U8 stream URL is required" },
        { status: 400 }
      );
    }

    const normalizedName = canonicalChannelKey(name);
    const conn = await connectToDatabase();

    // One identity, one record. Maintenance will not merge an unpinned duplicate
    // away, so a clash here has to be resolved by the admin, not by automation.
    if (conn) {
      const clash = await Channel.findOne({ normalizedName }).lean();
      if (clash) {
        return NextResponse.json(
          {
            success: false,
            error: `A channel named "${clash.name}" already exists. Edit that channel and add this server to it instead.`,
            channelId: String(clash._id),
          },
          { status: 409 }
        );
      }
    } else {
      const clash = inMemoryDb
        .getChannels()
        .find((c) => c.normalizedName === normalizedName || canonicalChannelKey(c.name) === normalizedName);
      if (clash) {
        return NextResponse.json(
          {
            success: false,
            error: `A channel named "${clash.name}" already exists. Edit that channel and add this server to it instead.`,
            channelId: clash._id,
          },
          { status: 409 }
        );
      }
    }

    const probe = await probeStreamUrl(url, 8000);
    const status: "active" | "broken" = probe.ok ? "active" : "broken";
    const now = new Date();

    if (conn) {
      const channel = await Channel.create({
        name,
        normalizedName,
        logo,
        category,
        isPinned: false,
        priorityOrder: 99,
        isManuallyEdited: true,
      });

      const created = await StreamLink.create({
        channelId: channel._id,
        url,
        priority: 1,
        status,
        latency: probe.latency,
        failedAttempts: probe.ok ? 0 : 1,
        firstFailedAt: probe.ok ? null : now,
        lastCheckedAt: now,
        // Hand-added: a playlist sync or the dead-link purge may never retire it.
        manual: true,
        browserBlocker: probe.browserBlocker,
      });

      return NextResponse.json({
        success: true,
        channel,
        stream: created,
        probe: { ok: probe.ok, latency: probe.latency, reason: probe.reason },
      });
    }

    // ---- In-memory mode ----
    const channelId = `ch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const channel: InMemoryChannel = {
      _id: channelId,
      name,
      normalizedName,
      logo,
      category,
      isPinned: false,
      priorityOrder: 99,
      isManuallyEdited: true,
      createdAt: now,
      updatedAt: now,
    };
    inMemoryDb.addChannel(channel);

    const streamId = `str_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    inMemoryDb.addStream({
      _id: streamId,
      channelId,
      url,
      priority: 1,
      status,
      latency: probe.latency,
      failedAttempts: probe.ok ? 0 : 1,
      firstFailedAt: probe.ok ? null : now,
      lastCheckedAt: now,
      manual: true,
      browserBlocker: probe.browserBlocker,
      createdAt: now,
      updatedAt: now,
    });

    return NextResponse.json({
      success: true,
      channel,
      stream: { _id: streamId, channelId, url, priority: 1, status, manual: true },
      probe: { ok: probe.ok, latency: probe.latency, reason: probe.reason },
    });
  } catch (error: any) {
    console.error("POST /api/admin/channels error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to create channel" },
      { status: 500 }
    );
  }
}
