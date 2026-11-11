/**
 * Tests for the saved channel list: the rules a key and a list follow, the store that
 * keeps them, and the route the app reads and writes them through.
 *
 * Run with `npm run test:favourites`.
 *
 * The lists live in MongoDB and nowhere else, so the database is stood in for
 * (`tests/helpers/fakeFavouriteListModel.ts`). Nothing here reaches the network, and
 * nothing is written to this project's `data/` directory.
 *
 * The two rules that matter are that a list is never lost because the site could not be
 * reached, and that a key that is not one the app writes is refused rather than stored.
 */

import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { after, test } from "node:test";

type NodeModuleWithHook = typeof Module & {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};

/**
 * The compiled modules reach their siblings through the app's `@/` alias, which the compiler
 * leaves in the emitted `require`. Point it at the compiled output so the code under test is
 * the real one.
 */
const nodeModule = Module as NodeModuleWithHook;
const originalResolve = nodeModule._resolveFilename;
const compiledRoot = path.resolve(__dirname, "..");
nodeModule._resolveFilename = function resolveAppAlias(request: string, ...rest: unknown[]) {
  if (request.startsWith("@/")) {
    return originalResolve.call(this, path.resolve(compiledRoot, request.slice(2)), ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};

delete process.env.MONGODB_URI;
delete process.env.VERCEL;

const { installFakeFavouriteDatabase } = require("./helpers/fakeFavouriteListModel") as
  typeof import("./helpers/fakeFavouriteListModel");

const db = installFakeFavouriteDatabase();

after(() => {
  db.restore();
});

const {
  isFavouriteKey,
  normaliseFavouriteKey,
  parseFavouriteIds,
} = require("../lib/favourites") as typeof import("../lib/favourites");
const store: typeof import("../lib/favouriteList") = require("../lib/favouriteList");

const { GET, POST } = require("../app/api/app/favourites/route.js") as {
  GET: (req: unknown) => Promise<Response>;
  POST: (req: unknown) => Promise<Response>;
};

/** The route's own answer, as the fields the contract is written in. */
async function read(
  url: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown>; cacheControl: string | null }> {
  const { NextRequest } = require("next/server");
  const request = body
    ? new NextRequest(`http://localhost${url}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    : new NextRequest(`http://localhost${url}`);

  const response = body ? await POST(request) : await GET(request);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    cacheControl: response.headers.get("cache-control"),
  };
}

// --- what a key is ------------------------------------------------------------

test("a key is eight characters of the alphabet that is read right", () => {
  assert.equal(isFavouriteKey("ABCDEFGH"), true);
  // The characters that are read wrong over the phone are not in the alphabet.
  assert.equal(isFavouriteKey("ABCDEFGI"), false);
  assert.equal(isFavouriteKey("ABCDEFGH".replace("H", "0")), false);
  assert.equal(isFavouriteKey("ABCDEFGH".replace("H", "1")), false);
  assert.equal(isFavouriteKey("ABCDEFGH".replace("H", "O")), false);
});

test("a key that is not one is refused", () => {
  assert.equal(isFavouriteKey("short"), false);
  assert.equal(isFavouriteKey("ABCDEFGHI"), false);
  assert.equal(isFavouriteKey("ABCDEFG!"), false);
  assert.equal(isFavouriteKey(""), false);
  assert.equal(isFavouriteKey(undefined), false);
  assert.equal(isFavouriteKey(12345678), false);
});

test("a key is read in either case and with the spaces around it", () => {
  assert.equal(normaliseFavouriteKey(" abcdefgh "), "ABCDEFGH");
  assert.equal(normaliseFavouriteKey("ABCDEFGH"), "ABCDEFGH");
  // A key that is not one is not repaired into one: repairing it would put a
  // viewer's list under a key nobody typed.
  assert.equal(normaliseFavouriteKey("not a key"), "");
  assert.equal(normaliseFavouriteKey("abcdefg!"), "");
});

// --- what a list may hold ------------------------------------------------------

test("a list keeps the order the viewer marked the channels in", () => {
  const parsed = parseFavouriteIds(["c3", "c1", "c2"]);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.ids : [], ["c3", "c1", "c2"]);
});

test("a blank channel is nothing and the same channel twice is one", () => {
  const parsed = parseFavouriteIds(["c1", "", "  ", "c1", " c2 "]);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.ids : [], ["c1", "c2"]);
});

