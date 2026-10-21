import mongoose from "mongoose";
import { NextResponse } from "next/server";

const MONGODB_URI = process.env.MONGODB_URI;

// Skip retrying immediately after a failed connection attempt so a MongoDB
// outage doesn't cost every single request its own full timeout — during the
// cooldown `connectToDatabase` returns null instantly instead of waiting, and
// the caller decides what a null connection means for its route (see
// `databaseUnavailable`). On Vercel serverless each cold start is a fresh
// process, so keep it short.
const RETRY_COOLDOWN_MS = process.env.VERCEL ? 2_000 : 10_000;

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  lastFailureAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var mongooseCache: MongooseCache | undefined;
}

const cached: MongooseCache = global.mongooseCache || { conn: null, promise: null, lastFailureAt: 0 };

if (!global.mongooseCache) {
  global.mongooseCache = cached;
}

/**
 * Connects to MongoDB with a short connection timeout.
 * If MongoDB is not running/reachable, catches the error and returns null
 * so API routes seamlessly switch to the in-memory data store. On a deployment
 * that switch is not seamless — see `mustUseDatabase`.
 */
export async function connectToDatabase(): Promise<typeof mongoose | null> {
  if (cached.conn && cached.conn.connection && cached.conn.connection.readyState === 1) {
    return cached.conn;
  }

  // Still cooling down after a recent failure — skip the wait, use fallback.
  if (!cached.promise && Date.now() - cached.lastFailureAt < RETRY_COOLDOWN_MS) {
    return null;
  }

  try {
    // Reuse any in-flight connection attempt instead of firing a new
    // mongoose.connect() for every concurrent request (previously every
    // simultaneous caller started its own redundant connection attempt).
    if (!cached.promise) {
      if (!MONGODB_URI) return null;
      const opts: mongoose.ConnectOptions = {
        bufferCommands: false,
        // Vercel cold starts need a little extra time to resolve DNS and connect
        serverSelectionTimeoutMS: process.env.VERCEL ? 8000 : 5000,
        dbName: "freetv",
      };
      cached.promise = mongoose.connect(MONGODB_URI, opts);
    }

    cached.conn = await cached.promise;
    if (cached.conn && cached.conn.connection && cached.conn.connection.readyState === 1) {
      return cached.conn;
    }
    cached.promise = null;
    cached.lastFailureAt = Date.now();
    return null;
  } catch (e: any) {
    cached.promise = null;
    cached.conn = null;
    cached.lastFailureAt = Date.now();
    // Return null so inMemoryDb is used smoothly
    return null;
  }
}

/**
 * Whether this process may treat the in-memory store as its catalogue.
 *
 * `data/store.json` is developer data and is never deployed, so on Vercel the
 * store is the seed catalogue — a handful of demo channels, none of them
 * pinned. Falling back there is not a degraded view of the real data, it is a
 * different dataset answering confidently: the watch page reports a live
 * channel as missing, an admin action claims a change that dies with the
 * lambda, and a health pass probes links that belong to no viewer. Off Vercel
 * the same fallback is the entire point of running locally, so only a
 * deployment is required to have a database.
 */
export function mustUseDatabase(): boolean {
  return Boolean(process.env.VERCEL);
}

/**
 * The response a route should return instead of reaching for the in-memory
 * store: 503 so a client can retry, `no-store` so the edge cannot freeze the
 * outage into 30 seconds of an empty-looking site. Returns null when the caller
 * should continue — the database answered, or this is a local run.
 */
export function databaseUnavailable(
  conn: typeof mongoose | null,
  error: string
): NextResponse | null {
  if (conn || !mustUseDatabase()) return null;
  return NextResponse.json(
    { success: false, error },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  );
}
