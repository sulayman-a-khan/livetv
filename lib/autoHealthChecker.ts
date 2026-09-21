/**
 * SoluPlay Automatic Server-Side Health Checker
 *
 * Two-tier schedule:
 *   - Every 5 minutes  : probes only PINNED channels (across every category) —
 *                        these are the channels on the homepage/top of lists,
 *                        so they get checked often and recover fast.
 *   - Every 12 hours   : probes EVERY stream link in the catalogue.
 *
 * - Marks non-working streams as "degraded" → "broken" (hides channels with 0 active streams)
 * - Automatically re-activates previously broken streams that come back online
 * - Persists results to data/store.json for in-memory mode
 * - Works with MongoDB when available
 */

import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { checkHlsStream, redactUrl, type HlsCheckResult } from "@/lib/streamProbe";
import { decideStreamHealth, type StoredStreamStatus } from "@/lib/streamHealth";
import { runMaintenance, refreshChannelLinks } from "@/lib/maintenanceRunner";

export type HealthCheckScope = "pinned" | "full";

const PINNED_INTERVAL_MS = 5 * 60 * 1000;         // 5 minutes
const FULL_INTERVAL_MS = 12 * 60 * 60 * 1000;     // 12 hours
const PROBE_TIMEOUT_MS = 5000;                     // 5 seconds per stream probe
const BATCH_CONCURRENCY = 15;                      // Probe 15 streams in parallel for speed

declare global {
  // eslint-disable-next-line no-var
  var __freetv_health_checker_started: boolean | undefined;
  // eslint-disable-next-line no-var
  var __freetv_pinned_check_interval: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __freetv_full_check_interval: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __freetv_last_health_check: string | undefined;
  // eslint-disable-next-line no-var
  var __freetv_last_full_health_check: string | undefined;
  // eslint-disable-next-line no-var
  var __freetv_health_check_running: boolean | undefined;
}

interface HealthCheckResult {
  scope: HealthCheckScope;
  totalChecked: number;
  active: number;
  degraded: number;
  broken: number;
  recovered: number;
  timestamp: string;
}

function emptyResult(scope: HealthCheckScope): HealthCheckResult {
  return {
    scope,
    totalChecked: 0,
    active: 0,
    degraded: 0,
    broken: 0,
    recovered: 0,
    timestamp: global.__freetv_last_health_check || new Date().toISOString(),
  };
}

/**
 * Probe streams in batches of BATCH_CONCURRENCY for faster checking
 */
async function probeBatch<T extends { url: string; headers?: Record<string, string> }>(
  streams: T[],
  timeoutMs: number
): Promise<Map<string, HlsCheckResult>> {
  const results = new Map<string, HlsCheckResult>();

  for (let i = 0; i < streams.length; i += BATCH_CONCURRENCY) {
    const batch = streams.slice(i, i + BATCH_CONCURRENCY);
    const probePromises = batch.map(async (stream) => {
      const result = await checkHlsStream(stream.url, { timeoutMs, headers: stream.headers });
      results.set(stream.url, result);
    });
    await Promise.allSettled(probePromises);
  }

  return results;
}

/** Shrinks a full HLS check result down to the subset worth persisting on the stream record. */
function toLastCheckDetail(result: HlsCheckResult) {
  return {
    healthStatus: result.status,
    errorCode: result.errorCode,
    httpStatus: result.httpStatus,
    responseTime: result.responseTime,
    playlistType: result.playlistType,
    isLive: result.isLive,
    segmentCount: result.segmentCount,
    newSegmentDetected: result.newSegmentDetected,
    video: result.video,
    audio: result.audio,
    resolution: result.resolution,
    codec: result.codec,
    fps: result.fps,
    attempts: result.attempts,
    error: result.error,
    checkedAt: result.checkedAt,
  };
}

/**
 * Run health check on streams (In-Memory mode).
 * `channelIds`: when set, only streams belonging to these channels are probed
 * (used for the 5-minute pinned-only pass); `null` probes everything.
 */