test("a body that is not a list of channels is refused whole", () => {
  assert.equal(parseFavouriteIds("c1").ok, false);
  assert.equal(parseFavouriteIds(undefined).ok, false);
  assert.equal(parseFavouriteIds([1, 2]).ok, false);
  // A channel id long enough to be something other than a channel id is refused,
  // not shortened: half a request is not an answer.
  assert.equal(parseFavouriteIds(["x".repeat(65)]).ok, false);
  // A list longer than a viewer's own picks is a body written by something else.
  assert.equal(parseFavouriteIds(new Array(501).fill("c1")).ok, false);
});

// --- what the store does --------------------------------------------------------

test("a list is written to the database and read back from it", async () => {
  const written = await store.writeFavouriteList("ABCDEFGH", ["c1", "c2"]);

  assert.equal(written.key, "ABCDEFGH");
  assert.deepEqual(written.ids, ["c1", "c2"]);
  assert.ok(written.updatedAt, "the write says when it happened");

  const read = await store.readFavouriteList("ABCDEFGH");
  assert.ok(read);
  assert.deepEqual(read?.ids, ["c1", "c2"]);
});

test("a key that holds no list holds no list", async () => {
  assert.equal(await store.readFavouriteList("ZZZZZZZZ"), null);
});

test("a second write is the whole truth", async () => {
  await store.writeFavouriteList("PUSHEDKY", ["c1", "c2", "c3"]);
  await store.writeFavouriteList("PUSHEDKY", ["c9"]);

  const read = await store.readFavouriteList("PUSHEDKY");
  assert.deepEqual(read?.ids, ["c9"]);
});

test("a process with no database refuses to answer with an empty list", async () => {
  // The store has no local copy, so a read that could not happen is not the same
  // answer as a list that is empty. Refusing is the only honest one.
  const dbModule = require("@/lib/db") as { connectToDatabase: () => Promise<unknown> };
  const originalConnect = dbModule.connectToDatabase;
  dbModule.connectToDatabase = async () => null;

  try {
    const refused = (action: string) => (err: unknown) => {
      const e = err as Error & { status?: number };
      assert.equal(e.status, 503);
      assert.equal(e.message, `Database unavailable — ${action}`);
      return true;
    };

    await assert.rejects(
      () => store.readFavouriteList("ABCDEFGH"),
      refused("the saved list could not be read")
    );
    await assert.rejects(
      () => store.writeFavouriteList("ABCDEFGH", ["c1"]),
      refused("the saved list could not be written")
    );
  } finally {
    dbModule.connectToDatabase = originalConnect;
  }
});

// --- what the route answers -----------------------------------------------------

test("the route answers with the list the site holds under the key", async () => {
  await store.writeFavouriteList("ANSWERED", ["c1", "c2"]);

  const answer = await read("/api/app/favourites?key=ANSWERED");

  assert.equal(answer.status, 200);
  assert.equal(answer.body.success, true);
  assert.deepEqual(answer.body.ids, ["c1", "c2"]);
  // The answer is one viewer's, so it must not be cached by anybody else.
  assert.equal(answer.cacheControl, "no-store");
});

test("a key the site holds no record of is answered with a failure, not with an empty list", async () => {
  const answer = await read("/api/app/favourites?key=ZZZZZZZZ");

  // There is no list under that key. An empty list would be read as "this
  // viewer keeps no channels", and the app would take the list off the device
  // that still has it, so the site says it holds nothing instead.
  assert.equal(answer.status, 404);
  assert.equal(answer.body.success, false);
  assert.equal(answer.body.ids, undefined);
  assert.equal(answer.cacheControl, "no-store");
});

test("a key the site holds an empty list under is answered with an empty list", async () => {
  await store.writeFavouriteList("EMPTYLST", []);

  const answer = await read("/api/app/favourites?key=EMPTYLST");

  // The list is there and it is empty because the viewer emptied it: that is an
  // answer, and it is not the same answer as no list at all.
  assert.equal(answer.status, 200);
  assert.equal(answer.body.success, true);
  assert.deepEqual(answer.body.ids, []);
});

