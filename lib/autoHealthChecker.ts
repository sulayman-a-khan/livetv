/**
 * SoluPlay Automatic Server-Side Health Checker
 * 
 * Runs every 20 minutes inside the Next.js server process.
 * - Probes ALL stream links for every channel
 * - Marks non-working streams as "degraded" → "broken" (hides channels with 0 active streams)
 * - Automatically re-activates previously broken streams that come back online
 * - Persists results to data/store.json for in-memory mode
 * - Works with MongoDB when available
 */

import { connectToDatabase } from "@/lib/db";
import StreamLink from "@/models/StreamLink";
import { inMemoryDb } from "@/lib/inMemoryStore";
import { probeStreamUrl } from "@/lib/streamProbe";
import { runMaintenance } from "@/lib/maintenanceRunner";

const INTERVAL_MS = 20 * 60 * 1000; // 20 minutes
const PROBE_TIMEOUT_MS = 6000;       // 6 seconds per stream probe
const BATCH_CONCURRENCY = 5;         // Probe 5 streams in parallel for speed

declare global {
  // eslint-disable-next-line no-var
  var __freetv_health_checker_started: boolean | undefined;
  // eslint-disable-next-line no-var
  var __freetv_health_checker_interval: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __freetv_last_health_check: string | undefined;
}

interface HealthCheckResult {
  totalChecked: number;
  active: number;
  degraded: number;
  broken: number;
  recovered: number;
  timestamp: string;
}

/**
 * Probe streams in batches of BATCH_CONCURRENCY for faster checking
 */
async function probeBatch<T extends { url: string }>(
  streams: T[],
  timeoutMs: number
): Promise<Map<string, { ok: boolean; latency: number; reason?: string }>> {
  const results = new Map<string, { ok: boolean; latency: number; reason?: string }>();

  for (let i = 0; i < streams.length; i += BATCH_CONCURRENCY) {
    const batch = streams.slice(i, i + BATCH_CONCURRENCY);
    const probePromises = batch.map(async (stream) => {
      const result = await probeStreamUrl(stream.url, timeoutMs);
      results.set(stream.url, result);
    });
    await Promise.allSettled(probePromises);
  }

  return results;
}

/**
 * Run health check on all streams (In-Memory mode)
 */
async function runInMemoryHealthCheck(): Promise<HealthCheckResult> {
  const streams = inMemoryDb.getStreams();
  const now = new Date();
  let active = 0;
  let degraded = 0;
  let broken = 0;
  let recovered = 0;

  console.log(`[AutoHealthChecker] Probing ${streams.length} stream links (in-memory mode)...`);

  const probeResults = await probeBatch(streams, PROBE_TIMEOUT_MS);

  for (const stream of streams) {
    const result = probeResults.get(stream.url);
    if (!result) continue;

    const wasBrokenOrDegraded = stream.status === "broken" || stream.status === "degraded";

    if (result.ok) {
      // Stream is WORKING — mark active (re-activate if was broken)
      if (wasBrokenOrDegraded) {
        recovered++;
        console.log(`  [RECOVERED] ${stream.url.substring(0, 50)}... → ACTIVE (was ${stream.status})`);
      }
      stream.status = "active";
      stream.latency = result.latency;
      stream.failedAttempts = 0;
      stream.firstFailedAt = null;
      stream.lastCheckedAt = now;
      active++;
    } else {
      // Stream is NOT WORKING
      stream.failedAttempts = (stream.failedAttempts || 0) + 1;
      if (!stream.firstFailedAt) {
        stream.firstFailedAt = now;
      }
      stream.lastCheckedAt = now;

      if (stream.failedAttempts >= 3) {
        stream.status = "broken";
        broken++;
        console.log(`  [BROKEN] ${stream.url.substring(0, 50)}... (${stream.failedAttempts} fails: ${result.reason})`);
      } else {
        stream.status = "degraded";
        degraded++;
        console.log(`  [DEGRADED] ${stream.url.substring(0, 50)}... (${stream.failedAttempts} fails: ${result.reason})`);
      }
    }
  }

  // Persist changes to disk
  inMemoryDb.saveState();

  const timestamp = now.toISOString();
  return { totalChecked: streams.length, active, degraded, broken, recovered, timestamp };
}

/**
 * Run health check on all streams (MongoDB mode)
 */
