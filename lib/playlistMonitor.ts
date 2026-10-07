/**
 * SoluPlay Automatic Playlist Monitor
 * ===================================
 * The scheduling half of Direct HLS playlist syncing; `playlistSync.ts` is the
 * work itself. Mirrors `autoHealthChecker.ts` deliberately, because that is this
 * project's background-job pattern:
 *
 *   - started once from `instrumentation.ts` on server boot;
 *   - a *due* tick every 15 minutes rather than a per-source timer, so a restart
 *     never loses a day's check — a source is due once the day's scheduled sync
 *     hour has passed and it has not been checked since;
 *   - a source whose last fetch failed becomes due again after
 *     `FAILED_RETRY_MS` instead of waiting for tomorrow's slot;
 *   - a process-wide re-entrancy flag plus a MongoDB `_locks` document, because
 *     Vercel keeps several warm instances and each has its own `global`.
 *
 * Sources with monitoring disabled (`monitored: false`) or deactivated
 * (`active: false`) are never touched here; they only sync when the admin presses
 * "Check now".
 */

import { connectToDatabase } from "./db";
import PlaylistSource from "@/models/PlaylistSource";
import { syncAllDueSources, type PlaylistSyncSummary } from "./playlistSync";

/** UTC hour every daily source check is anchored to. Change only this. */
export const SYNC_HOUR_UTC = 20;

/** One source check per day. */
export const DAILY_CHECK_MS = 24 * 60 * 60 * 1000;
/** A source that failed to fetch retries in this window, not tomorrow. */
export const FAILED_RETRY_MS = 2 * 60 * 60 * 1000;
const DUE_TICK_MS = 15 * 60 * 1000;
const FIRST_TICK_MS = 45_000;
const STALE_LOCK_MS = 90 * 60 * 1000;

/**
 * The most recent moment the daily sync was scheduled: today's `SYNC_HOUR_UTC`
 * if it has passed, otherwise yesterday's. A source whose `lastCheckedAt` is
 * older than that has missed its slot.
 */
export function lastScheduledSyncAt(now: Date = new Date()): Date {
  const at = new Date(now.getTime());
  at.setUTCHours(SYNC_HOUR_UTC, 0, 0, 0);
  if (at.getTime() > now.getTime()) at.setUTCDate(at.getUTCDate() - 1);
  return at;
}

/** When the next daily sync is due — shown on the dashboard so the schedule is visible. */
export function nextScheduledSyncAt(now: Date = new Date()): Date {
  const next = lastScheduledSyncAt(now);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

declare global {
  // eslint-disable-next-line no-var
  var __freetv_playlist_monitor_started: boolean | undefined;
  // eslint-disable-next-line no-var
  var __freetv_playlist_check_interval: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __freetv_playlist_last_tick: string | undefined;
  // eslint-disable-next-line no-var
  var __freetv_playlist_running: boolean | undefined;
  // eslint-disable-next-line no-var
  var __freetv_playlist_last_result: PlaylistMonitorResult | undefined;
}

export interface PlaylistMonitorResult {
  at: string;
  checked: number;
  changed: number;
  failed: number;
  skippedLocked: boolean;
  summaries: PlaylistSyncSummary[];
}

export interface PlaylistMonitorStatus {
  running: boolean;
  /** How often the monitor looks for due sources. */
  dueTickMinutes: number;
  /** How long a source waits between automatic checks. */
  checkIntervalHours: number;
  /** UTC hour the daily check is anchored to. */
  syncHourUtc: number;
  /** When the next daily window opens. */
  nextScheduledSyncAt: string;
  lastTickAt: string | null;
  lastResult: PlaylistMonitorResult | null;
}

async function acquireLock(conn: typeof import("mongoose"), key: string): Promise<boolean> {
  const db = conn.connection.db;
  if (!db) return true; // No direct handle — fail open rather than never run.
  try {
    await db.collection<{ _id: string; lockedAt?: Date }>("_locks").findOneAndUpdate(
      {
        _id: key,
        $or: [{ lockedAt: { $exists: false } }, { lockedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) } }],
      },
      { $set: { lockedAt: new Date() } },
      { upsert: true }
    );
    return true;
  } catch {
    return false; // Duplicate key: another instance holds a fresh lock.
  }
}

async function releaseLock(conn: typeof import("mongoose"), key: string): Promise<void> {
  const db = conn.connection.db;
  if (!db) return;
  try {
    await db.collection<{ _id: string }>("_locks").deleteOne({ _id: key });
  } catch {
    // Non-fatal — the lock simply goes stale and is reclaimed later.
  }
}

/**
 * One monitor pass: every active + monitored source whose last check is older
 * than 24 hours (or that has never been checked). `force` re-checks everything,
 * which is what the admin "Check all now" action uses.
 */
