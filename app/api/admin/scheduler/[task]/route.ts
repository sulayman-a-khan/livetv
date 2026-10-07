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
 *   GET /api/admin/scheduler/<category batch>   the pinned channels of a few
 *                                               categories, at each UTC time in
 *                                               `lib/healthSchedule.ts`
 *   GET /api/admin/scheduler/health             every pinned channel, plus the
 *                                               whole-catalogue maintenance pass
 *   GET /api/admin/scheduler/sync               once a day, at the fixed hour
 *
 * The task is a path segment, not a query string: Vercel cron paths must be
 * static, and every job expression in `vercel.json` runs once per day.
 *
 * Safety properties that matter here:
 *   - Every health pass is pinned-only: a batch with no pinned channels probes
 *     nothing, and never widens to the unpinned catalogue.
 *   - Overlapping runs are impossible: `runAutoHealthCheck` and
 *     `runPlaylistMonitorTick` both take a process flag and a MongoDB `_locks`
 *     document, so a second cron landing on a warm instance is a no-op.
 *   - Duplicate invocations are harmless for the same reason, and a missed
 *     invocation is caught up by the next pass, which works off "what is oldest"
 *     rather than "what fired".
 *   - Each health run is time-budgeted. Links are picked least-recently-checked
 *     first, so a truncated pass continues where it stopped instead of
 *     restarting, and the batch still rotates within the day.
 *   - Nothing here decides visibility; it only refreshes the health state that
 *     the public API gates on.
 */
import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedAdmin, isAuthorizedByBearer } from "@/lib/adminAuth";
import { runAutoHealthCheck, getLastFullHealthCheckTime } from "@/lib/autoHealthChecker";
import { runPlaylistMonitorTick, getPlaylistMonitorStatus } from "@/lib/playlistMonitor";
import { HEALTH_BATCHES, getHealthBatch } from "@/lib/healthSchedule";

export const dynamic = "force-dynamic";
/** Vercel kills the function at this wall-clock limit; the budget stays under it. */
export const maxDuration = 60;

/** Leave enough room to answer the request after the last batch. */
const HEALTH_BUDGET_MS = 45_000;
/** A manual pass is only skipped if a recent one already covered the window. */
const HEALTH_DUE_MS = 6 * 60 * 60 * 1000;

const STATIC_TASKS = ["health", "sync", "all"] as const;
/** `health`, `sync`, `all`, plus one path per category batch. */
const TASKS: readonly string[] = [...STATIC_TASKS, ...HEALTH_BATCHES.map((b) => b.task)];

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

  const task = String(rawTask || "").toLowerCase().trim();
  if (!TASKS.includes(task)) {
    return NextResponse.json(
      {
        success: false,
        error: `Unknown task "${task}" — use health, sync, all or one of ${HEALTH_BATCHES.map(
          (b) => b.task
        ).join(", ")}`,
      },
      { status: 400, ...responseInit }
    );
  }

  const ran: Record<string, unknown> = {};

  try {
    const batch = getHealthBatch(task);
    const wantsHealth = batch !== undefined || task === "health" || task === "all";

    if (wantsHealth) {
      // A batch pass covers its own categories; `health`/`all` cover every
      // pinned channel and are the only runs that follow up with maintenance.
      const sweep = batch ? batch.sweep === true : true;
      const last = getLastFullHealthCheckTime();
      const overdue = !last || Date.now() - new Date(last).getTime() >= HEALTH_DUE_MS;
      const batchIsDue = batch !== undefined && !batch.sweep;

      if (force || scheduledInvocation(req) || overdue || batchIsDue) {
        const result = await runAutoHealthCheck(
          batch ? batch.task : "full",
          {
            categories: batch ? batch.categories : null,
            deadlineMs: HEALTH_BUDGET_MS,
            maintenanceAfter: sweep,
          }
        );
        ran[batch ? batch.task : "health"] = { skipped: false, ...result };
      } else {
        // A long-lived server's own timer already covered this window.
        ran[batch ? batch.task : "health"] = {
          skipped: true,
          reason: "a full pass ran recently",
          lastFullCheckAt: last,
        };
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
