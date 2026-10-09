/**
 * SoluPlay Automatic Server-Side Health Checker
 *
 * The curated catalogue only: this checker probes links that belong to PINNED
 * channels, and nothing else.
 *
 *   - On boot            : probes the pinned channels so the visible rails have
 *                          fresh evidence within a minute.
 *   - Category batches   : `lib/healthSchedule.ts` splits the five categories
 *                          across 09:00/09:30, 15:00/15:30 and 21:00/21:30 UTC,
 *                          plus a 03:00 sweep over every pinned channel.
 *   - Every 6 hours      : a long-lived process re-checks the whole pinned set.
 *   - Every hour         : `runDeliveryRecheck` gives another 10-second window to
 *                          the links the delivery rule hid — and to any still
 *                          holding an unconfirmed miss — showing a link again as
 *                          soon as it hands over media.
 *
 * Unpinned channels are invisible to users, so they are never probed: an
 * administrator brings a channel into health checking by pinning it. When no
 * channel matches a batch there is simply nothing to check — the scope never
 * widens back to the full catalogue.
 *
 * Six-hourly checking is a *detection* cadence only. A link is hidden after 3
 * consecutive failed DAILY checks (`lib/streamHealth.ts` advances the streak at
 * most once per UTC day), so four checks a day cannot retire anything early —
 * and a link that comes back is restored on the next pass, hours instead of a
 * day sooner.
 *
 * - Marks non-working streams "degraded" → "broken" (a channel with no usable
 *   link stops being listed to viewers) and re-promotes a healthy backup into
 *   Server 1 as soon as a link's status flips
 * - Automatically re-activates previously broken streams that come back online
 * - Persists results to data/store.json for in-memory mode
 * - Works with MongoDB when available
 */

import { connectToDatabase } from "@/lib/db";
import Channel from "@/models/Channel";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { checkHlsStream, redactUrl, type HlsCheckResult, type ProbeOptions } from "@/lib/streamProbe";
import { decideStreamHealth, type StoredStreamStatus } from "@/lib/streamHealth";
import { refreshChannelLinks, runMaintenance } from "@/lib/maintenanceRunner";
import type { ChannelCategory } from "@/lib/categories";
import type { HealthBatchTask } from "@/lib/healthSchedule";

/**
 * `"pinned"` = every pinned channel, `"full"` = every pinned channel and the
 * whole-catalogue maintenance afterwards, `"recheck"` = only the links waiting on
 * a delivery verdict (hidden by the rule, or holding a miss it has not confirmed
 * yet), anything else = one category batch from `lib/healthSchedule.ts`.
 */
export type HealthCheckScope = "pinned" | "full" | "recheck" | HealthBatchTask;

export interface HealthCheckOptions {
  /** Restrict the pass to these categories (pinned channels only either way). */
  categories?: readonly ChannelCategory[] | null;
  /** Wall-clock budget for a serverless run; the next pass resumes the rotation. */
  deadlineMs?: number;
  /** Run the whole-catalogue maintenance pass afterwards. */
  maintenanceAfter?: boolean;
}

const FULL_INTERVAL_MS = 6 * 60 * 60 * 1000;       // every 6 hours
const RECHECK_INTERVAL_MS = 60 * 60 * 1000;        // hourly: is what we hid delivering again?
const RETRY_DELAY_MS = 15 * 60 * 1000;             // a skipped/failed pass retries soon
const MAX_RETRIES_PER_CYCLE = 4;                  // then the regular 6-hour tick resumes
const PROBE_TIMEOUT_MS = 12000;
const BATCH_CONCURRENCY = 15;                      // Probe 15 streams in parallel for speed

/**
 * Links probed by one pass. A serverless run has a wall-clock limit, so a big
 * catalogue is covered over several passes instead of being cut off mid-way;
 * links are picked least-recently-checked first, so nothing starves.
 */
const MAX_LINKS_PER_RUN = 400;

/**
 * The hourly delivery re-check gives each hidden link one 10-second window —
 * enough to answer "does it serve a viewer now", not a fresh verdict on its
 * health. Oldest miss first, bounded, so a long tail of dead links cannot
 * starve the ones that just came back.
 */
