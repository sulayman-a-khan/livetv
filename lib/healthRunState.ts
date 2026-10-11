/**
 * Persisted state for the externally driven health pass (GitHub Actions).
 *
 * The probing itself has not moved: one bounded batch of
 * `POST /api/admin/health-check` per request — the exact call the admin
 * dashboard already loops over until nothing is due. What did not exist was a
 * record of the *pass*. The dashboard kept its counters in a browser tab, so
 * closing the tab lost the run, an interrupted pass left no trace, and nothing
 * could say whether every eligible link actually got a verdict.
 *
 * Two documents in the existing `settings` collection carry that, on the same
 * keyed-doc convention as `schedulerHeartbeat` (see `lib/settings.ts`):
 *   healthRun        — the pass in progress; temporary, cleared on completion
 *   healthLastReport — the most recent pass that genuinely finished
 *
 * No new collection and no history table: a pass is only ever identified by its
 * cursor (`startedAt`), and a link is due for that pass while
 * `lastCheckedAt < startedAt`. That is the same rule the batch endpoint already
 * uses, so resuming needs no extra writes and an untested link can never be
 * mistaken for a tested one.
 */
import { connectToDatabase } from "@/lib/db";
import Setting from "@/models/Setting";
import crypto from "crypto";

const RUN_KEY = "healthRun";
const REPORT_KEY = "healthLastReport";

export type HealthRunTrigger = "github" | "admin";

/**
 * `stalled` is the honest middle ground between "running" and "failed": the
 * runner stopped answering, so links it never reached are still due. The next
 * scheduled call resumes that pass from its saved cursor rather than starting
 * over, and the untested links stay untested until they are actually probed.
 */
export type HealthRunState = "idle" | "running" | "stalled" | "overdue" | "completed";

export interface HealthRunProgress {
  runId: string;
  trigger: HealthRunTrigger;
  /** This pass's cursor: every batch asks for links checked before this instant. */
  startedAt: string;
  /** Last batch received. Goes stale quickly, which is how a dead runner shows up. */
  updatedAt: string;
  /** Links that were due when the pass began, plus any added since. */
  eligible: number;
  /** Links with a saved verdict. The only count that means "tested". */
  completed: number;
  remaining: number;
  /** Tested links whose verdict is `broken` — visible failures, not missing data. */
  failures: number;
  /** Links probed whose verdict could not be saved, so they stay due. */
  inconclusive: number;
  active: number;
  degraded: number;
  unplayable: number;
  notDelivering: number;
  batches: number;
}

export interface HealthRunReport extends HealthRunProgress {
  completedAt: string;
  durationMs: number;
}

/** One batch's verdicts, as the batch endpoint measured them. */
export interface HealthBatchOutcome {
  checked: number;
  active: number;
  degraded: number;
  broken: number;
  unplayable: number;
  notDelivering: number;
  inconclusive: number;
}

/**
 * The GitHub schedule. Every slot sits at minute 37, four hours apart, which is
 * the only cadence that clears all six existing Vercel health lines (03:00,
 * 09:00/09:30, 15:00/15:30, 21:00/21:30), the 20:00 playlist sync and the
 * hourly :15 delivery re-checks. Nothing here changes those jobs — this is the
 * offset chosen so the two schedulers never land in the same minute.
 */
export const HEALTH_RUN_CRON_UTC = "37 2,6,10,14,18,22 * * *";
export const HEALTH_RUN_CRON_LOCAL =
  "08:37, 12:37, 16:37, 20:37, 00:37 and 04:37 (Bangladesh, UTC+6)";
const CRON_MINUTE = 37;
const CRON_HOURS_UTC = [2, 6, 10, 14, 18, 22];

/** A batch takes at most 60s, so 12 silent minutes means the runner is gone. */
const ACTIVE_WINDOW_MS = 12 * 60 * 1000;
/** Beyond this an abandoned cursor no longer describes the catalogue: start fresh. */
const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000;
/** A slot that just passed is not yet a miss. */
const OVERDUE_GRACE_MS = 25 * 60 * 1000;

/** Kept for in-memory mode, and for an instance that cannot reach Atlas. */
let localRun: HealthRunProgress | null = null;
let localReport: HealthRunReport | null = null;

function ageMsOf(iso: string | undefined, now: number): number {
  const at = Date.parse(iso || "");
  return Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
}

async function readStored<T>(key: string, local: T | null): Promise<T | null> {
  try {
    const conn = await connectToDatabase();
    if (!conn) return local;
    const doc = await Setting.findOne({ key }).lean();
    if (!doc || typeof doc.value !== "string") return null;
    return JSON.parse(doc.value) as T;
  } catch (err) {
    console.warn(`[healthRun] read ${key} failed:`, (err as Error)?.name || "unknown");
    return local;
  }
}