async function runInMemoryHealthCheck(
  scope: HealthCheckScope,
  channelIds: string[] | null
): Promise<HealthCheckResult> {
  const allStreams = inMemoryDb.getStreams();
  const streams = channelIds
    ? allStreams.filter((s) => channelIds.includes(s.channelId))
    : allStreams;
  const now = new Date();
  let active = 0;
  let degraded = 0;
  let broken = 0;
  let recovered = 0;

  console.log(`[AutoHealthChecker] (${scope}) Probing ${streams.length} stream links (in-memory mode)...`);

  const probeResults = await probeBatch(streams, PROBE_TIMEOUT_MS);

  for (const stream of streams) {
    const result = probeResults.get(stream.url);
    if (!result) continue;

    const previousStatus = stream.status as StoredStreamStatus;
    const wasBrokenOrDegraded = previousStatus !== "active";
    stream.lastCheck = toLastCheckDetail(result);

    const decision = decideStreamHealth(
      previousStatus, stream.failedAttempts || 0, stream.firstFailedAt, result, now
    );

    if (decision.status === "active") {
      // Stream is WORKING — mark active (re-activate if was broken)
      if (wasBrokenOrDegraded) {
        recovered++;
        console.log(`  [RECOVERED] ${redactUrl(stream.url)} → ACTIVE (was ${stream.status})`);
      }
      stream.status = decision.status;
      stream.latency = decision.latency;
      stream.failedAttempts = decision.failedAttempts;
      stream.firstFailedAt = decision.firstFailedAt;
      stream.lastCheckedAt = decision.lastCheckedAt;
      active++;
    } else {
      stream.status = decision.status;
      stream.latency = decision.latency;
      stream.failedAttempts = decision.failedAttempts;
      stream.firstFailedAt = decision.firstFailedAt;
      stream.lastCheckedAt = decision.lastCheckedAt;

      if (decision.status === "broken") {
        broken++;
        console.log(
          `  [BROKEN] ${redactUrl(stream.url)} (${stream.failedAttempts} fails: ${result.status} — ${result.reason})`
        );
      } else {
        degraded++;
        console.log(
          `  [DEGRADED] ${redactUrl(stream.url)} (${stream.failedAttempts} fails: ${result.status} — ${result.reason})`
        );
      }
    }
  }

  // Persist changes to disk
  inMemoryDb.saveState();

  const timestamp = now.toISOString();
  return { scope, totalChecked: streams.length, active, degraded, broken, recovered, timestamp };
}

/**
 * Run health check on streams (MongoDB mode).
 * `channelIds`: when set, only streams belonging to these channels are probed
 * (used for the 5-minute pinned-only pass); `null` probes everything.
 */
async function runMongoHealthCheck(
  scope: HealthCheckScope,
  channelIds: string[] | null
): Promise<HealthCheckResult> {
  const now = new Date();
  let active = 0;
  let degraded = 0;
  let broken = 0;
  let recovered = 0;

  const filter = channelIds ? { channelId: { $in: channelIds } } : {};
  const streams = await StreamLink.find(filter).sort({ lastCheckedAt: 1 });

  console.log(`[AutoHealthChecker] (${scope}) Probing ${streams.length} stream links (MongoDB mode)...`);

  // Probe in batches
  for (let i = 0; i < streams.length; i += BATCH_CONCURRENCY) {
    const batch = streams.slice(i, i + BATCH_CONCURRENCY);
    const probePromises = batch.map(async (stream) => {
      const result = await checkHlsStream(stream.url, {
        timeoutMs: PROBE_TIMEOUT_MS,
        headers: (stream as unknown as { headers?: Record<string, string> }).headers,
      });
      const previousStatus = stream.status as StoredStreamStatus;
      const wasBrokenOrDegraded = previousStatus !== "active";

      // Best-effort: only persists if the StreamLink schema has a `lastCheck`
      // Mixed/Object field. A strict Mongoose schema silently drops unknown
      // paths on save rather than erroring, so this is safe either way — see
      // the integration notes for the schema snippet to add if you want this
      // detail to actually persist in MongoDB mode.
      (stream as unknown as { lastCheck?: unknown }).lastCheck = toLastCheckDetail(result);

      const decision = decideStreamHealth(
        previousStatus, stream.failedAttempts || 0, stream.firstFailedAt, result, now
      );
      stream.status = decision.status;
      stream.latency = decision.latency;
      stream.failedAttempts = decision.failedAttempts;
      stream.firstFailedAt = decision.firstFailedAt;
      stream.lastCheckedAt = decision.lastCheckedAt;

      if (decision.status === "active") {
        if (wasBrokenOrDegraded) {
          recovered++;
          console.log(`  [RECOVERED] ${redactUrl(stream.url)} → ACTIVE (was ${stream.status})`);
        }
        await stream.save();
        active++;
      } else {
        if (decision.status === "broken") {
          broken++;
          console.log(
            `  [BROKEN] ${redactUrl(stream.url)} (${stream.failedAttempts} fails: ${result.status} — ${result.reason})`
          );
        } else {
          stream.status = "degraded";
          degraded++;
        }
        await stream.save();
      }
    });
    await Promise.allSettled(probePromises);
  }

  const timestamp = now.toISOString();
  return { scope, totalChecked: streams.length, active, degraded, broken, recovered, timestamp };
}

