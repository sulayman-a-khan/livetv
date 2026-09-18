import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/freetv";

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var mongooseCache: MongooseCache | undefined;
}

let cached: MongooseCache = global.mongooseCache || { conn: null, promise: null };

if (!global.mongooseCache) {
  global.mongooseCache = cached;
}

/**
 * Connects to MongoDB with a 2-second connection timeout.
 * If MongoDB is not running locally, catches the error and returns null
 * so API routes seamlessly switch to the in-memory data store.
 */
export async function connectToDatabase(): Promise<typeof mongoose | null> {
  if (cached.conn && cached.conn.connection && cached.conn.connection.readyState === 1) {
    return cached.conn;
  }

  try {
    const opts = {
      bufferCommands: false,
      serverSelectionTimeoutMS: 2000,
    };

    cached.promise = mongoose.connect(MONGODB_URI, opts);
    cached.conn = await cached.promise;
    if (cached.conn && cached.conn.connection && cached.conn.connection.readyState === 1) {
      return cached.conn;
    }
    return null;
  } catch (e: any) {
    cached.promise = null;
    cached.conn = null;
    // Return null so inMemoryDb is used smoothly
    return null;
  }
}
