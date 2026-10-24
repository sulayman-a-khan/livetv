import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import { connectToDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/premium/session
 *
 * The premium & fixtures panel asks here whether its key is valid. It exists so
 * this admin surface never has to call a Direct HLS route (`/api/admin/stats`)
 * just to sign in: the two panels share only the secret key and the auth helper,
 * never an endpoint.
 *
 * It reports which store the tier will use, so an admin run always leaves the
 * visible evidence of whether it wrote to MongoDB or to the local file.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isAuthorizedAdmin(req)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }
    const conn = await connectToDatabase();
    return NextResponse.json({
      success: true,
      dbMode: conn ? "mongodb" : "local",
    });
  } catch (error: any) {
    console.error("GET /api/admin/premium/session error:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "Failed to verify premium admin key" },
      { status: 500 }
    );
  }
}