const RECHECK_LINKS_PER_RUN = 60;
const RECHECK_PROBE_OPTS = {
  timeoutMs: 9000,
  maxAttempts: 1,
  checkLiveRefresh: false,
  useFfprobe: false,
  segmentSampleSize: 1,
} as const;

declare global {
  // eslint-disable-next-line no-var
  var __freetv_health_checker_started: boolean | undefined;
  // eslint-disable-next-line no-var
  var __freetv_full_check_interval: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __freetv_delivery_recheck_interval: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __freetv_health_retry_timer: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __freetv_health_retry_count: number | undefined;
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
  /** True when a time budget stopped the pass early. Links sort oldest-check-first,
   *  so the next run carries on where this one stopped. */
  truncated: boolean;
  timestamp: string;
}

function emptyResult(scope: HealthCheckScope, truncated = false): HealthCheckResult {
  return {
    scope,
    totalChecked: 0,
    active: 0,
    degraded: 0,
    broken: 0,
    recovered: 0,
    truncated,
    timestamp: global.__freetv_last_health_check || new Date().toISOString(),
  };
}

/**
 * Probe streams in batches of BATCH_CONCURRENCY for faster checking
 */
async function probeBatch<T extends { url: string; headers?: Record<string, string> }>(
  streams: T[],
  probeOptions: ProbeOptions
): Promise<Map<string, HlsCheckResult>> {
  const results = new Map<string, HlsCheckResult>();

  for (let i = 0; i < streams.length; i += BATCH_CONCURRENCY) {
    const batch = streams.slice(i, i + BATCH_CONCURRENCY);
    const probePromises = batch.map(async (stream) => {
      const result = await checkHlsStream(stream.url, {
        ...probeOptions,
        headers: stream.headers,
      });
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
    browserCors: result.browserCors,
    browserBlocker: result.browserBlocker,
    deliveryMisses: result.deliveryMisses,
  };
}

/**
 * Resolves the channels one pass may touch: pinned only, optionally narrowed to
 * a category batch. An empty result means empty work — callers must not widen
 * the scope, since unpinned channels are deliberately outside the health engine.
 */
async function resolveTargetChannelIds(
  conn: Awaited<ReturnType<typeof connectToDatabase>>,
  categories: readonly ChannelCategory[] | null | undefined
): Promise<string[]> {
  const scoped = categories && categories.length > 0 ? Array.from(categories) : null;

  if (conn) {
    const filter: Record<string, unknown> = { isPinned: true };
    if (scoped) filter.category = { $in: scoped };
    const docs = await Channel.find(filter).select("_id").lean();
    return docs.map((c) => String(c._id));
  }

  return inMemoryDb
    .getChannels()
    .filter((c) => c.isPinned && (!scoped || scoped.includes(c.category)))
    .map((c) => c._id);
}

/**
 * Run health check on streams (In-Memory mode).
 * `channelIds`: the pinned channels in scope for this pass — links belonging to
 * any other channel are never probed.
 */
async function runInMemoryHealthCheck(
  scope: HealthCheckScope,
  channelIds: string[]
): Promise<HealthCheckResult> {
  const recheck = scope === "recheck";
  const allowed = new Set(channelIds);
  const streams = inMemoryDb
    .getStreams()
    .filter(
      (s) =>
        !s.adminDisabled &&
        allowed.has(s.channelId) &&
        // A link the rule hid, and a link holding one unconfirmed miss — that
        // miss is what the next hour has to either clear or turn into hiding.
        (!recheck || s.deliveryHidden === true || (s.deliveryMisses ?? 0) > 0)
    )
    .sort((a, b) => {
      // A re-check works the oldest miss first; a normal pass puts hidden links
      // ahead of the queue and is otherwise least-recently-checked first.
      if (recheck) {
        const aMiss = a.lastDeliveryMissAt ? new Date(a.lastDeliveryMissAt).getTime() : 0;
        const bMiss = b.lastDeliveryMissAt ? new Date(b.lastDeliveryMissAt).getTime() : 0;
        return aMiss - bMiss;
      }
      const hiddenFirst = Number(b.deliveryHidden === true) - Number(a.deliveryHidden === true);
      if (hiddenFirst !== 0) return hiddenFirst;
      const aTime = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0;
      const bTime = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0;
      return aTime - bTime;
    })
    .slice(0, recheck ? RECHECK_LINKS_PER_RUN : MAX_LINKS_PER_RUN);
  const now = new Date();
  let active = 0;
  let degraded = 0;
  let broken = 0;
  let recovered = 0;

  console.log(`[AutoHealthChecker] (${scope}) Probing ${streams.length} stream links (in-memory mode)...`);

  const probeResults = await probeBatch(streams, recheck ? RECHECK_PROBE_OPTS : { timeoutMs: PROBE_TIMEOUT_MS });

  for (const stream of streams) {
    const result = probeResults.get(stream.url);
    if (!result) continue;

    const previousStatus = stream.status as StoredStreamStatus;
    const wasBrokenOrDegraded = previousStatus !== "active";
    stream.lastCheck = toLastCheckDetail(result);

    const decision = decideStreamHealth(
      previousStatus,
      stream.failedAttempts || 0,
      stream.firstFailedAt,
      result,
      now,
      stream.lastCountedFailureDay,
      {
        deliveryHidden: stream.deliveryHidden,
        deliveryMisses: stream.deliveryMisses,
        lastDeliveryMissAt: stream.lastDeliveryMissAt,
      }
    );

    stream.status = decision.status;
    stream.latency = decision.latency;
    stream.failedAttempts = decision.failedAttempts;
    stream.firstFailedAt = decision.firstFailedAt;
    stream.lastCheckedAt = decision.lastCheckedAt;
    stream.lastCountedFailureDay = decision.lastCountedFailureDay;
    stream.browserBlocker = decision.browserBlocker;
    stream.deliveryMisses = decision.deliveryMisses;
    stream.lastDeliveryMissAt = decision.lastDeliveryMissAt;
    stream.deliveryHidden = decision.deliveryHidden;

    if (decision.status === "active") {
      // Stream is WORKING — mark active (re-activate if was broken)
      if (wasBrokenOrDegraded) {
        recovered++;
        console.log(`  [RECOVERED] ${redactUrl(stream.url)} → ACTIVE (was ${previousStatus})`);
      }
      active++;
    } else if (decision.status === "broken") {
      broken++;
      console.log(
        `  [BROKEN] ${redactUrl(stream.url)} (${
          decision.deliveryHidden
            ? `no media in ${decision.deliveryMisses} delivery windows`
            : `${stream.failedAttempts} daily fails`
        }: ${result.status} — ${result.reason})`
      );
    } else {
      degraded++;
      console.log(
        `  [DEGRADED] ${redactUrl(stream.url)} (${stream.failedAttempts} daily fails: ${result.status} — ${result.reason})`
      );
    }
  }

  // Persist changes to disk
  inMemoryDb.saveState();

  const timestamp = now.toISOString();
  return { scope, totalChecked: streams.length, active, degraded, broken, recovered, truncated: false, timestamp };
}

/**
 * Run health check on streams (MongoDB mode).
 * `channelIds`: the pinned channels in scope for this pass. Nothing outside
 * those ids is ever probed — an unpinned channel's links are invisible here, and
 * so is the whole catalogue when nothing is pinned.
 * `deadlineAt`: stop starting new batches after this epoch-ms. A scheduled run
 * from a serverless cron has a hard wall-clock limit, and because links are
 * picked least-recently-checked-first the next pass simply continues where this
 * one stopped — nothing is missed, the batch just rotates across runs.
 *
 * An admin-disabled link is not probed at all: only an admin can bring it back,
 * otherwise a 6-hourly check would silently undo a deliberate take-out-of-service.
 */
async function runMongoHealthCheck(
  scope: HealthCheckScope,
  channelIds: string[],
  deadlineAt?: number
): Promise<HealthCheckResult> {
  const now = new Date();
  const recheck = scope === "recheck";
  let active = 0;
  let degraded = 0;
  let broken = 0;
  let recovered = 0;

  // Least-recently-checked first, so a bounded run rotates through the batch
  // instead of re-probing the same links and starving the rest. Links the
  // delivery rule hid go first: a budget-truncated pass still lifts the ones
  // that have started working again. A re-check covers the links that need a
  // delivery verdict — hidden ones, and ones still holding an unconfirmed miss —
  // oldest miss first.
  const filter: Record<string, unknown> = {
    adminDisabled: { $ne: true },
    channelId: { $in: channelIds },
  };
  if (recheck) {
    filter.$or = [{ deliveryHidden: true }, { deliveryMisses: { $gt: 0 } }];
  }
  const streams = await StreamLink.find(filter)
    .sort(recheck ? { lastDeliveryMissAt: 1 } : { deliveryHidden: -1, lastCheckedAt: 1 })
    .limit(recheck ? RECHECK_LINKS_PER_RUN : MAX_LINKS_PER_RUN);

  const skippedDisabled = await StreamLink.countDocuments({
    adminDisabled: true,
    channelId: { $in: channelIds },
  });
  console.log(
    `[AutoHealthChecker] (${scope}) Probing ${streams.length} stream links (MongoDB mode)` +
      (skippedDisabled > 0 ? `, ${skippedDisabled} admin-disabled link(s) left alone` : "") +
      "..."
  );

  // Channels whose links flipped state — their Server 1 order has to be fixed
  // now, not whenever the next maintenance pass happens to land.
  const changedChannelIds = new Set<string>();

  // Probe in batches
  let truncated = false;
  for (let i = 0; i < streams.length; i += BATCH_CONCURRENCY) {
    if (deadlineAt && Date.now() >= deadlineAt) {
      truncated = true;
      console.log(
        `[AutoHealthChecker] (${scope}) Time budget reached after ${i} link(s) — the rest carry on next run.`
      );
      break;
    }
    const batch = streams.slice(i, i + BATCH_CONCURRENCY);
    const probePromises = batch.map(async (stream) => {
      const result = await checkHlsStream(stream.url, {
        ...(recheck ? RECHECK_PROBE_OPTS : { timeoutMs: PROBE_TIMEOUT_MS }),
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
        previousStatus,
        stream.failedAttempts || 0,
        stream.firstFailedAt,
        result,
        now,
        stream.lastCountedFailureDay,
        {
          deliveryHidden: stream.deliveryHidden,
          deliveryMisses: stream.deliveryMisses,
          lastDeliveryMissAt: stream.lastDeliveryMissAt,
        }
      );
      stream.status = decision.status;
      stream.latency = decision.latency;
      stream.failedAttempts = decision.failedAttempts;
      stream.firstFailedAt = decision.firstFailedAt;
      stream.lastCheckedAt = decision.lastCheckedAt;
      stream.lastCountedFailureDay = decision.lastCountedFailureDay;
      stream.browserBlocker = decision.browserBlocker;
      stream.deliveryMisses = decision.deliveryMisses;
      stream.lastDeliveryMissAt = decision.lastDeliveryMissAt;
      stream.deliveryHidden = decision.deliveryHidden;

      if (decision.status !== previousStatus) {
        changedChannelIds.add(String(stream.channelId));
      }

      if (decision.status === "active") {
        if (wasBrokenOrDegraded) {
          recovered++;
          console.log(`  [RECOVERED] ${redactUrl(stream.url)} → ACTIVE (was ${previousStatus})`);
        }
        await stream.save();
        active++;
      } else {
        if (decision.status === "broken") {
          broken++;
          console.log(
            `  [BROKEN] ${redactUrl(stream.url)} (${
              decision.deliveryHidden
                ? `no media in ${decision.deliveryMisses} delivery windows`
                : `${decision.failedAttempts} daily fails`
            }: ${result.status} — ${result.reason})`
          );
        } else {
          degraded++;
          console.log(
            `  [DEGRADED] ${redactUrl(stream.url)} (${decision.failedAttempts} daily fails: ${result.status} — ${result.reason})`
          );
        }
        await stream.save();
      }
    });
    await Promise.allSettled(probePromises);
  }

  // Promote a healthy backup into Server 1 straight away for the channels that
  // actually flipped, instead of leaving viewers pointed at a link that this
  // same pass just proved dead.
  const reorderIds = Array.from(changedChannelIds).slice(0, 40);
  for (const channelId of reorderIds) {
    try {
      await refreshChannelLinks(channelId);
    } catch (err: any) {
      console.error(`[AutoHealthChecker] link reorder failed for ${channelId}:`, err?.message || err);
    }
  }
  if (reorderIds.length > 0) {
    console.log(`[AutoHealthChecker] Re-ranked ${reorderIds.length} channel(s) after status changes`);
  }

  const timestamp = now.toISOString();
  return { scope, totalChecked: streams.length, active, degraded, broken, recovered, truncated, timestamp };
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
 * documents, so letting them overlap (e.g. a full 24-hour pass and an hourly
 * pinned tick landing at the same moment) risks the same write race we're
 * trying to avoid. If the lock is held, the pinned tick simply skips and
 * tries again in an hour — cheap enough that this is a non-issue in practice.
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
 * A pass that threw, or that found the cross-instance lock already held, would
 * otherwise wait a full 6 hours to try again — which is long enough for one
 * transient failure to look like a quiet gap in coverage. Retry shortly instead,
 * up to a bounded number of times so a persistently broken run cannot spin.
 */
function scheduleRetry(scope: HealthCheckScope, reason: string, options: HealthCheckOptions = {}) {
  const attempts = global.__freetv_health_retry_count || 0;
  if (attempts >= MAX_RETRIES_PER_CYCLE) {
    console.warn(
      `[AutoHealthChecker] (${scope}) Retry budget used up (${reason}) — waiting for the regular 6-hour tick.`
    );
    global.__freetv_health_retry_count = 0;
    return;
  }
  global.__freetv_health_retry_count = attempts + 1;
  console.log(
    `[AutoHealthChecker] (${scope}) ${reason} — retry ${attempts + 1}/${MAX_RETRIES_PER_CYCLE} in ${RETRY_DELAY_MS / 60_000} min`
  );
  if (global.__freetv_health_retry_timer) clearTimeout(global.__freetv_health_retry_timer);
  global.__freetv_health_retry_timer = setTimeout(() => runAutoHealthCheck(scope, options), RETRY_DELAY_MS);
  global.__freetv_health_retry_timer.unref?.();
}

/**
 * Main health check runner — detects DB mode and probes the pinned channels in
 * scope. `scope` defaults to "full" (used by the admin panel's manual "Run Now"
 * button). `options.categories` narrows the pass to one category batch,
 * `deadlineMs` bounds wall-clock work for scheduled (serverless) runs, and
 * `maintenanceAfter` opts a batch into the whole-catalogue maintenance pass.
 */
async function runAutoHealthCheck(
  scope: HealthCheckScope = "full",
  options: HealthCheckOptions = {}
): Promise<HealthCheckResult> {
  const deadlineAt = options.deadlineMs ? Date.now() + options.deadlineMs : undefined;
  // Re-entrancy guard: with enough streams a single pass can take longer than
  // its own interval, and the category batches, the full pass and the retry
  // timer all call this same function. Without this guard, two overlapping runs
  // could race on the same stream records and on data/store.json. (The admin
  // dashboard's "Run Health Check (All Pinned)" button is a separate, batched
  // caller in `/api/admin/health-check`; a link that gets probed by both sides
  // in the same moment simply re-appears as due and is tested again.)
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
        global.__freetv_health_check_running = false;
        scheduleRetry(scope, "Another instance already holds the lock", options);
        return emptyResult(scope);
      }
      mongoLockHeld = true;
    }

    // Every pass is pinned-only; a category batch narrows it further. No
    // fallback to the full catalogue: zero channels in scope is zero work.
    const targetChannelIds = await resolveTargetChannelIds(conn, options.categories);

    if (targetChannelIds.length === 0) {
      console.log(
        `[AutoHealthChecker] (${scope}) No pinned channels in scope — nothing to check.`
      );
      return emptyResult(scope);
    }

    const result = conn
      ? await runMongoHealthCheck(scope, targetChannelIds, deadlineAt)
      : await runInMemoryHealthCheck(scope, targetChannelIds);

    global.__freetv_last_health_check = result.timestamp;
    if (scope === "full") {
      global.__freetv_last_full_health_check = result.timestamp;
    }
    global.__freetv_health_retry_count = 0;

    // Fresh latencies just landed — keep the fastest-first ordering correct.
    // Links whose status flipped were already re-ranked for their own channel
    // inside the pass above; this is the whole-catalogue pass that also merges
    // duplicates, drops dead links past their window and re-sorts every channel.
    // Only a sweep that covered the pinned catalogue end to end qualifies.
    const maintainAfter = options.maintenanceAfter ?? scope === "full";
    try {
      // A budget-truncated pass has not seen the whole scope, so it must not
      // merge, reorder or delete across it — that happens on a completed pass.
      if (maintainAfter && !result.truncated) {
        const maintenance = await runMaintenance();
        console.log(
          `[AutoHealthChecker] Maintenance: merged ${maintenance.channelsMerged}, ` +
            `dropped ${maintenance.duplicateLinksRemoved} duplicates, ` +
            `${maintenance.placeholderLinksPurged} test links, ` +
            `${maintenance.deadLinksPurged} links dead past the daily window, ` +
            `reordered ${maintenance.channelsReordered} channels`
        );
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
    console.log(
      `  Next check in : ${
        scope === "recheck" ? "an hour" : scope === "full" ? "6 hours" : "the next scheduled batch"
      }`
    );
    console.log("══════════════════════════════════════════════════════\n");

    return result;
  } catch (err: any) {
    console.error(`[AutoHealthChecker] (${scope}) Fatal error:`, err.message || err);
    scheduleRetry(scope, `pass failed (${err?.message || err})`, options);
    return emptyResult(scope);
  } finally {
    if (mongoLockHeld && mongoConnForLock) {
      await releaseMongoLock(mongoConnForLock);
    }
    global.__freetv_health_check_running = false;
  }
}

/**
 * Start the automatic health checker: a quick pinned pass shortly after boot,
 * then the whole pinned set every 6 hours. Vercel's cron batches
 * (`lib/healthSchedule.ts`) cover the same ground on a long-lived server that
 * never restarts; this interval is the in-process counterpart. Safe to call
 * multiple times — only starts once per process via a global flag.
 */
export function startAutoHealthChecker() {
  if (global.__freetv_health_checker_started) {
    return; // Already running in this process
  }

  global.__freetv_health_checker_started = true;

  console.log(
    "[AutoHealthChecker] ✦ Activated — pinned channels on boot, pinned catalogue every 6 hours"
  );

  // Pinned channels first, so the homepage rails have fresh evidence within a
  // minute of boot rather than waiting on the catalogue pass.
  setTimeout(() => {
    runAutoHealthCheck("pinned");
  }, 30_000);

  // The whole pinned set, with maintenance: first run after 2 minutes (let the
  // boot pass settle in first), then every 6 hours.
  setTimeout(() => {
    runAutoHealthCheck("full");
  }, 2 * 60_000);
  global.__freetv_full_check_interval = setInterval(() => {
    runAutoHealthCheck("full");
  }, FULL_INTERVAL_MS);

  // The delivery rule hides a link the moment two 10-second windows come back
  // empty; this is what gives it another chance, an hour later, instead of
  // leaving a working channel invisible until the next 6-hour batch reaches it.
  global.__freetv_delivery_recheck_interval = setInterval(() => {
    runDeliveryRecheck();
  }, RECHECK_INTERVAL_MS);

  // Don't let either timer block Node.js from exiting
  if (global.__freetv_full_check_interval?.unref) {
    global.__freetv_full_check_interval.unref();
  }
  if (global.__freetv_delivery_recheck_interval?.unref) {
    global.__freetv_delivery_recheck_interval.unref();
  }
}

/**
 * Re-probe only the links hidden for delivery, one 10-second window each. Cheap
 * by design: it runs on every hourly cron line and before each scheduled
 * category batch, so a link that starts working again is invisible to viewers
 * for minutes, not until the next 6-hour pass.
 */
async function runDeliveryRecheck(deadlineMs?: number): Promise<HealthCheckResult> {
  return runAutoHealthCheck("recheck", { categories: null, deadlineMs, maintenanceAfter: false });
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
export { runAutoHealthCheck, runDeliveryRecheck };
