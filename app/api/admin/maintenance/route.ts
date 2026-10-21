import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest } from "@/lib/adminAuth";
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
    const auth = await authorizeAdminRequest(req);
    if (!auth.ok) {
      return NextResponse.json(
        { success: false, error: auth.error },
        { status: auth.status }
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