async function runMongoHealthCheck(): Promise<HealthCheckResult> {
  const now = new Date();
  let active = 0;
  let degraded = 0;
  let broken = 0;
  let recovered = 0;

  // Fetch ALL streams sorted by least recently checked
  const streams = await StreamLink.find().sort({ lastCheckedAt: 1 });

  console.log(`[AutoHealthChecker] Probing ${streams.length} stream links (MongoDB mode)...`);

  // Probe in batches
  for (let i = 0; i < streams.length; i += BATCH_CONCURRENCY) {
    const batch = streams.slice(i, i + BATCH_CONCURRENCY);
    const probePromises = batch.map(async (stream) => {
      const result = await probeStreamUrl(stream.url, PROBE_TIMEOUT_MS);
      const wasBrokenOrDegraded = stream.status === "broken" || stream.status === "degraded";

      if (result.ok) {
        if (wasBrokenOrDegraded) {
          recovered++;
          console.log(`  [RECOVERED] ${stream.url.substring(0, 50)}... → ACTIVE (was ${stream.status})`);
        }
        stream.status = "active";
        stream.latency = result.latency;
        stream.failedAttempts = 0;
        stream.firstFailedAt = null;
        stream.lastCheckedAt = now;
        await stream.save();
        active++;
      } else {
        stream.failedAttempts = (stream.failedAttempts || 0) + 1;
        if (!stream.firstFailedAt) {
          stream.firstFailedAt = now;
        }
        stream.lastCheckedAt = now;

        if (stream.failedAttempts >= 3) {
          stream.status = "broken";
          broken++;
          console.log(`  [BROKEN] ${stream.url.substring(0, 50)}... (${stream.failedAttempts} fails: ${result.reason})`);
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
  return { totalChecked: streams.length, active, degraded, broken, recovered, timestamp };
}

/**
 * Main health check runner — detects DB mode and runs appropriate check
 */
async function runAutoHealthCheck(): Promise<HealthCheckResult> {
  console.log("\n══════════════════════════════════════════════════════");
  console.log(`[AutoHealthChecker] Starting automated health check at ${new Date().toISOString()}`);
  console.log("══════════════════════════════════════════════════════");

  try {
    const conn = await connectToDatabase();

    let result: HealthCheckResult;
    if (conn) {
      result = await runMongoHealthCheck();
    } else {
      result = await runInMemoryHealthCheck();
    }

    global.__freetv_last_health_check = result.timestamp;

    // Fresh latencies just landed — re-run the catalogue pass so the fastest
    // working link is promoted back to Server 1 and any link that recovered is
    // slotted into the right position. Recovered streams are already marked
    // "active" above, which is what makes a hidden channel reappear in the UI.
    try {
      const maintenance = await runMaintenance();
      console.log(
        `[AutoHealthChecker] Maintenance: merged ${maintenance.channelsMerged}, ` +
          `purged ${maintenance.placeholderLinksPurged} test links, ` +
          `reordered ${maintenance.channelsReordered} channels`
      );
    } catch (err: any) {
      console.error("[AutoHealthChecker] Maintenance pass failed:", err?.message || err);
    }

    console.log("\n[AutoHealthChecker] ── Health Check Summary ──");
    console.log(`  Total Checked : ${result.totalChecked}`);
    console.log(`  Active        : ${result.active}`);
    console.log(`  Degraded      : ${result.degraded}`);
    console.log(`  Broken        : ${result.broken}`);
    console.log(`  Recovered     : ${result.recovered}`);
    console.log(`  Next check in : 20 minutes`);
    console.log("══════════════════════════════════════════════════════\n");

    return result;
  } catch (err: any) {
    console.error("[AutoHealthChecker] Fatal error:", err.message || err);
    return {
      totalChecked: 0,
      active: 0,
      degraded: 0,
      broken: 0,
      recovered: 0,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Start the automatic health checker interval.
 * Safe to call multiple times — only starts once per process via global flag.
 */
export function startAutoHealthChecker() {
  if (global.__freetv_health_checker_started) {
    return; // Already running in this process
  }

  global.__freetv_health_checker_started = true;

  console.log("[AutoHealthChecker] ✦ Automatic health checker ACTIVATED (every 20 minutes)");

  // Run first check after 30 seconds (give server time to fully start)
  setTimeout(() => {
    runAutoHealthCheck();
  }, 30_000);

  // Then schedule every 20 minutes
  global.__freetv_health_checker_interval = setInterval(() => {
    runAutoHealthCheck();
  }, INTERVAL_MS);

  // Don't let the interval block Node.js from exiting
  if (global.__freetv_health_checker_interval?.unref) {
    global.__freetv_health_checker_interval.unref();
  }
}

/**
 * Get the last health check timestamp
 */
export function getLastHealthCheckTime(): string | null {
  return global.__freetv_last_health_check || null;
}

/**
 * Manually trigger a health check (for admin API)
 */
export { runAutoHealthCheck };
