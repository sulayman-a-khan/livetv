/**
 * Scheduled maintenance trigger — the automation entry point for hosts that do
 * not keep background timers alive.
 * ============================================================================
 * `instrumentation.ts` starts the playlist monitor as an in-process timer, which
 * works on a long-lived server but not on Vercel: a function instance is frozen
 * the moment its request ends, so that interval never fires again. Vercel Cron
 * calls this URL instead, doing the same job with the same lock:
 *
 *   GET /api/admin/scheduler/sync   once a day, at the fixed hour, fetching every
 *                                   active M3U source that is due
 *
 * The task is a path segment, not a query string: Vercel cron paths must be
 * static, and every job expression in `vercel.json` runs once per day.
 *
 * Two project settings decide whether any of this ever runs. Vercel invokes the
 * path on the production URL and does not follow redirects, so Deployment
 * Protection answering with a 3xx to SSO ends the job as a silent success; and
 * the `Authorization: Bearer $CRON_SECRET` header is only sent when that variable
 * exists in the project. Either one missing means no scheduled pass at all — the
 * per-source `lastSyncAt` / `nextCheckAt` on the playlist panel is what proves it.
 *
 * Health checking is deliberately NOT here. It runs exclusively through the
 * GitHub Actions pass (`scripts/health-check-runner.mjs`), which drives
 * `POST /api/admin/health-check` in bounded batches and keeps its own persisted
 * run record — see that route and `lib/healthRunState.ts`.
 */
import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedAdmin, isAuthorizedByBearer } from "@/lib/adminAuth";
import { runPlaylistMonitorTick, getPlaylistMonitorStatus } from "@/lib/playlistMonitor";
import { recordSchedulerHeartbeat } from "@/lib/settings";

export const dynamic = "force-dynamic";
/** Vercel kills the function at this wall-clock limit; the budget stays under it. */
export const maxDuration = 60;

/** The only scheduled job left in this entry point. */
const TASKS: readonly string[] = ["sync"];

function authorized(req: NextRequest): boolean {
  // Vercel's scheduler sends `Authorization: Bearer $CRON_SECRET`; the dashboard
  // uses the admin secret header, so the same URL serves both.
  return isAuthorizedByBearer(req, "CRON_SECRET") || isAuthorizedAdmin(req);
}

/**
 * True for Vercel's own invocations, so the heartbeat can tell a scheduled
 * arrival from an admin pressing a button. On Hobby a job can land anywhere
 * inside its hour.
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
        error: `Unknown task "${task}" — the only scheduled task is: ${TASKS.join(", ")}`,
      },
      { status: 400, ...responseInit }
    );
  }

  // Stamp arrival before doing any work: the run may be cut off by the wall
  // clock, but "the scheduler reached us at HH:MM" still stands.
  await recordSchedulerHeartbeat(task, scheduledInvocation(req));

  const ran: Record<string, unknown> = {};

  try {
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
