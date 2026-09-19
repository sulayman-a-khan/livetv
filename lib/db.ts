import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/freetv";

// Skip retrying immediately after a failed connection attempt so a MongoDB
// outage doesn't cost every single request its own full 2s timeout — after a
// failure we fall back to in-memory instantly for this long, then try again.
const RETRY_COOLDOWN_MS = 10_000;

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  lastFailureAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var mongooseCache: MongooseCache | undefined;
}

let cached: MongooseCache = global.mongooseCache || { conn: null, promise: null, lastFailureAt: 0 };

if (!global.mongooseCache) {
  global.mongooseCache = cached;
}

/**
 * Connects to MongoDB with a 2-second connection timeout.
 * If MongoDB is not running/reachable, catches the error and returns null
 * so API routes seamlessly switch to the in-memory data store.
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
      const opts = {
        bufferCommands: false,
        serverSelectionTimeoutMS: 2000,
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
