import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import { canonicalStreamUrl } from "@/lib/channelIdentity";
import { probeStreamUrl } from "@/lib/streamProbe";
import { refreshChannelLinks } from "@/lib/maintenanceRunner";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/channels/[id]/streams
 * Manually attaches one server link to an existing channel.
 *
 * The link is probed before it is stored, so its measured latency immediately
 * feeds the fastest-first ordering. Afterwards `refreshChannelLinks` runs,
 * which renumbers the channel's servers and — if this new link is real and
 * working — purges any leftover placeholder/test links.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json().catch(() => ({}));

    if (!isAuthorizedAdmin(req, body.secretKey)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const { id } = params;
    const url = String(body.url || "").trim();

    if (!/^https?:\/\//i.test(url)) {
      return NextResponse.json(
        { success: false, error: "A valid http(s) stream URL is required" },
        { status: 400 }
      );
    }

    const probe = await probeStreamUrl(url, 8000);
    const status: "active" | "broken" = probe.ok ? "active" : "broken";
    const now = new Date();
    const conn = await connectToDatabase();

    if (conn && mongoose.isValidObjectId(id)) {
      const channel = await Channel.findById(id);
      if (!channel) {
        return NextResponse.json({ success: false, error: "Channel not found" }, { status: 404 });
      }

      const existing = await StreamLink.find({ channelId: id }).lean();
      if (existing.some((s) => canonicalStreamUrl(s.url) === canonicalStreamUrl(url))) {
        return NextResponse.json(
          { success: false, error: "This server link already exists on the channel" },
          { status: 409 }
        );
      }

      const created = await StreamLink.create({
        channelId: id,
        url,
        priority: existing.length + 1,
        status,
        latency: probe.latency,
        failedAttempts: probe.ok ? 0 : 1,
        firstFailedAt: probe.ok ? null : now,
        lastCheckedAt: now,
      });

      await refreshChannelLinks(id);

      return NextResponse.json({
        success: true,
        stream: created,
        probe: { ok: probe.ok, latency: probe.latency, reason: probe.reason },
      });
    }

    // ---- In-memory mode ----
    const channel = inMemoryDb.getChannelById(id);
    if (!channel) {
      return NextResponse.json({ success: false, error: "Channel not found" }, { status: 404 });
    }

    const existing = inMemoryDb.getStreamsForChannel(id);
    if (existing.some((s) => canonicalStreamUrl(s.url) === canonicalStreamUrl(url))) {
      return NextResponse.json(
        { success: false, error: "This server link already exists on the channel" },
        { status: 409 }
      );
    }

    const stream = {
      _id: `str_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      channelId: id,
      url,
      priority: existing.length + 1,
      status,
      failedAttempts: probe.ok ? 0 : 1,
      firstFailedAt: probe.ok ? null : now,
      lastCheckedAt: now,
      latency: probe.latency,
      createdAt: now,
      updatedAt: now,
    } as const;

    inMemoryDb.addStream({ ...stream });
    await refreshChannelLinks(id);

    return NextResponse.json({
      success: true,
      stream,
      probe: { ok: probe.ok, latency: probe.latency, reason: probe.reason },
    });
  } catch (error: any) {
    console.error("POST /api/admin/channels/[id]/streams error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to add server link" },
      { status: 500 }
    );
  }
}
