import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import { runMaintenance } from "@/lib/maintenanceRunner";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/maintenance
 * Runs the full catalogue pass on demand:
 *   normalize names → merge duplicates → purge test links → fastest server first.
 *
 * The same routine runs automatically after every M3U ingest and after every
 * health check; this endpoint exists for the admin "Run cleanup" button.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    if (!isAuthorizedAdmin(req, body.secretKey)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const report = await runMaintenance();
    return NextResponse.json({ success: true, report });
  } catch (error: any) {
    console.error("POST /api/admin/maintenance error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Maintenance run failed" },
      { status: 500 }
    );
  }
}
