import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import { deleteSource, updateSource, validateSourceInput } from "@/lib/playlistSources";

export const dynamic = "force-dynamic";

function fail(error: any, fallback: string) {
  const status = typeof error?.status === "number" ? error.status : 500;
  console.error("PATCH/DELETE /api/admin/playlist-sources/[id] error:", error);
  return NextResponse.json({ success: false, error: error?.message || fallback }, { status });
}

/**
 * PATCH /api/admin/playlist-sources/[id]
 * Partial edit: rename, change the playlist URL, switch the type, or enable /
 * disable the source and its daily monitoring. Only the sent keys are touched.
 *
 * Disabling a source leaves every channel and stream link it provided exactly as
 * it is — nothing is silently reassigned or deleted.
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

    const { value, errors } = validateSourceInput(body, false);
    if (errors.length > 0) {
      return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 400 });
    }
    if (Object.keys(value).length === 0) {
      return NextResponse.json(
        { success: false, error: "Nothing to update — send at least one field" },
        { status: 400 }
      );
    }

    const source = await updateSource(params.id, value);
    return NextResponse.json({ success: true, source });
  } catch (error: any) {
    return fail(error, "Failed to update playlist source");
  }
}

/**
 * DELETE /api/admin/playlist-sources/[id]
 * Removes the source and its playlist entry rows. Channels and links stay in the
 * catalogue; they are library data, not part of the source configuration.
 */
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

    const result = await deleteSource(params.id);
    return NextResponse.json({
      success: true,
      message: `Playlist source deleted (${result.entriesRemoved} tracked entr${
        result.entriesRemoved === 1 ? "y" : "ies"
      } removed; channels and stream links were left untouched)`,
    });
  } catch (error: any) {
    return fail(error, "Failed to delete playlist source");
  }
}
