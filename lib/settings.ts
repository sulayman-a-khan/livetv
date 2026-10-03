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