test("a key that is not one is refused and nothing is read", async () => {
  const answer = await read("/api/app/favourites?key=not-a-key");

  assert.equal(answer.status, 400);
  assert.equal(answer.body.success, false);
});

test("a missing key is refused", async () => {
  const answer = await read("/api/app/favourites");

  assert.equal(answer.status, 400);
  assert.equal(answer.body.success, false);
});

test("the app's own key is read the way the app writes it", async () => {
  // The app asks in upper case; the route reads a key that was typed by hand
  // in either case, because a key is read aloud.
  await store.writeFavouriteList("READKEYS", ["c1"]);

  const answer = await read("/api/app/favourites?key=readkeys");

  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.ids, ["c1"]);
});

test("the list the device writes is the list the other device reads", async () => {
  const written = await read("/api/app/favourites", { key: "SYNCKEYS", ids: ["c1", "c2"] });

  assert.equal(written.status, 200);
  assert.equal(written.body.success, true);
  assert.deepEqual(written.body.ids, ["c1", "c2"]);

  const readBack = await read("/api/app/favourites?key=SYNCKEYS");
  assert.deepEqual(readBack.body.ids, ["c1", "c2"]);
});

test("a write that lost the race is landed by the second attempt, not answered as an empty list", async () => {
  // Two devices writing the same key for the first time at the same moment: the
  // second write is refused by the unique index, and the first one has left the
  // row behind. The refused write is made again, and the list lands.
  db.model.failNextWritesWithDuplicateKey(1);

  const answer = await read("/api/app/favourites", { key: "RACEDKEY", ids: ["c1", "c2"] });

  assert.equal(answer.status, 200);
  assert.equal(answer.body.success, true);
  assert.deepEqual(answer.body.ids, ["c1", "c2"]);

  const readBack = await read("/api/app/favourites?key=RACEDKEY");
  assert.equal(readBack.status, 200);
  assert.deepEqual(readBack.body.ids, ["c1", "c2"]);
});

test("a write that is refused twice is answered as a failure, not as an empty list", async () => {
  // The second attempt is refused as well, so nothing was written. Answering
  // with an empty list would tell the app the viewer keeps no channels and
  // would take the list off the device that still has it.
  db.model.failNextWritesWithDuplicateKey(2);

  const answer = await read("/api/app/favourites", { key: "REFUSED2", ids: ["c1"] });

  assert.equal(answer.status, 503);
  assert.equal(answer.body.success, false);
  assert.equal(answer.body.ids, undefined);
  // What failed is said and nothing about the database behind it is.
  assert.equal(answer.body.error, "Failed to save the list");
});

test("a write that is refused writes nothing", async () => {
  const before = db.lists.length;

  const noKey = await read("/api/app/favourites", { ids: ["c1"] });
  assert.equal(noKey.status, 400);

  const badKey = await read("/api/app/favourites", { key: "not a key", ids: ["c1"] });
  assert.equal(badKey.status, 400);

  const noIds = await read("/api/app/favourites", { key: "MARKSKEY" });
  assert.equal(noIds.status, 400);

  assert.equal(db.lists.length, before, "a refused write leaves no row behind");
});

test("a body that is not a list request is refused", async () => {
  const { NextRequest } = require("next/server");
  const request = new NextRequest("http://localhost/api/app/favourites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json at all",
  });

  const response = await POST(request);

  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { success: boolean }).success, false);
});

test("a body larger than a list is refused before it is stored", async () => {
  const { NextRequest } = require("next/server");
  const request = new NextRequest("http://localhost/api/app/favourites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "ZZZZZZZZ", ids: ["x".repeat(70_000)] }),
  });

  const response = await POST(request);

  assert.equal(response.status, 413);
});

test("a site that cannot be reached says so instead of emptying the list", async () => {
  const dbModule = require("@/lib/db") as { connectToDatabase: () => Promise<unknown> };
  const originalConnect = dbModule.connectToDatabase;
  dbModule.connectToDatabase = async () => null;

  try {
    const answer = await read("/api/app/favourites?key=ABCDEFGH");
    assert.equal(answer.status, 503);
    assert.equal(answer.body.success, false);
    // What failed is said and nothing about the database behind it is.
    assert.equal(answer.body.error, "Failed to read the saved list");
  } finally {
    dbModule.connectToDatabase = originalConnect;
  }
});
