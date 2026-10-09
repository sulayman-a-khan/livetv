import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { refreshChannelLinks } from "@/lib/maintenanceRunner";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import { checkHlsStream } from "@/lib/streamProbe";
import { classifyLinkHealth, decideStreamHealth, type StoredStreamStatus } from "@/lib/streamHealth";
import type { BrowserBlocker } from "@/lib/streamProbe";

export const dynamic = "force-dynamic";

/** One link, one probe: enough to answer "does it play right now" without a full pass. */
const PROBE_OPTS = {
  timeoutMs: 10000,
  maxAttempts: 2,
  checkLiveRefresh: false,
  useFfprobe: false,
  segmentSampleSize: 1,
} as const;

/** The admin-facing view of a link: stored fields plus the derived health state. */
function linkView(link: {
  _id: unknown;
  url?: string;
  priority?: number;
  status: string;
  latency?: number;
  failedAttempts?: number;
  lastCheckedAt?: Date | string | null;
  lastCountedFailureDay?: string | null;
  browserBlocker?: string | null;
  deliveryMisses?: number | null;
  deliveryHidden?: boolean;
  manual?: boolean;
  adminDisabled?: boolean;
}) {
  return {
    _id: String(link._id),
    url: link.url,
    priority: link.priority ?? 99,
    status: link.status,
    latency: link.latency ?? 0,
    failedAttempts: link.failedAttempts ?? 0,
    lastCheckedAt: link.lastCheckedAt ?? null,
    lastCountedFailureDay: link.lastCountedFailureDay ?? null,
    browserBlocker: link.browserBlocker ?? null,
    deliveryMisses: link.deliveryMisses ?? 0,
    deliveryHidden: Boolean(link.deliveryHidden),
    manual: Boolean(link.manual),
    adminDisabled: Boolean(link.adminDisabled),
    health: classifyLinkHealth({
      status: link.status as StoredStreamStatus,
      failedAttempts: link.failedAttempts ?? 0,
      latency: link.latency ?? 0,
      lastCheckedAt: link.lastCheckedAt,
      adminDisabled: link.adminDisabled,
      browserBlocker: (link.browserBlocker ?? null) as BrowserBlocker | null,
      deliveryHidden: Boolean(link.deliveryHidden),
      deliveryMisses: link.deliveryMisses ?? 0,
    }),
  };
}

/**
 * PATCH /api/admin/streams/[id]  { action: "test" | "disable" | "restore" }
 *
 * The manual controls over one server link, which is the point where admin
 * intent beats automation:
 *   - `test` probes it now and applies the same day-gated rules the scheduler
 *     uses, so a manual pass can never retire a link faster than a daily one.
 *   - `disable` takes it out of service. A disabled link is invisible to
 *     viewers, is never probed by the health checker, and is never deleted by
 *     the dead-link purge — only an admin can bring it back.
 *   - `restore` clears the flag, wipes the failure streak and re-probes, so a
 *     link only becomes visible again once it has been verified to play.
 */
