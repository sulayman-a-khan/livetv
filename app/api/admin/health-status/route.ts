import { NextRequest, NextResponse } from "next/server";
import { getLastHealthCheckTime, getLastFullHealthCheckTime, runAutoHealthCheck } from "@/lib/autoHealthChecker";
import { isAuthorizedAdmin } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/health-status
 * Returns the auto health checker schedule. Admin-gated like the rest of
 * /api/admin/*: even a "harmless" status reply tells an outsider how often the
 * catalogue is probed and when it last ran.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedAdmin(req)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const lastCheck = getLastHealthCheckTime();
  const lastFullCheck = getLastFullHealthCheckTime();
  const isRunning = !!global.__freetv_health_checker_started;

  return NextResponse.json(
    {
      success: true,
      autoHealthChecker: {
        running: isRunning,
        /** One pass over the catalogue every 6 hours; pinned channels are probed
         *  first inside each pass, and a skipped or failed pass retries in 15 min. */
        intervalMinutes: 360,
        lastCheckAt: lastCheck || "Not yet run",
        lastFullCheckAt: lastFullCheck || "Not yet run",
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * POST /api/admin/health-status
 * Manually trigger an immediate health check (requires admin key)
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    if (!isAuthorizedAdmin(req, body.secretKey)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    console.log("[ManualTrigger] Admin triggered immediate health check...");
    const result = await runAutoHealthCheck();

    return NextResponse.json({
      success: true,
      message: "Manual health check completed",
      result,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Health check failed" },
      { status: 500 }
    );
  }
}
