import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isAuthorizedAdmin } from "@/lib/adminAuth";
import {
  deletePremiumChannel,
  listPremiumChannels,
  updatePremiumChannel,
} from "@/lib/premiumStore";
import { validatePremiumChannelInput } from "@/lib/premiumFixtures";
import { proxyConfigProblem, retractPremiumSource } from "@/lib/premiumProxy";

export const dynamic = "force-dynamic";

function fail(error: any, fallback: string) {
  const status = typeof error?.status === "number" ? error.status : 500;
  console.error("PATCH/DELETE /api/admin/premium/channels/[id] error:", error);
  return NextResponse.json({ success: false, error: error?.message || fallback }, { status });
}

/**
 * PATCH /api/admin/premium/channels/[id]
 * Partial edit — only the keys that were sent are touched, so switching a channel
 * off never rewrites its URL or its headers.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await authorizeAdminRequest(req);
    if (!auth.ok) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    const { value, errors } = validatePremiumChannelInput(auth.body, false);
    if (errors.length > 0) {
      return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 400 });
    }
    if (Object.keys(value).length === 0) {
      return NextResponse.json(
        { success: false, error: "Nothing to update — send at least one field" },
        { status: 400 }
      );
    }

    const channel = await updatePremiumChannel(params.id, value);
    if (!channel) {
      return NextResponse.json({ success: false, error: "Premium channel not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, channel });
  } catch (error: any) {
    return fail(error, "Failed to update premium channel");
  }
}

/**
 * DELETE /api/admin/premium/channels/[id]
 * Removes the channel. Fixtures that pointed at it survive with the link cleared,
 * because deleting a match is the admin's decision alone.
 *
 * A row that still has a lane on the stream box takes that lane with it. This happens here
 * rather than in the panel so it cannot be bypassed by anything that deletes a row directly:
 * an orphan lane is a live premium stream with a credential in it that no screen points at.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    if (!isAuthorizedAdmin(req)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const row = (await listPremiumChannels()).find((channel) => channel._id === params.id);
    if (row?.proxyChannelKey) {
      const problem = proxyConfigProblem();
      if (problem) {
        return NextResponse.json(
          {
            success: false,
            error: `${problem}, so "${row.proxyChannelKey}" could not be taken off the box first. Clear this row's handle to delete it without that.`,
          },
          { status: 503 }
        );
      }
      const retracted = await retractPremiumSource(row.proxyChannelKey);
      if (!retracted.ok) {
        // Keep the row: it is the only thing that remembers which handle to remove.
        return NextResponse.json(
          { success: false, error: `the source was not removed, so nothing was deleted: ${retracted.error}` },
          { status: 502 }
        );
      }
    }

    const removed = await deletePremiumChannel(params.id);
    if (!removed) {
      return NextResponse.json({ success: false, error: "Premium channel not found" }, { status: 404 });
    }
    return NextResponse.json({
      success: true,
      message: row?.proxyChannelKey
        ? `Premium channel deleted, and its source was taken off the box. Fixtures were left in place.`
        : "Premium channel deleted. Fixtures were left in place.",
    });
  } catch (error: any) {
    return fail(error, "Failed to delete premium channel");
  }
}
