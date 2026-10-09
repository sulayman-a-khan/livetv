import { connectToDatabase } from "@/lib/db";
import Setting from "@/models/Setting";

let cachedStreamBaseUrl: string | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5000; // 5-second in-memory cache for high throughput

/**
 * Fetches the active dynamic Stream Base URL from MongoDB Atlas (settings collection).
 * If MongoDB is not reachable or no setting is stored, falls back to environment variables.
 */
export async function getDynamicStreamBaseUrl(): Promise<string> {
  const now = Date.now();
  if (cachedStreamBaseUrl !== null && now < cacheExpiry) {
    return cachedStreamBaseUrl;
  }

  let dbUrl = "";
  try {
    const conn = await connectToDatabase();
    if (conn) {
      const doc = await Setting.findOne({
        key: { $in: ["streamBaseUrl", "STREAM_BASE_URL", "publicStreamBaseUrl"] },
      }).lean();
      if (doc && typeof doc.value === "string" && doc.value.trim()) {
        dbUrl = doc.value.trim().replace(/\/+$/, "");
      }
    }
  } catch (err) {
    console.warn("[settings] getDynamicStreamBaseUrl error:", err);
  }

  const resolved =
    dbUrl ||
    (process.env.NEXT_PUBLIC_STREAM_BASE_URL || process.env.PUBLIC_STREAM_BASE_URL || "").trim().replace(/\/+$/, "");

  cachedStreamBaseUrl = resolved;
  cacheExpiry = now + CACHE_TTL_MS;
  return resolved;
}

/**
 * Updates the active dynamic Stream Base URL in MongoDB Atlas settings.
 */
export async function setDynamicStreamBaseUrl(newUrl: string): Promise<string> {
  const cleanUrl = newUrl.trim().replace(/\/+$/, "");
  const conn = await connectToDatabase();
  if (!conn) throw new Error("Database unavailable");

  await Setting.updateOne(
    { key: "streamBaseUrl" },
    { $set: { key: "streamBaseUrl", value: cleanUrl, updatedAt: new Date() } },
    { upsert: true }
  );

  cachedStreamBaseUrl = cleanUrl;
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return cleanUrl;
}

const SCHEDULER_HEARTBEAT_KEY = "schedulerHeartbeat";

export interface SchedulerHeartbeat {
  at: string;
  task: string;
  /** Vercel's own scheduler sent this run, rather than an admin secret header. */
  scheduled: boolean;
}

/** Process-local copy for local runs, where there is no database to stamp. */
let localHeartbeat: SchedulerHeartbeat | null = null;

/**
 * Vercel drops a cron invocation without a trace: a 3xx from Deployment
 * Protection ends the job (cron never follows redirects) and a missing
 * `CRON_SECRET` gets a 401, neither of which reaches the cron logs. So a
 * scheduler that has never arrived looks exactly like a health rule that does
 * not work. One document stamped per accepted run is the only in-app proof.
 */
export async function recordSchedulerHeartbeat(task: string, scheduled: boolean): Promise<void> {
  const heartbeat: SchedulerHeartbeat = { at: new Date().toISOString(), task, scheduled };
  localHeartbeat = heartbeat;
  try {
    const conn = await connectToDatabase();
    if (!conn) return;
    await Setting.updateOne(
      { key: SCHEDULER_HEARTBEAT_KEY },
      {
        $set: {
          key: SCHEDULER_HEARTBEAT_KEY,
          value: JSON.stringify(heartbeat),
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.warn("[settings] recordSchedulerHeartbeat error:", err);
  }
}

export async function getSchedulerHeartbeat(): Promise<SchedulerHeartbeat | null> {
  try {
    const conn = await connectToDatabase();
    if (!conn) return localHeartbeat;
    const doc = await Setting.findOne({ key: SCHEDULER_HEARTBEAT_KEY }).lean();
    if (!doc || typeof doc.value !== "string") return null;
    const parsed = JSON.parse(doc.value) as SchedulerHeartbeat;
    return parsed && parsed.at ? parsed : null;
  } catch (err) {
    console.warn("[settings] getSchedulerHeartbeat error:", err);
    return localHeartbeat;
  }
}
