/**
 * FreeTV Background Stream Health Checker & 72-Hour Auto-Cleaner Worker
 * 
 * Usage:
 *   node scripts/health-checker.js
 * Or run via cron job every 15-30 minutes.
 */

require("dotenv").config({ path: ".env.local" });
const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/freetv";

const StreamLinkSchema = new mongoose.Schema(
  {
    channelId: { type: mongoose.Schema.Types.ObjectId, ref: "Channel", required: true },
    url: { type: String, required: true },
    priority: { type: Number, default: 1 },
    status: { type: String, enum: ["active", "degraded", "broken"], default: "active" },
    failedAttempts: { type: Number, default: 0 },
    firstFailedAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    latency: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const StreamLink = mongoose.models.StreamLink || mongoose.model("StreamLink", StreamLinkSchema);

async function probeStreamUrl(url, timeoutMs = 5000) {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        Range: "bytes=0-4096",
      },
    });

    clearTimeout(timeoutId);
    const latency = Date.now() - start;

    if (!response.ok && response.status !== 206) {
      return { ok: false, latency, reason: `HTTP status ${response.status}` };
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const textSnippet = (await response.text()).slice(0, 2048).toLowerCase();

    // 1. Explicit HTML document rejection (error pages returned as 200 OK)
    if (
      contentType.includes("text/html") ||
      textSnippet.includes("<!doctype html") ||
      textSnippet.includes("<html") ||
      textSnippet.includes("<head") ||
      textSnippet.includes("access denied") ||
      textSnippet.includes("404 not found") ||
      textSnippet.includes("cloudflare") ||
      textSnippet.includes("error 404") ||
      textSnippet.includes("stream offline") ||
      textSnippet.includes("forbidden")
    ) {
      return { ok: false, latency, reason: "Returned HTML error page" };
    }

    // 2. Positive check for HLS manifest tags or media headers
    const hasHlsTag =
      textSnippet.includes("#extm3u") ||
      textSnippet.includes("#ext-x-") ||
      textSnippet.includes("#extinf") ||
      textSnippet.includes("#ext-x-stream-inf");

    const isMediaContentType =
      contentType.includes("mpegurl") ||
      contentType.includes("video/") ||
      contentType.includes("audio/") ||
      contentType.includes("octet-stream") ||
      contentType.includes("application/x-mpegurl") ||
      contentType.includes("application/vnd.apple.mpegurl");

    const hasStreamExtension = url.includes(".m3u8") || url.includes(".ts") || url.includes(".mpd");

    // A content-type or .m3u8 suffix is not proof of a playable stream: many
    // dead providers return an error payload with one of those properties.
    // Only accept an actual HLS manifest marker here. The app checker performs
    // the deeper playlist/segment validation before it can promote a link.
    if (hasHlsTag) {
      return { ok: true, latency };
    }

    return { ok: false, latency, reason: "Unrecognized stream format" };
  } catch (err) {
    clearTimeout(timeoutId);
    return { ok: false, latency: 0, reason: err.message || "Timeout/Network error" };
  }
}

async function runHealthChecker() {
  console.log("==========================================");
  console.log(`[Worker] Starting Health Checker Batch at ${new Date().toISOString()}`);
  console.log("==========================================");

  try {
    try {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 2000 });
      console.log("[Worker] Database connected successfully.");
    } catch (dbErr) {
      console.warn(`[Worker Warning] Local MongoDB connection unavailable (${dbErr.message}). In-memory mode stores channel state dynamically.`);
      return;
    }

    const BATCH_SIZE = 30;
    const THREE_DAYS_MS = 72 * 60 * 60 * 1000;
    const now = new Date();

    const streamsToTest = await StreamLink.find()
      .sort({ lastCheckedAt: 1 })
      .limit(BATCH_SIZE);

    if (streamsToTest.length === 0) {
      console.log("[Worker] No stream links found to test.");
      await mongoose.disconnect();
      return;
    }

    console.log(`[Worker] Testing batch of ${streamsToTest.length} stream links...`);

    let activeCount = 0;
    let degradedCount = 0;
    let brokenCount = 0;
    let deletedCount = 0;

    for (const stream of streamsToTest) {
      process.stdout.write(` -> Probing ID ${stream._id} (${stream.url.substring(0, 40)}...): `);

      const result = await probeStreamUrl(stream.url);

      if (result.ok) {
        stream.status = "active";
        stream.latency = result.latency;
        stream.failedAttempts = 0;
        stream.firstFailedAt = null;
        stream.lastCheckedAt = now;
        await stream.save();
        activeCount++;
        console.log(`[OK] (${result.latency}ms) -> ACTIVE`);
      } else {
        stream.failedAttempts = (stream.failedAttempts || 0) + 1;
        if (!stream.firstFailedAt) {
          stream.firstFailedAt = now;
        }
        stream.lastCheckedAt = now;

        const failureDuration = now.getTime() - new Date(stream.firstFailedAt).getTime();
        const failureHours = (failureDuration / (1000 * 60 * 60)).toFixed(1);

        if (failureDuration > THREE_DAYS_MS) {
          // Permanently DELETE link broken for > 72 hours
          await StreamLink.findByIdAndDelete(stream._id);
          deletedCount++;
          console.log(`[FAILED] (${failureHours}h dead) -> PERMANENTLY DELETED (72h rule)`);
        } else if (stream.failedAttempts >= 3) {
          stream.status = "broken";
          await stream.save();
          brokenCount++;
          console.log(`[FAILED] (${stream.failedAttempts} fails, reason: ${result.reason}) -> BROKEN`);
        } else {
          // Keep a previously verified stream visible during a short failure streak.
          stream.status = stream.status === "active" ? "active" : "degraded";
          await stream.save();
          degradedCount++;
          console.log(`[FAILED] (${stream.failedAttempts} fails, reason: ${result.reason}) -> DEGRADED`);
        }
      }
    }

    console.log("\n[Worker] Batch Health Check Summary:");
    console.log(` Total Batch Tested: ${streamsToTest.length}`);
    console.log(` Active Links:       ${activeCount}`);
    console.log(` Degraded Links:     ${degradedCount}`);
    console.log(` Broken Links:       ${brokenCount}`);
    console.log(` Auto-Deleted (>72h):${deletedCount}`);
    console.log("==========================================\n");

    await mongoose.disconnect();
  } catch (err) {
    console.error("[Worker] Fatal error running health check:", err);
    process.exit(1);
  }
}

runHealthChecker();