/**
 * Cross-instance lock using MongoDB (when connected). A single Node process's
 * `global` flag can't stop two separate serverless instances from both
 * running the checker at once — Vercel can keep several warm simultaneously,
 * each with its own isolated `global`. This uses an atomic upsert against a
 * single well-known document: if another instance holds a fresh lock, the
 * upsert collides on `_id` and throws, which we read as "already locked".
 * A lock older than STALE_LOCK_MS is treated as abandoned (e.g. the instance
 * that held it crashed or was recycled mid-run) and can be re-acquired.
 *
 * The pinned and full passes share ONE lock: they both mutate StreamLink
 * documents, so letting them overlap (e.g. a full 12-hour pass and a 5-minute
 * pinned tick landing at the same moment) risks the same write race we're
 * trying to avoid. If the lock is held, the pinned tick simply skips and
 * tries again in 5 minutes — cheap enough that this is a non-issue in practice.
 */
const STALE_LOCK_MS = 30 * 60 * 1000;

async function acquireMongoLock(conn: typeof import("mongoose")): Promise<boolean> {
  const db = conn.connection.db;
  if (!db) return true; // No direct db handle available — fail open rather than block forever.
  try {
    await db.collection<{ _id: string; lockedAt?: Date }>("_locks").findOneAndUpdate(
      {
        _id: "auto_health_check",
        $or: [{ lockedAt: { $exists: false } }, { lockedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) } }],
      },
      { $set: { lockedAt: new Date() } },
      { upsert: true }
    );
    return true;
  } catch {
    // Duplicate-key error: a fresh lock already exists elsewhere.
    return false;
  }
}

async function releaseMongoLock(conn: typeof import("mongoose")): Promise<void> {
  const db = conn.connection.db;
  if (!db) return;
  try {
    await db.collection<{ _id: string }>("_locks").deleteOne({ _id: "auto_health_check" });
  } catch {
    // Non-fatal — the lock will simply go stale and be reclaimed later.
  }
}

/**
 * Main health check runner — detects DB mode and runs the requested scope.
 * `scope` defaults to "full" (used by the admin panel's manual "Run Now" button).
 */
