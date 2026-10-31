import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isAuthorizedAdmin } from "@/lib/adminAuth";
import {
  deletePremiumChannel,
  listPremiumChannels,
  updatePremiumChannel,
} from "@/lib/premiumStore";
import { boxLogoProblem, validatePremiumChannelInput } from "@/lib/premiumFixtures";
import {
  boxShapeOf,
  changedBoxFields,
  rollbackPatch,
  syncChannelToBox,
} from "@/lib/premiumBoxSync";
import { proxyConfigProblem, proxyKeyForRow, retractPremiumSource } from "@/lib/premiumProxy";

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
 *
 * A channel that plays from a provider is a lane on the box, and the two have to agree: the
 * row is written first and the box second, and a box that refuses the change puts the row
 * back the way it was. A row that claims a stream the box does not hold would play nothing
 * and say otherwise.
 *
 * Three things are refused rather than allowed:
 *
 *   - A provider cannot be taken away from a channel that still has a lane on the box. The
 *     lane belongs to that account, so the row would describe something the box is not
 *     serving.
 *   - A provider cannot be attached to a channel that already has a lane on the box. That
 *     lane belongs to the push route, and two owners of one lane is how a channel ends up
 *     with two streams.
 *   - The box handle of a provider-backed channel cannot be typed. The handle follows the
 *     channel, so it is the one the row's id implies.
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

    const row = (await listPremiumChannels()).find((channel) => channel._id === params.id);
    if (!row) {
      return NextResponse.json({ success: false, error: "Premium channel not found" }, { status: 404 });
    }

    const namesProvider = Object.prototype.hasOwnProperty.call(auth.body, "providerId");
    if (namesProvider) {
      const next = value.providerId ?? "";
      if (!next && row.providerId && row.proxyChannelKey) {
        // A channel leaves its account only once the lane that account held is gone: the box
        // would otherwise keep serving that stream while this row said the channel plays
        // something else — a row that lies about what a viewer is watching.
        return NextResponse.json(
          {
            success: false,
            error:
              "A channel that plays from a provider cannot lose it while it still has a lane on the box — delete the channel instead",
          },
          { status: 400 }
        );
      }
      if (next && !row.providerId && row.proxyChannelKey) {
        return NextResponse.json(
          {
            success: false,
            error:
              "This channel already has a lane on the box — take it off the box before attaching a provider",
          },
          { status: 400 }
        );
      }
    }

    if (
      row.providerId &&
      typeof value.proxyChannelKey === "string" &&
      value.proxyChannelKey !== row.proxyChannelKey
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "The box handle of a channel that plays from a provider follows the channel",
        },
        { status: 400 }
      );
    }

    const nextRow = { ...row, ...value };
    const logoProblem = boxLogoProblem(nextRow.logoUrl, nextRow.providerId);
    if (logoProblem) {
      return NextResponse.json({ success: false, error: logoProblem }, { status: 400 });
    }

    const patch = { ...value };
    // A channel that gains a provider is filed under a handle: the one its own id implies.
    if (nextRow.providerId && !nextRow.proxyChannelKey) {
      patch.proxyChannelKey = proxyKeyForRow(row._id);
    }

    const updated = await updatePremiumChannel(params.id, patch);
    if (!updated) {
      return NextResponse.json({ success: false, error: "Premium channel not found" }, { status: 404 });
    }

    // A row with no provider has no lane on the box. Its stream, if it has one, was pushed
    // there by the push route, which owns that lane.
    if (!updated.providerId) {
      return NextResponse.json({ success: true, channel: updated });
    }

    const before = boxShapeOf(row);
    const after = boxShapeOf(updated);
    const fields = changedBoxFields(before, after);
    if (fields.length === 0) {
      return NextResponse.json({ success: true, channel: updated });
    }

    const outcome = await syncChannelToBox(after, fields);
    if (!outcome.ok) {
      const restored = await updatePremiumChannel(params.id, rollbackPatch(before, fields));
      return NextResponse.json(
        {
          success: false,
          error: restored
            ? `the change was not kept because the stream box refused it: ${outcome.error}`
            : `the stream box refused the change and this row could not be put back: ${outcome.error}`,
          code: outcome.code,
        },
        { status: outcome.status }
      );
    }

    return NextResponse.json({ success: true, channel: updated });
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
      const problem = await proxyConfigProblem();
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
    // The matches stay; the links to this channel do not. Saying so is the difference between an
    // admin who knows the board was left alone and one who has to go and check every card.
    const kept = "The matches that named it were left in place, with their link to it cleared.";
    return NextResponse.json({
      success: true,
      message: row?.proxyChannelKey
        ? `Premium channel deleted, and its source was taken off the box. ${kept}`
        : `Premium channel deleted. ${kept}`,
    });
  } catch (error: any) {
    return fail(error, "Failed to delete premium channel");
  }
}
