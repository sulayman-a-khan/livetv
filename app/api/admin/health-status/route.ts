import { NextRequest, NextResponse } from "next/server";
import { getLastHealthCheckTime, getLastFullHealthCheckTime, runAutoHealthCheck } from "@/lib/autoHealthChecker";
import { isAuthorizedAdmin } from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/health-status
 * Returns the auto health checker status (no auth required for status only)
 */
export async function GET() {
  const lastCheck = getLastHealthCheckTime();
  const lastFullCheck = getLastFullHealthCheckTime();
  const isRunning = !!global.__freetv_health_checker_started;

  return NextResponse.json({
    success: true,
    autoHealthChecker: {
      running: isRunning,
      pinnedIntervalMinutes: 5,
      fullIntervalMinutes: 10,
      lastCheckAt: lastCheck || "Not yet run",
      lastFullCheckAt: lastFullCheck || "Not yet run",
    },
  });
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
