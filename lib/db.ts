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

/**
 * How many times a connection is attempted before the caller is told the database is not
 * there.
 *
 * One attempt is not enough: the cluster this site uses resolves through a name that
 * blinks, and a single blink turns a write that was about to succeed into a refusal the
 * operator has to repeat by hand.
 */
const MAX_CONNECT_ATTEMPTS = 2;

/**
 * A failure that took longer than this is not worth a second attempt: the cluster is slow
 * or gone, and the function's own budget is short. A failure that was quick means the name
 * or the socket blinked, and a second attempt costs a moment and usually succeeds.
 */
const RETRY_BUDGET_MS = 2_500;
const RETRY_DELAY_MS = 250;

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

  if (!MONGODB_URI) return null;

  const opts: mongoose.ConnectOptions = {
    bufferCommands: false,
    // Vercel cold starts need a little extra time to resolve DNS and connect
    serverSelectionTimeoutMS: process.env.VERCEL ? 8000 : 5000,
    dbName: "freetv",
  };

  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    try {
      // Reuse any in-flight connection attempt instead of firing a new
      // mongoose.connect() for every concurrent request (previously every
      // simultaneous caller started its own redundant connection attempt).
      if (!cached.promise) {
        cached.promise = mongoose.connect(MONGODB_URI, opts);
      }

      cached.conn = await cached.promise;
      if (cached.conn && cached.conn.connection && cached.conn.connection.readyState === 1) {
        return cached.conn;
      }
      cached.promise = null;
    } catch (e: any) {
      cached.promise = null;
      cached.conn = null;
    }

    // A failure that was slow means the cluster is unreachable rather than unlucky, and a
    // second attempt would only spend the time the function has left. A failure that was
    // quick means the name or the socket blinked — and a second attempt is worth making,
    // because the write the caller came here for is not the caller's fault.
    const spent = Date.now() - startedAt;
    if (attempt >= MAX_CONNECT_ATTEMPTS || spent > RETRY_BUDGET_MS) {
      cached.lastFailureAt = Date.now();
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }

  cached.lastFailureAt = Date.now();
  return null;
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
 * Refuse a write that has nowhere to persist.
 *
 * Some stores have a local file to fall back on and some do not. A tier with a file can
 * answer a write off a developer machine and only has to refuse on a deployment, where
 * the file cannot be written to (`mustUseDatabase`); a tier whose rows live only in
 * MongoDB has nowhere to answer from at all, so it refuses wherever the database is not
 * there.
 *
 * The thrown `status` is what every one of these routes' own `fail()` already maps into
 * its response, so the refusal arrives as a 503 carrying this sentence.
 */
export function requireDatabase(conn: typeof mongoose | null, action: string): void {
  if (conn) return;
  throw Object.assign(new Error(`Database unavailable — ${action}`), { status: 503 });
}

/**
 * Refuse a write that has nowhere to persist, on a deployment only.
 *
 * This tier's local store is developer data: on a deployment there is no
 * `data/premium-store.json` to fall back to, and the filesystem cannot be written
 * to, so an accepted create would be answered with a fresh id and then lost when
 * the lambda cooled down — the panel would show a row that no viewer's request can
 * ever read back, and an accepted delete would report a row gone that is still on
 * air. Off a deployment the same fallback is the entire point of running locally,
 * so only a deployment is required to have a database (see `mustUseDatabase`).
 *
 * Reads are deliberately not guarded: a list that answers from an empty local tier
 * advertises nothing, and the admin routes already report which store they read
 * from (`dbMode`). A 503 there would turn a database blip into a blank panel with
 * less evidence, not more.
 */
export function requirePersistingStore(conn: typeof mongoose | null, action: string): void {
  if (conn || !mustUseDatabase()) return;
  throw Object.assign(new Error(`Database unavailable — ${action}`), { status: 503 });
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
