import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import { revokeBox } from "@/lib/boxRegistry";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/proxy/boxes/[id]/revoke
 *
 * Withdraw a box.
 *
 * One row, one call: the site stops deriving tokens for that box, refuses its
 * registrations, and stops talking to it. The box keeps whatever it holds, and it is worth
 * nothing to the site now — a credential the site no longer derives is not a credential the
 * site will accept.
 *
 * The row is not deleted, because the record that a box was admitted and later withdrawn
 * is worth keeping. A fresh enrollment is how a box comes back, and only an admin can issue
 * one.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    if (!isAuthorizedAdmin(req)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401, headers: { "cache-control": "no-store" } }
      );
    }

    const result = await revokeBox(params.id);
    if (!result.ok) {
      const status = result.reason === "invalid" ? 400 : result.reason === "refused" ? 404 : 503;
      return NextResponse.json(
        { success: false, error: result.error },
        { status, headers: { "cache-control": "no-store" } }
      );
    }

    return NextResponse.json(
      { success: true, boxId: result.boxId, state: "revoked" },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error: any) {
    console.error("POST /api/admin/proxy/boxes/[id]/revoke error:", error?.name || "failed");
    return NextResponse.json(
      { success: false, error: "Failed to revoke the box" },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}