export async function runPlaylistMonitorTick(force = false): Promise<PlaylistMonitorResult> {
  const empty: PlaylistMonitorResult = {
    at: new Date().toISOString(),
    checked: 0,
    changed: 0,
    failed: 0,
    skippedLocked: false,
    summaries: [],
  };

  if (global.__freetv_playlist_running) {
    console.log("[PlaylistMonitor] Skipped — a playlist sync is already in progress.");
    return empty;
  }
  global.__freetv_playlist_running = true;

  let mongoLockHeld = false;
  let connForLock: typeof import("mongoose") | null = null;

  try {
    const conn = await connectToDatabase();
    if (!conn) {
      console.log("[PlaylistMonitor] Skipped — MongoDB unavailable, playlist sources need it.");
      return empty;
    }

    if (!force) {
      connForLock = conn;
      const acquired = await acquireLock(conn, "playlist_monitor");
      if (!acquired) {
        console.log("[PlaylistMonitor] Skipped — another server instance holds the lock.");
        return { ...empty, skippedLocked: true };
      }
      mongoLockHeld = true;
    }

    const now = new Date();
    const dueBefore = force ? now : lastScheduledSyncAt(now);
    // A source that could not be fetched is retried inside the day rather than
    // silently skipping a whole schedule slot.
    const failedRetryBefore = new Date(now.getTime() - FAILED_RETRY_MS);
    const summaries = await syncAllDueSources(dueBefore, { force, failedRetryBefore });
    const result: PlaylistMonitorResult = {
      at: new Date().toISOString(),
      checked: summaries.length,
      changed: summaries.filter((s) => s.changed).length,
      failed: summaries.filter((s) => s.status === "failed").length,
      skippedLocked: false,
      summaries,
    };

    global.__freetv_playlist_last_tick = result.at;
    global.__freetv_playlist_last_result = result;

    if (summaries.length > 0) {
      console.log(
        `\n[PlaylistMonitor] ── Daily playlist check ──\n` +
          `  Sources checked : ${result.checked}\n` +
          `  With changes    : ${result.changed}\n` +
          `  Fetch failures  : ${result.failed}`
      );
      for (const summary of summaries) {
        console.log(
          `  ${summary.sourceName}: ${summary.status} · ${summary.entriesParsed} entries · ` +
            `${summary.probesRun} probe(s)` + (summary.error ? ` · ${summary.error}` : "")
        );
      }
    }

    return result;
  } catch (err: any) {
    console.error("[PlaylistMonitor] Fatal error:", err?.message || err);
    return empty;
  } finally {
    if (mongoLockHeld && connForLock) {
      await releaseLock(connForLock, "playlist_monitor");
    }
    global.__freetv_playlist_running = false;
  }
}

/**
 * Starts the monitor: first pass shortly after boot, then an hourly due-tick.
 * Safe to call more than once — one start per process.
 */
export function startPlaylistMonitor() {
  if (global.__freetv_playlist_monitor_started) return;
  global.__freetv_playlist_monitor_started = true;

  console.log(
    `[PlaylistMonitor] ✦ Activated — each monitored playlist is checked once per day at ${String(
      SYNC_HOUR_UTC
    ).padStart(2, "0")}:00 UTC (a failed fetch retries after ${FAILED_RETRY_MS / 3_600_000}h).`
  );

  setTimeout(() => {
    runPlaylistMonitorTick();
  }, FIRST_TICK_MS);

  global.__freetv_playlist_check_interval = setInterval(() => {
    runPlaylistMonitorTick();
  }, DUE_TICK_MS);

  if (global.__freetv_playlist_check_interval?.unref) {
    global.__freetv_playlist_check_interval.unref();
  }
}

export function getPlaylistMonitorStatus(): PlaylistMonitorStatus {
  return {
    running: Boolean(global.__freetv_playlist_monitor_started),
    dueTickMinutes: DUE_TICK_MS / 60_000,
    checkIntervalHours: DAILY_CHECK_MS / 3_600_000,
    syncHourUtc: SYNC_HOUR_UTC,
    nextScheduledSyncAt: nextScheduledSyncAt().toISOString(),
    lastTickAt: global.__freetv_playlist_last_tick || null,
    lastResult: global.__freetv_playlist_last_result || null,
  };
}

/** Sources that are past their daily check, or due for a fetch retry, right now. */
export async function countDueSources(): Promise<number> {
  const conn = await connectToDatabase();
  if (!conn) return 0;
  const now = new Date();
  return PlaylistSource.countDocuments({
    active: true,
    monitored: true,
    $or: [
      { lastCheckedAt: null },
      { lastCheckedAt: { $lt: lastScheduledSyncAt(now) } },
      {
        lastStatus: "failed",
        lastCheckedAt: { $lt: new Date(now.getTime() - FAILED_RETRY_MS) },
      },
    ],
  });
}