async function writeStored(key: string, value: unknown): Promise<void> {
  try {
    const conn = await connectToDatabase();
    if (!conn) return;
    await Setting.updateOne(
      { key },
      { $set: { key, value: JSON.stringify(value), updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.warn(`[healthRun] write ${key} failed:`, (err as Error)?.name || "unknown");
  }
}

async function removeStored(key: string): Promise<void> {
  try {
    const conn = await connectToDatabase();
    if (!conn) return;
    await Setting.deleteOne({ key });
  } catch (err) {
    console.warn(`[healthRun] clear ${key} failed:`, (err as Error)?.name || "unknown");
  }
}

/** The eight UTC half-day slots around `now`, so next/last lookups are arithmetic. */
function scheduledSlots(now: Date): Date[] {
  const slots: Date[] = [];
  for (let day = -2; day <= 2; day++) {
    for (const hour of CRON_HOURS_UTC) {
      slots.push(
        new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day, hour, CRON_MINUTE)
        )
      );
    }
  }
  return slots.sort((a, b) => a.getTime() - b.getTime());
}

export function nextScheduledSlotAt(now: Date = new Date()): Date {
  const t = now.getTime();
  return scheduledSlots(now).find((slot) => slot.getTime() > t) ?? new Date(t + 4 * 3_600_000);
}

export function previousScheduledSlotAt(now: Date = new Date()): Date {
  const t = now.getTime();
  const past = scheduledSlots(now).filter((slot) => slot.getTime() <= t);
  return past[past.length - 1] ?? new Date(t - 4 * 3_600_000);
}

function seedProgress(
  trigger: HealthRunTrigger,
  eligible: number,
  now: Date
): HealthRunProgress {
  const iso = now.toISOString();
  const due = Math.max(0, Math.round(Number.isFinite(eligible) ? eligible : 0));
  return {
    runId: crypto.randomUUID(),
    trigger,
    startedAt: iso,
    updatedAt: iso,
    eligible: due,
    completed: 0,
    remaining: due,
    failures: 0,
    inconclusive: 0,
    active: 0,
    degraded: 0,
    unplayable: 0,
    notDelivering: 0,
    batches: 0,
  };
}

export type BeginRunResult = {
  /**
   * `active` refuses the request: a pass is mid-flight right now, and a second
   * concurrent caller would grab the same 12 least-recently-checked links and
   * add the same verdicts twice.
   */
  status: "started" | "resumed" | "replaced" | "active";
  progress: HealthRunProgress;
};

/**
 * Open the pass this batch belongs to, or report the one already open.
 *
 * A caller that repeats its own cursor resumes its own pass. A caller that asks
 * for a fresh pass while an abandoned one exists inherits that cursor and its
 * counters, so an interrupted pass finishes instead of restarting — which is
 * what keeps "completed" meaning "every link due at the start got a verdict".
 */
export async function beginHealthRun(input: {
  trigger: HealthRunTrigger;
  requestedCursor: string | null;
  eligible: number;
  now: Date;
}): Promise<BeginRunResult> {
  const nowMs = input.now.getTime();
  const existing = await readStored<HealthRunProgress>(RUN_KEY, localRun);

  if (existing?.startedAt) {
    if (input.requestedCursor && input.requestedCursor === existing.startedAt) {
      localRun = existing;
      return { status: "resumed", progress: existing };
    }
    if (ageMsOf(existing.updatedAt || existing.startedAt, nowMs) < ACTIVE_WINDOW_MS) {
      localRun = existing;
      return { status: "active", progress: existing };
    }
    if (
      ageMsOf(existing.startedAt, nowMs) <= RESUME_WINDOW_MS &&
      (existing.remaining ?? 0) > 0
    ) {
      localRun = existing;
      return { status: "resumed", progress: existing };
    }

    // Nothing live, nothing worth resuming: take over the abandoned document.
    const seed = seedProgress(input.trigger, input.eligible, input.now);
    localRun = seed;
    await writeStored(RUN_KEY, seed);
    return { status: "replaced", progress: seed };
  }

  const seed = seedProgress(input.trigger, input.eligible, input.now);
  try {
    const conn = await connectToDatabase();
    if (conn) {
      // `$setOnInsert` rather than `$set`: two fresh passes opened in the same
      // instant cannot both seed the document, so the loser adopts the winner's
      // cursor and continues it instead of running a second, double-counted one.
      await Setting.updateOne(
        { key: RUN_KEY },
        {
          $setOnInsert: {
            key: RUN_KEY,
            value: JSON.stringify(seed),
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
      const stored = await readStored<HealthRunProgress>(RUN_KEY, seed);
      if (stored && stored.runId !== seed.runId) {
        localRun = stored;
        return { status: "resumed", progress: stored };
      }
    }
  } catch (err) {
    console.warn("[healthRun] seed failed:", (err as Error)?.name || "unknown");
  }
  localRun = seed;
  return { status: "started", progress: seed };
}

/** Fold one batch into the pass. Pure, so the maths is checkable in isolation. */
export function applyBatchOutcome(
  progress: HealthRunProgress,
  outcome: HealthBatchOutcome,
  remaining: number,
  now: Date
): HealthRunProgress {
  const due = Math.max(0, Math.round(Number.isFinite(remaining) ? remaining : 0));
  return {
    ...progress,
    // Links added mid-run widen the pass; nothing ever narrows it below what
    // has already been tested plus what is still due.
    eligible: Math.max(progress.eligible, progress.completed + outcome.checked + due),
    completed: progress.completed + outcome.checked,
    remaining: due,
    failures: progress.failures + outcome.broken,
    inconclusive: progress.inconclusive + outcome.inconclusive,
    active: progress.active + outcome.active,
    degraded: progress.degraded + outcome.degraded,
    unplayable: progress.unplayable + outcome.unplayable,
    notDelivering: progress.notDelivering + outcome.notDelivering,
    batches: progress.batches + 1,
    updatedAt: now.toISOString(),
  };
}

export async function saveHealthRun(progress: HealthRunProgress): Promise<void> {
  localRun = progress;
  await writeStored(RUN_KEY, progress);
}

/**
 * Only a pass that reached zero remaining links produces a report, and writing
 * it clears the temporary progress document. A runner that exits early therefore
 * cannot make itself look finished — the previous completed report stays exactly
 * where it was, and the abandoned pass shows as stalled instead.
 */
export async function completeHealthRun(
  progress: HealthRunProgress,
  now: Date
): Promise<HealthRunReport> {
  const startedAt = Date.parse(progress.startedAt);
  const report: HealthRunReport = {
    ...progress,
    remaining: 0,
    completedAt: now.toISOString(),
    durationMs: Number.isFinite(startedAt) ? Math.max(0, now.getTime() - startedAt) : 0,
  };
  localRun = null;
  localReport = report;
  await writeStored(REPORT_KEY, report);
  await removeStored(RUN_KEY);
  return report;
}

export interface AutomatedHealthStatus {
  state: HealthRunState;
  run: HealthRunProgress | null;
  report: HealthRunReport | null;
  /** The next slot the GitHub schedule fires, in server time. */
  nextScheduledAt: string;
  lastScheduledSlotAt: string;
  cronUtc: string;
  cronLocal: string;
  /** True once at least one pass has been seen, so "no report" has a meaning. */
  everSeen: boolean;
}

function deriveState(
  nowMs: number,
  run: HealthRunProgress | null,
  report: HealthRunReport | null
): HealthRunState {
  if (run?.startedAt) {
    if (ageMsOf(run.updatedAt || run.startedAt, nowMs) < ACTIVE_WINDOW_MS) return "running";
    if (ageMsOf(run.startedAt, nowMs) <= RESUME_WINDOW_MS) return "stalled";
  }
  if (!report?.completedAt) {
    // Nothing has ever reached the app. "Overdue" would be a guess about whether
    // the GitHub schedule has been switched on, so this says idle and means it.
    return "idle";
  }
  const slot = previousScheduledSlotAt(new Date(nowMs)).getTime();
  if (Date.parse(report.completedAt) >= slot) return "completed";
  return nowMs > slot + OVERDUE_GRACE_MS ? "overdue" : "completed";
}

export async function getAutomatedHealthStatus(
  now: Date = new Date()
): Promise<AutomatedHealthStatus> {
  const [run, report] = await Promise.all([
    readStored<HealthRunProgress>(RUN_KEY, localRun),
    readStored<HealthRunReport>(REPORT_KEY, localReport),
  ]);
  const validRun = run?.startedAt ? run : null;
  const validReport = report?.completedAt ? report : null;
  return {
    state: deriveState(now.getTime(), validRun, validReport),
    run: validRun,
    report: validReport,
    nextScheduledAt: nextScheduledSlotAt(now).toISOString(),
    lastScheduledSlotAt: previousScheduledSlotAt(now).toISOString(),
    cronUtc: HEALTH_RUN_CRON_UTC,
    cronLocal: HEALTH_RUN_CRON_LOCAL,
    everSeen: Boolean(validRun || validReport),
  };
}
