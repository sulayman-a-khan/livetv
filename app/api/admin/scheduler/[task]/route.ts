/**
 * Scheduled maintenance trigger — the automation entry point for hosts that do
 * not keep background timers alive.
 * ============================================================================
 * `instrumentation.ts` starts the health checker and the playlist monitor as
 * in-process timers, which works on a long-lived server but not on Vercel:
 * a function instance is frozen the moment its request ends, so those intervals
 * never fire again. Vercel Cron calls these URLs instead, doing the same two
 * jobs with the same locks, in the same order:
 *
 *   GET /api/admin/scheduler/health   four times a day (every ~6 hours)
 *   GET /api/admin/scheduler/sync     once a day, at the scheduled hour
 *
 * The task is a path segment, not a query string: Vercel documents dynamic
 * routes as cron-eligible, and every job expression here runs once per day,
 * which is the most frequent schedule the Hobby plan accepts.
 *
 * Safety properties that matter here:
 *   - Overlapping runs are impossible: `runAutoHealthCheck` and
 *     `runPlaylistMonitorTick` both take a process flag and a MongoDB `_locks`
 *     document, so a second cron landing on a warm instance is a no-op.
 *   - Duplicate invocations are harmless for the same reason, and a missed
 *     invocation is caught up by the next pass, which works off "what is oldest"
 *     rather than "what fired".
 *   - Each health run is time-budgeted. Links are picked least-recently-checked
 *     first, so a truncated pass continues where it stopped instead of
 *     restarting, and the whole catalogue still rotates within the day.
 *   - Nothing here decides visibility; it only refreshes the health state that
 *     the public API gates on.
 */
import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedAdmin, isAuthorizedByBearer } from "@/lib/adminAuth";
import { runAutoHealthCheck, getLastFullHealthCheckTime } from "@/lib/autoHealthChecker";
import { runPlaylistMonitorTick, getPlaylistMonitorStatus } from "@/lib/playlistMonitor";

export const dynamic = "force-dynamic";
/** Vercel kills the function at this wall-clock limit; the budget stays under it. */
export const maxDuration = 60;

/** Leave enough room to answer the request after the last batch. */
const HEALTH_BUDGET_MS = 45_000;
/** A manual pass is only skipped if a recent one already covered the window. */
const HEALTH_DUE_MS = 6 * 60 * 60 * 1000;

const TASKS = ["health", "sync", "all"] as const;
type Task = (typeof TASKS)[number];

function authorized(req: NextRequest): boolean {
  // Vercel's scheduler sends `Authorization: Bearer $CRON_SECRET`; the dashboard
  // uses the admin secret header, so the same URL serves both.
  return isAuthorizedByBearer(req, "CRON_SECRET") || isAuthorizedAdmin(req);
}

/**
 * True for Vercel's own invocations. On Hobby a job can land anywhere inside its
 * hour, so two consecutive health passes can sit under 6 hours apart; that must
 * not cancel one of them. Locks already stop real overlaps.
 */
function scheduledInvocation(req: NextRequest): boolean {
  return (
    req.headers.get("x-vercel-cron-schedule") !== null ||
    (req.headers.get("user-agent") || "").includes("vercel-cron")
  );
}

export async function GET(req: NextRequest, { params }: { params: { task: string } }) {
  return handle(req, params.task, false);
}

export async function POST(req: NextRequest, { params }: { params: { task: string } }) {
  const body = await req.json().catch(() => ({}));
  return handle(req, params.task, body?.force === true || String(body?.force) === "1");
}

async function handle(
  req: NextRequest,
  rawTask: string,
  force: boolean
): Promise<NextResponse> {
  const responseInit = { headers: { "Cache-Control": "no-store" } };

  if (!authorized(req)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized: set CRON_SECRET or send x-admin-secret" },
      { status: 401, ...responseInit }
    );
  }

  const task = String(rawTask || "").toLowerCase() as Task;
  if (!TASKS.includes(task)) {
    return NextResponse.json(
      { success: false, error: `Unknown task "${task}" — use health, sync or all` },
      { status: 400, ...responseInit }
    );
  }

  const ran: Record<string, unknown> = {};

  try {
    if (task === "health" || task === "all") {
      const last = getLastFullHealthCheckTime();
      const overdue = !last || Date.now() - new Date(last).getTime() >= HEALTH_DUE_MS;
      if (force || scheduledInvocation(req) || overdue) {
        const result = await runAutoHealthCheck("full", { deadlineMs: HEALTH_BUDGET_MS });
        ran.health = { skipped: false, ...result };
      } else {
        // A long-lived server's own timer already covered this window.
        ran.health = { skipped: true, reason: "a full pass ran recently", lastFullCheckAt: last };
      }
    }

    if (task === "sync" || task === "all") {
      // The monitor works out what is due: the daily slot, plus any source whose
      // last fetch failed and has waited out its retry window.
      const result = await runPlaylistMonitorTick(false);
      ran.playlist = {
        checked: result.checked,
        changed: result.changed,
        failed: result.failed,
        skippedLocked: result.skippedLocked,
        sources: result.summaries.map((s) => ({
          name: s.sourceName,
          status: s.status,
          entries: s.entriesParsed,
          probes: s.probesRun,
          error: s.error || undefined,
        })),
      };
    }
  } catch (err: any) {
    console.error(`GET /api/admin/scheduler/${task} error:`, err);
    return NextResponse.json(
      { success: false, error: err?.message || "Scheduler run failed", ran },
      { status: 500, ...responseInit }
    );
  }

  return NextResponse.json(
    { success: true, task, force, ran, monitor: getPlaylistMonitorStatus() },
    responseInit
  );
}
