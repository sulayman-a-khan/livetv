import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isAuthorizedAdmin } from "@/lib/adminAuth";
import { deleteFixture, getFixture, updateFixture } from "@/lib/fixtureStore";
import { checkFixtureRefs, describeUnknownFixtureRefs } from "@/lib/fixtureSources";
import { validateFixtureInput } from "@/lib/fixtures";

export const dynamic = "force-dynamic";

function fail(error: any, fallback: string) {
  const status = typeof error?.status === "number" ? error.status : 500;
  console.error("PATCH/DELETE /api/admin/fixtures/[id] error:", error);
  return NextResponse.json({ success: false, error: error?.message || fallback }, { status });
}

/**
 * PATCH /api/admin/fixtures/[id]
 * Partial edit: publish, retract, retime or rename a match. Only the sent keys
 * change, so publishing a card cannot reset its teams.
 *
 * The stored card is read first and handed to the validator as what the card already
 * carries. A link it has always held survives the edit; a link the admin is adding now
 * has to name a catalogue channel.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await authorizeAdminRequest(req);
    if (!auth.ok) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    const stored = await getFixture(params.id);
    if (!stored) {
      return NextResponse.json({ success: false, error: "Fixture not found" }, { status: 404 });
    }

    const { value, errors } = validateFixtureInput(auth.body, false, stored.channels);
    if (errors.length > 0) {
      return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 400 });
    }
    if (Object.keys(value).length === 0) {
      return NextResponse.json(
        { success: false, error: "Nothing to update — send at least one field" },
        { status: 400 }
      );
    }

    if (value.channels) {
      // A link the card already carried and that no longer names a channel is a stale link, not
      // a mistake: refusing the whole save would lock the admin out of the very card they are
      // trying to fix, and keeping it is what lets a channel that comes back repair itself.
      // A link the admin is adding now still has to name a channel.
      const { refused } = await checkFixtureRefs(value.channels, stored.channels);
      if (refused.length > 0) {
        return NextResponse.json(
          { success: false, error: describeUnknownFixtureRefs(refused) },
          { status: 400 }
        );
      }
    }

    const fixture = await updateFixture(params.id, value);
    if (!fixture) {
      return NextResponse.json({ success: false, error: "Fixture not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, fixture });
  } catch (error: any) {
    return fail(error, "Failed to update fixture");
  }
}

/**
 * DELETE /api/admin/fixtures/[id]
 * Removes the match from the board. The channels it pointed at are untouched.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    if (!isAuthorizedAdmin(req)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const removed = await deleteFixture(params.id);
    if (!removed) {
      return NextResponse.json({ success: false, error: "Fixture not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, message: "Fixture deleted." });
  } catch (error: any) {
    return fail(error, "Failed to delete fixture");
  }
}
