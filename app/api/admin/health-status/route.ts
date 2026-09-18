import { NextResponse } from "next/server";
import { getLastHealthCheckTime, runAutoHealthCheck } from "@/lib/autoHealthChecker";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/health-status
 * Returns the auto health checker status (no auth required for status only)
 */
export async function GET() {
  const lastCheck = getLastHealthCheckTime();
  const isRunning = !!global.__freetv_health_checker_started;

  return NextResponse.json({
    success: true,
    autoHealthChecker: {
      running: isRunning,
      intervalMinutes: 20,
      lastCheckAt: lastCheck || "Not yet run",
    },
  });
}

/**
 * POST /api/admin/health-status
 * Manually trigger an immediate health check (requires admin key)
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const authHeader = req.headers.get("x-admin-secret");
    const rawSecret = authHeader || body.secretKey || "";
    const secretKey = rawSecret.trim();
    const expectedSecret = (process.env.ADMIN_SECRET_KEY || "supersecret123").trim();

    if (!secretKey || secretKey !== expectedSecret) {
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
