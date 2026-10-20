import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import { getAutomatedHealthStatus } from "@/lib/healthRunState";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/health-status
 * The externally driven health pass — the one GitHub Actions runs — read from
 * the run record the server keeps in the database. Admin-gated like the rest of
 * /api/admin/*: even a "harmless" status reply tells an outsider how often the
 * catalogue is probed and when it last ran.
 *
 * This is the whole schedule now. Nothing probes on a server-side timer and no
 * Vercel cron reaches the health engine, so there is no in-process interval and
 * no separate cron heartbeat to report: a pass is either recorded here or it
 * did not happen. The server — not a browser tab and not a wall clock — owns
 * the cursor, the counters and the completion report.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedAdmin(req)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const automated = await getAutomatedHealthStatus();

    return NextResponse.json(
      { success: true, automatedHealthCheck: automated },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    // A DB hiccup must still answer JSON: the dashboard parses this response,
    // and an unhandled throw would surface as a non-JSON 500 it chokes on.
    console.error("[health-status] failed to read automated health status", err);
    return NextResponse.json(
      { success: false, error: "Failed to read health status" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