export async function PATCH(
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

    const action = String(body.action || "").toLowerCase();
    if (!["test", "disable", "restore"].includes(action)) {
      return NextResponse.json(
        { success: false, error: 'action must be "test", "disable" or "restore"' },
        { status: 400 }
      );
    }

    const { id } = params;
    const conn = await connectToDatabase();
    const now = new Date();

    if (conn && mongoose.isValidObjectId(id)) {
      const stream = await StreamLink.findById(id);
      if (stream) {
        const channelId = String(stream.channelId);

        if (action === "disable") {
          stream.adminDisabled = true;
          await stream.save();
          await refreshChannelLinks(channelId);
          return NextResponse.json({ success: true, action, stream: linkView(stream.toObject()) });
        }

        if (action === "restore") {
          stream.adminDisabled = false;
          stream.failedAttempts = 0;
          stream.firstFailedAt = null;
          stream.lastCountedFailureDay = null;
          stream.browserBlocker = null;
          stream.deliveryMisses = 0;
          stream.lastDeliveryMissAt = null;
          stream.deliveryHidden = false;
        }

        const result = await checkHlsStream(stream.url, {
          ...PROBE_OPTS,
          headers: (stream as unknown as { headers?: Record<string, string> }).headers,
        });
        const decision = decideStreamHealth(
          stream.status as StoredStreamStatus,
          stream.failedAttempts || 0,
          stream.firstFailedAt,
          result,
          now,
          stream.lastCountedFailureDay,
          {
            deliveryHidden: stream.deliveryHidden,
            deliveryMisses: stream.deliveryMisses,
            lastDeliveryMissAt: stream.lastDeliveryMissAt,
          }
        );
        stream.status = decision.status;
        stream.latency = decision.latency;
        stream.failedAttempts = decision.failedAttempts;
        stream.firstFailedAt = decision.firstFailedAt;
        stream.lastCheckedAt = decision.lastCheckedAt;
        stream.lastCountedFailureDay = decision.lastCountedFailureDay;
        stream.browserBlocker = decision.browserBlocker;
        stream.deliveryMisses = decision.deliveryMisses;
        stream.lastDeliveryMissAt = decision.lastDeliveryMissAt;
        stream.deliveryHidden = decision.deliveryHidden;
        await stream.save();
        await refreshChannelLinks(channelId);

        return NextResponse.json({
          success: true,
          action,
          stream: linkView(stream.toObject()),
          probe: {
            ok: result.ok,
            status: result.status,
            latency: result.latency,
            reason: result.reason,
            resolution: result.resolution,
            browserBlocker: result.browserBlocker,
            deliveryMisses: result.deliveryMisses,
          },
        });
      }
    }

    // ---- In-memory mode ----
    const mem = inMemoryDb.getStreams().find((s) => s._id === id);
    if (!mem) {
      return NextResponse.json({ success: false, error: "Stream link not found" }, { status: 404 });
    }

    if (action === "disable") {
      mem.adminDisabled = true;
      inMemoryDb.saveState();
      await refreshChannelLinks(mem.channelId);
      return NextResponse.json({ success: true, action, stream: linkView(mem) });
    }

    if (action === "restore") {
      mem.adminDisabled = false;
      mem.failedAttempts = 0;
      mem.firstFailedAt = null;
      mem.lastCountedFailureDay = null;
      mem.browserBlocker = null;
      mem.deliveryMisses = 0;
      mem.lastDeliveryMissAt = null;
      mem.deliveryHidden = false;
    }

    const result = await checkHlsStream(mem.url, { ...PROBE_OPTS, headers: mem.headers });
    const decision = decideStreamHealth(
      mem.status as StoredStreamStatus,
      mem.failedAttempts || 0,
      mem.firstFailedAt,
      result,
      now,
      mem.lastCountedFailureDay,
      {
        deliveryHidden: mem.deliveryHidden,
        deliveryMisses: mem.deliveryMisses,
        lastDeliveryMissAt: mem.lastDeliveryMissAt,
      }
    );
    mem.status = decision.status;
    mem.latency = decision.latency;
    mem.failedAttempts = decision.failedAttempts;
    mem.firstFailedAt = decision.firstFailedAt;
    mem.lastCheckedAt = decision.lastCheckedAt;
    mem.lastCountedFailureDay = decision.lastCountedFailureDay;
    mem.browserBlocker = decision.browserBlocker;
    mem.deliveryMisses = decision.deliveryMisses;
    mem.lastDeliveryMissAt = decision.lastDeliveryMissAt;
    mem.deliveryHidden = decision.deliveryHidden;
    inMemoryDb.saveState();
    await refreshChannelLinks(mem.channelId);

    return NextResponse.json({
      success: true,
      action,
      stream: linkView(mem),
      probe: {
        ok: result.ok,
        status: result.status,
        latency: result.latency,
        reason: result.reason,
        browserBlocker: result.browserBlocker,
        deliveryMisses: result.deliveryMisses,
      },
    });
  } catch (error: any) {
    console.error("PATCH /api/admin/streams/[id] error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to update stream link" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!isAuthorizedAdmin(req)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const { id } = params;
    const conn = await connectToDatabase();

    // Remember the owner so the remaining links can be renumbered afterwards.
    let channelId: string | null = null;

    if (conn && mongoose.isValidObjectId(id)) {
      const doc = await StreamLink.findById(id).lean();
      if (doc) channelId = String(doc.channelId);
      await StreamLink.findByIdAndDelete(id);
    }

    if (!channelId) {
      const mem = inMemoryDb.getStreams().find((s) => s._id === id);
      if (mem) channelId = mem.channelId;
    }

    // Always clean inMemoryDb as well
    inMemoryDb.deleteStream(id);

    // Keep "fastest link is Server 1" true after the gap left by the delete.
    if (channelId) await refreshChannelLinks(channelId);

    return NextResponse.json({
      success: true,
      message: `Stream link ${id} deleted successfully`,
    });
  } catch (error: any) {
    console.error("DELETE /api/admin/streams/[id] error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Failed to delete stream link" },
      { status: 500 }
    );
  }
}
