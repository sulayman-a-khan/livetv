import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isAuthorizedAdmin } from "@/lib/adminAuth";
import { listPremiumChannels, updatePremiumChannel, type PremiumChannelRecord } from "@/lib/premiumStore";
import { proxyKeyForRow } from "@/lib/premiumProxy";
import { performProxyAction } from "@/lib/proxyActions";
import { readBoxAdminRows, readProxyInspection } from "@/lib/proxyControl";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
    { status: 401 }
  );
}

function fail(error: any, fallback: string) {
  const status = typeof error?.status === "number" ? error.status : 500;
  console.error("GET/POST /api/admin/premium/live error:", error?.name || fallback);
  return NextResponse.json({ success: false, error: error?.message || fallback }, { status });
}

/**
 * The handle this row is filed under on the box.
 *
 * A row that was pushed keeps the handle the push wrote; a row that was made here has none
 * yet, and the handle its own id implies is the one it will be filed under.
 */
function boxKeyOf(row: PremiumChannelRecord): string {
  return row.proxyChannelKey || proxyKeyForRow(row._id);
}

/**
 * GET /api/admin/premium/live
 *
 * The Live on Server list: every premium channel, and whether it is on air.
 *
 * Two switches live on a channel and they are not the same switch. The box's says the lane
 * is on — that is what actually plays. The site's says the row is shown to viewers. A channel
 * can be live on the box and hidden from the rail, and one can be on the rail with its lane
 * off, and both of those are facts the admin has to see separately rather than as one
 * "active" field.
 *
 * The box's own state comes from the box, so a lane that is on but unusable reads as unusable
 * rather than as live.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isAuthorizedAdmin(req)) return unauthorized();

    const [rows, box, inspection] = await Promise.all([
      listPremiumChannels(),
      readBoxAdminRows(),
      readProxyInspection(),
    ]);
    const byKey = new Map(box.channels.map((channel) => [channel.channelKey, channel]));
    // The admin surface says which lanes the box holds and whether each one is switched on.
    // The read-only surface says what the box makes of them — serving, inactive, or unusable
    // and why — and it is the only one of the two that says it in words a browser can show.
    const verdicts = new Map(inspection.channels.map((channel) => [channel.channelKey, channel]));

    const channels = rows.map((row) => {
      const key = boxKeyOf(row);
      const onBox = byKey.get(key) ?? verdicts.get(key) ?? null;
      const verdict = verdicts.get(key) ?? null;
      return {
        channelId: row._id,
        name: row.name,
        category: row.category,
        logoUrl: row.logoUrl,
        providerId: row.providerId,
        streamId: row.streamId,
        /** How many backups the row carries. A count, never the ids. */
        backups: row.backupStreamIds.length,
        /** The site's switch: is this row shown to viewers? */
        visible: row.active,
        /** The box's switch: is this lane on air? */
        live: onBox ? onBox.active : false,
        /** Whether the box knows this channel at all. */
        onBox: Boolean(onBox),
        /** What the box says about the lane: serving, inactive, or unusable. */
        boxState: verdict ? verdict.state : null,
        /** A code, never the box's own text: the lane cannot be used. */
        boxProblem: verdict ? verdict.problem : null,
      };
    });

    return NextResponse.json({
      success: true,
      reachable: box.reachable,
      authorized: box.authorized,
      count: channels.length,
      channels,
    });
  } catch (error: any) {
    return fail(error, "Failed to load the live list");
  }
}

/**
 * POST /api/admin/premium/live
 *
 * Move one of a channel's two switches.
 *
 * The body is `{ scope, channelId, active }`:
 *
 *   - `scope: "live"` — the box's switch. The lane is put on air or taken off it.
 *   - `scope: "visible"` — the site's switch. The row is shown to viewers or taken off the rail.
 *
 * The two are separate calls on purpose: a channel the admin wants to keep on the rail while
 * its lane is being fixed is one switch, and a channel whose stream is up but which should
 * not be advertised yet is the other. Neither switch edits the channel, and neither removes
 * it.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await authorizeAdminRequest(req);
    if (!auth.ok) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    const scope = typeof auth.body.scope === "string" ? auth.body.scope.trim().toLowerCase() : "";
    const channelId = typeof auth.body.channelId === "string" ? auth.body.channelId.trim() : "";
    const active = auth.body.active;

    if (scope !== "live" && scope !== "visible") {
      return NextResponse.json(
        { success: false, error: "Scope must be live or visible" },
        { status: 400 }
      );
    }
    if (!channelId) {
      return NextResponse.json({ success: false, error: "Channel id is required" }, { status: 400 });
    }
    if (typeof active !== "boolean") {
      return NextResponse.json(
        { success: false, error: "active must be true or false" },
        { status: 400 }
      );
    }

    const row = (await listPremiumChannels()).find((channel) => channel._id === channelId);
    if (!row) {
      return NextResponse.json({ success: false, error: "Premium channel not found" }, { status: 404 });
    }

    if (scope === "visible") {
      const updated = await updatePremiumChannel(row._id, { active });
      if (!updated) {
        return NextResponse.json({ success: false, error: "Premium channel not found" }, { status: 404 });
      }
      return NextResponse.json({ success: true, channelId: row._id, visible: updated.active });
    }

    const answer = await performProxyAction({
      action: "set_channel_active",
      target: boxKeyOf(row),
      active,
    });

    if (answer.status !== 200) {
      const code = (answer.body.result as Record<string, unknown> | undefined)?.code;
      const error =
        code === "unknown_channel"
          ? "This channel is not on the stream box yet"
          : answer.body.error || "the stream box refused the change";
      return NextResponse.json(
        { success: false, error, code: answer.body.code, result: answer.body.result },
        { status: answer.status }
      );
    }

    return NextResponse.json({ success: true, channelId: row._id, live: active });
  } catch (error: any) {
    return fail(error, "Failed to change the channel's state");
  }
}