async function runAutoHealthCheck(scope: HealthCheckScope = "full"): Promise<HealthCheckResult> {
  // Re-entrancy guard: with enough streams a single pass can take longer than
  // its own interval, and the admin panel's "Run Health Check Now" button
  // calls this same function. Without this guard, two overlapping runs could
  // race on the same stream records and on data/store.json.
  if (global.__freetv_health_check_running) {
    console.log(`[AutoHealthChecker] (${scope}) Skipped — a health check is already in progress.`);
    return emptyResult(scope);
  }
  global.__freetv_health_check_running = true;

  console.log("\n══════════════════════════════════════════════════════");
  console.log(`[AutoHealthChecker] (${scope}) Starting health check at ${new Date().toISOString()}`);
  console.log("══════════════════════════════════════════════════════");

  let mongoLockHeld = false;
  let mongoConnForLock: typeof import("mongoose") | null = null;

  try {
    const conn = await connectToDatabase();

    if (conn) {
      mongoConnForLock = conn;
      const acquired = await acquireMongoLock(conn);
      if (!acquired) {
        console.log(`[AutoHealthChecker] (${scope}) Skipped — another server instance already holds the lock.`);
        return emptyResult(scope);
      }
      mongoLockHeld = true;
    }

    // Resolve which channels are in scope. "full" = every channel (null filter).
    let pinnedChannelIds: string[] | null = null;
    if (scope === "pinned") {
      if (conn) {
        const pinned = await Channel.find({ isPinned: true }).select("_id").lean();
        pinnedChannelIds = pinned.map((c) => String(c._id));
      } else {
        pinnedChannelIds = inMemoryDb
          .getChannels()
          .filter((c) => c.isPinned)
          .map((c) => c._id);
      }

      if (pinnedChannelIds.length === 0) {
        console.log("[AutoHealthChecker] (pinned) No pinned channels — nothing to check.");
        return emptyResult(scope);
      }
    }

    const result = conn
      ? await runMongoHealthCheck(scope, pinnedChannelIds)
      : await runInMemoryHealthCheck(scope, pinnedChannelIds);

    global.__freetv_last_health_check = result.timestamp;
    if (scope === "full") {
      global.__freetv_last_full_health_check = result.timestamp;
    }

    // Fresh latencies just landed — keep the fastest-first ordering correct.
    try {
      if (scope === "full") {
        // Full catalogue pass: normalize, merge duplicates, purge test links,
        // renumber every channel's servers fastest-first.
        const maintenance = await runMaintenance();
        console.log(
          `[AutoHealthChecker] Maintenance: merged ${maintenance.channelsMerged}, ` +
            `purged ${maintenance.placeholderLinksPurged} test links, ` +
            `reordered ${maintenance.channelsReordered} channels`
        );
      } else if (pinnedChannelIds) {
        // Pinned pass: cheap targeted re-sort for just the channels we touched,
        // instead of the full catalogue sweep every 5 minutes.
        await Promise.all(pinnedChannelIds.map((id) => refreshChannelLinks(id)));
      }
    } catch (err: any) {
      console.error("[AutoHealthChecker] Maintenance pass failed:", err?.message || err);
    }

    console.log(`\n[AutoHealthChecker] ── Health Check Summary (${scope}) ──`);
    console.log(`  Total Checked : ${result.totalChecked}`);
    console.log(`  Active        : ${result.active}`);
    console.log(`  Degraded      : ${result.degraded}`);
    console.log(`  Broken        : ${result.broken}`);
    console.log(`  Recovered     : ${result.recovered}`);
    console.log(`  Next ${scope} check in : ${scope === "pinned" ? "5 minutes" : "12 hours"}`);
    console.log("══════════════════════════════════════════════════════\n");

    return result;
  } catch (err: any) {
    console.error(`[AutoHealthChecker] (${scope}) Fatal error:`, err.message || err);
    return emptyResult(scope);
  } finally {
    if (mongoLockHeld && mongoConnForLock) {
      await releaseMongoLock(mongoConnForLock);
    }
    global.__freetv_health_check_running = false;
  }
}

/**
 * Start the automatic health checker: pinned channels every 5 minutes, the
 * full catalogue every 12 hours. Safe to call multiple times — only starts
 * once per process via a global flag.
 */
export function startAutoHealthChecker() {
  if (global.__freetv_health_checker_started) {
    return; // Already running in this process
  }

  global.__freetv_health_checker_started = true;

  console.log(
    "[AutoHealthChecker] ✦ Activated — pinned channels every 5 minutes, full catalogue every 12 hours"
  );

  // Pinned channels: first run after 30s, then every 5 minutes.
  setTimeout(() => {
    runAutoHealthCheck("pinned");
  }, 30_000);
  global.__freetv_pinned_check_interval = setInterval(() => {
    runAutoHealthCheck("pinned");
  }, PINNED_INTERVAL_MS);

  // Full catalogue: first run after 2 minutes (let the pinned check settle
  // in first), then every 12 hours.
  setTimeout(() => {
    runAutoHealthCheck("full");
  }, 2 * 60_000);
  global.__freetv_full_check_interval = setInterval(() => {
    runAutoHealthCheck("full");
  }, FULL_INTERVAL_MS);

  // Don't let either interval block Node.js from exiting
  if (global.__freetv_pinned_check_interval?.unref) {
    global.__freetv_pinned_check_interval.unref();
  }
  if (global.__freetv_full_check_interval?.unref) {
    global.__freetv_full_check_interval.unref();
  }
}

/**
 * Get the last health check timestamp (pinned or full, whichever ran last).
 */
export function getLastHealthCheckTime(): string | null {
  return global.__freetv_last_health_check || null;
}

/**
 * Get the last FULL (all-streams) health check timestamp specifically.
 */
export function getLastFullHealthCheckTime(): string | null {
  return global.__freetv_last_full_health_check || null;
}

/**
 * Manually trigger a health check (for admin API). Defaults to a full pass.
 */
export { runAutoHealthCheck };
