import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isAuthorizedAdmin } from "@/lib/adminAuth";
import { createEnrollment, listBoxes } from "@/lib/boxRegistry";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
    { status: 401 }
  );
}

/**
 * GET /api/admin/proxy/boxes
 *
 * Every box this site knows, and what it thinks of each one: enrolled, pending, revoked.
 *
 * The list is for the operator's own panel, and it holds nothing secret — a box's name, its
 * address and the state of its enrollment. The tokens a box holds are never in it: they are
 * derived, not stored, so there is nothing here to leak.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isAuthorizedAdmin(req)) return unauthorized();
    const boxes = await listBoxes();
    return NextResponse.json(
      { success: true, count: boxes.length, boxes },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error: any) {
    console.error("GET /api/admin/proxy/boxes error:", error?.name || "failed");
    return NextResponse.json(
      { success: false, error: "Failed to load the box list" },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}

/**
 * POST /api/admin/proxy/boxes
 *
 * Admit a box. The body is `{ boxId }` — the name the box will know itself by.
 *
 * The answer carries a one-time enrollment code, and it is shown **once**. The site keeps
 * only the code's hash, so the code cannot be recovered from the site's database and
 * cannot be replayed once it has been spent. Hand it to the operator, who puts it in the
 * box's folder; the box trades it for its own credentials and the code is worthless
 * afterwards.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await authorizeAdminRequest(req);
    if (!auth.ok) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    const boxId = typeof auth.body?.boxId === "string" ? auth.body.boxId.trim() : "";
    const result = await createEnrollment(boxId);
    if (!result.ok) {
      const status = result.reason === "invalid" ? 400 : 503;
      return NextResponse.json(
        { success: false, error: result.error },
        { status, headers: { "cache-control": "no-store" } }
      );
    }

    return NextResponse.json(
      {
        success: true,
        boxId: result.enrollment.boxId,
        enrollmentCode: result.enrollment.code,
        expiresAt: result.enrollment.expiresAt,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error: any) {
    console.error("POST /api/admin/proxy/boxes error:", error?.name || "failed");
    return NextResponse.json(
      { success: false, error: "Failed to issue the enrollment" },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}
