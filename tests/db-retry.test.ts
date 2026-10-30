/**
 * Tests for the site's database connection (`lib/db.ts`).
 *
 * Run with `npm run test:db-retry`. No database is involved: `mongoose.connect` is
 * replaced with one that answers the way a name that blinked answers, so the rule being
 * executed is the rule a deployment runs when Atlas's name fails to resolve once.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

// The URI is read once, when the module loads, so it has to be in place before that.
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/does-not-exist";
delete process.env.VERCEL;

type Mongoose = typeof import("mongoose");
const mongoose: Mongoose = require("mongoose");
const { connectToDatabase } = require("../lib/db");

/** The cache the module keeps, reached through the global it shares. */
function cache() {
  const slot = (globalThis as any).mongooseCache;
  return {
    reset() {
      slot.conn = null;
      slot.promise = null;
      slot.lastFailureAt = 0;
    },
    slot,
  };
}

/** A connection that looks live to the module. */
function liveConnection() {
  return { connection: { readyState: 1 } } as unknown as Mongoose;
}

const originalConnect = mongoose.connect;
let attempts = 0;

/** Makes every attempt fail the way a name that cannot be resolved fails. */
function failFast(reason = "getaddrinfo ENOTFOUND cluster0.example.net") {
  attempts = 0;
  (mongoose as any).connect = async () => {
    attempts += 1;
    throw new Error(reason);
  };
}

/** Makes the first attempt fail and the second succeed. */
function failThenSucceed() {
  attempts = 0;
  (mongoose as any).connect = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("getaddrinfo ENOTFOUND cluster0.example.net");
    return liveConnection();
  };
}

beforeEach(() => {
  cache().reset();
});

afterEach(() => {
  (mongoose as any).connect = originalConnect;
  cache().reset();
});

test("a connection that blinked once is tried again, and the caller gets the database", async () => {
  failThenSucceed();

  const conn = await connectToDatabase();

  assert.ok(conn, "the second attempt must hand back a connection");
  assert.equal(attempts, 2, "the first failure must be followed by another attempt");
});

test("a connection that fails every time is reported as unavailable, not as a crash", async () => {
  failFast();

  const conn = await connectToDatabase();

  assert.equal(conn, null, "a database that is not there is not an exception");
  assert.equal(attempts, 2, "the attempt is made twice and then given up on");
});

test("a failure that was slow is not tried again", async () => {
  // The cluster is unreachable rather than unlucky, and the function's own budget is
  // short: a second attempt would only make the answer later.
  attempts = 0;
  (mongoose as any).connect = async () => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    throw new Error("server selection timed out");
  };

  const conn = await connectToDatabase();

  assert.equal(conn, null);
  assert.equal(attempts, 1, "a slow failure must not be repeated");
});

test("after a failure the next caller waits instead of trying again straight away", async () => {
  failFast();
  assert.equal(await connectToDatabase(), null);

  attempts = 0;
  (mongoose as any).connect = async () => {
    attempts += 1;
    return liveConnection();
  };

  const conn = await connectToDatabase();

  assert.equal(conn, null, "the cooling-off is still in force");
  assert.equal(attempts, 0, "no attempt is made while the cooling-off lasts");
});

test("a site with no URI never attempts a connection", async () => {
  const saved = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;

  // The URI is read when the module loads, so this case loads it again with the URI
  // already gone.
  const modulePath = require.resolve("../lib/db");
  delete require.cache[modulePath];
  const fresh = require("../lib/db");

  attempts = 0;
  (mongoose as any).connect = async () => {
    attempts += 1;
    return liveConnection();
  };

  try {
    const conn = await fresh.connectToDatabase();
    assert.equal(conn, null, "a site with no URI has no database");
    assert.equal(attempts, 0, "nothing is attempted when there is no URI to attempt with");
  } finally {
    process.env.MONGODB_URI = saved;
    delete require.cache[modulePath];
    require("../lib/db");
  }
});
