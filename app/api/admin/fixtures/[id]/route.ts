import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isAuthorizedAdmin } from "@/lib/adminAuth";
import { deleteFixture, premiumChannelExists, updateFixture } from "@/lib/premiumStore";
import { validateFixtureInput } from "@/lib/premiumFixtures";

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
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await authorizeAdminRequest(req);
    if (!auth.ok) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    const { value, errors } = validateFixtureInput(auth.body, false);
    if (errors.length > 0) {
      return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 400 });
    }
    if (Object.keys(value).length === 0) {
      return NextResponse.json(
        { success: false, error: "Nothing to update — send at least one field" },
        { status: 400 }
      );
    }

    if (value.premiumChannelId && !(await premiumChannelExists(value.premiumChannelId))) {
      return NextResponse.json(
        { success: false, error: "Linked channel is not in the premium list" },
        { status: 400 }
      );
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
 * Removes the match from the board. The premium channel it pointed at is untouched.
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
