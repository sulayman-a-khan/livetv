/**
 * Tests for the fixture store's database half (`lib/fixtureStore.ts`).
 *
 * Run with `npm run test:fixture-store`.
 *
 * The cards live in MongoDB and nowhere else, so what is checked here is the code that writes
 * and reads them there: a card is created, read back, edited and deleted, and every one of
 * those answers from the database rather than from a file. The database itself is stood in for
 * (`tests/helpers/fakeFixtureModel.ts`) because no cluster is reachable from a test run — the
 * store's own calls and the shapes it asks for are what is under test.
 *
 * Nothing here reaches the network, and nothing is written to this project's `data/` directory.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
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

const projectCwd = process.cwd();
const projectStoreFiles = {
  premium: path.join(projectCwd, "data", "premium-store.json"),
  catalogue: path.join(projectCwd, "data", "store.json"),
};
const existedBefore = {
  premium: fs.existsSync(projectStoreFiles.premium),
  catalogue: fs.existsSync(projectStoreFiles.catalogue),
};

delete process.env.MONGODB_URI;
delete process.env.VERCEL;

const PINNED = "6ab5c72de29c995275489e5c";
const UNPINNED = "6ab5c72de29c995275489e5d";

const { installFakeDatabase } = require("./helpers/fakeFixtureModel") as typeof import("./helpers/fakeFixtureModel");

const db = installFakeDatabase({
  channels: [
    {
      _id: PINNED,
      name: "Pinned Sports One",
      normalizedName: "pinned-sports-one",
      logo: "",
      category: "Sports",
      isPinned: true,
      priorityOrder: 3,
    },
    {
      _id: UNPINNED,
      name: "Hidden Sports Two",
      normalizedName: "hidden-sports-two",
      logo: "",
      category: "Sports",
      isPinned: false,
      priorityOrder: 1,
    },
  ],
});

type FixtureStore = typeof import("../lib/fixtureStore");
const store: FixtureStore = require("../lib/fixtureStore");

after(() => {
  db.restore();
});

const FIXTURE_INPUT = {
  title: "Mohammedan v Bashundhara",
  sport: "football" as const,
  teamA: "Mohammedan",
  teamB: "Bashundhara",
  teamALogo: "",
  teamBLogo: "",
  competition: "BPL",
  startsAt: new Date("2026-11-05T16:00:00.000Z"),
  durationMinutes: 120,
  channels: [{ channelId: PINNED, sourceType: "direct" as const }],
  visible: false,
};

test("a card is written to the database and read back from it", async () => {
  const created = await store.createFixture(FIXTURE_INPUT);

  // The row is in the database, not in a file: the store's own table is the only copy there is.
  assert.equal(db.fixtures.length, 1);
  assert.equal(db.fixtures[0].teamA, "Mohammedan");
  assert.equal(db.fixtures[0].visible, false);
  // A new card starts unpublished, so an entered match cannot reach the homepage on its own.
  assert.equal(created.visible, false);

  const read = await store.getFixture(created._id);
  assert.ok(read, "the card has to be readable by its own id");
  assert.equal(read.title, "Mohammedan v Bashundhara");
  assert.equal(read.teamA, "Mohammedan");
  assert.equal(read.teamB, "Bashundhara");
  assert.equal(read.competition, "BPL");
  assert.equal(read.durationMinutes, 120);
  assert.deepEqual(read.channels, [{ channelId: PINNED, sourceType: "direct" }]);
  // The phase is derived from the clock, so the admin sees the badge the card would show.
  assert.equal(read.phase, "upcoming");

  const all = await store.listFixtures();
  assert.equal(all.length, 1);
  assert.equal(all[0]._id, created._id);
});

test("an edit changes only what was sent, and the list order is the admin's", async () => {
  const created = await store.createFixture({
    ...FIXTURE_INPUT,
    title: "One v Two",
    teamA: "One",
    teamB: "Two",
    channels: [
      { channelId: PINNED, sourceType: "direct" },
      { channelId: UNPINNED, sourceType: "direct" },
    ],
  });

  // The order is the admin's, not the store's: it is the order the card tries its channels in
  // and the order a fallback moves through, so nothing may sort it on the way in.
  assert.deepEqual(created.channels, [
    { channelId: PINNED, sourceType: "direct" },
    { channelId: UNPINNED, sourceType: "direct" },
  ]);

  const published = await store.updateFixture(created._id, { visible: true });
  assert.ok(published);
  // A single switch flip must never re-ask for the rest of the card.
  assert.equal(published.visible, true);
  assert.equal(published.title, "One v Two");
  assert.equal(published.teamA, "One");
  assert.equal(published.durationMinutes, 120);

  const removed = await store.updateFixture(created._id, { channels: [] });
  assert.deepEqual(removed?.channels, []);
  assert.equal(removed?.visible, true);
});

test("a card that is not there is not found", async () => {
  assert.equal(await store.getFixture("64b5c72de29c995275489ffff"), null);
  // An id that is not a card id is answered without a question, rather than by a cast error.
  assert.equal(await store.getFixture("not-an-id"), null);
  assert.equal(await store.updateFixture("not-an-id", { visible: true }), null);
  assert.equal(await store.deleteFixture("not-an-id"), false);
});

test("a card is deleted from the database", async () => {
  const created = await store.createFixture({ ...FIXTURE_INPUT, title: "Gone v Away" });
  const before = (await store.listFixtures()).length;

  assert.equal(await store.deleteFixture(created._id), true);
  assert.equal((await store.listFixtures()).length, before - 1);
  assert.equal(await store.getFixture(created._id), null);
  // Deleting a card that is not there reports the truth rather than pretending.
  assert.equal(await store.deleteFixture(created._id), false);
});

test("a row written in the old single-channel shape still reads as a linked card", async () => {
  // Rows written before a card could name several channels carry `premiumChannelId` and no
  // list. Reading one has to answer with the link it actually recorded, because an admin's
  // existing board is the data this change must not lose.
  db.fixtures.push({
    _id: "64b5c72de29c995275489eaa",
    title: "Legacy v Old",
    sport: "football",
    teamA: "Legacy",
    teamB: "Old",
    teamALogo: "",
    teamBLogo: "",
    competition: "Old Cup",
    startsAt: new Date("2026-11-05T16:00:00.000Z"),
    durationMinutes: 120,
    premiumChannelId: "pc_legacy",
    visible: true,
  });

  const legacy = await store.getFixture("64b5c72de29c995275489eaa");
  assert.ok(legacy);
  assert.equal(legacy.teamA, "Legacy");
  assert.deepEqual(legacy.channels, [{ channelId: "pc_legacy", sourceType: "secured" }]);

  // A row that recorded nothing links to nothing: an absent field is not read as a guess.
  db.fixtures.push({
    _id: "64b5c72de29c995275489ebb",
    sport: "football",
    teamA: "Bare",
    teamB: "Row",
    startsAt: new Date("2026-11-05T16:00:00.000Z"),
    durationMinutes: 120,
    visible: true,
  });
  const bare = await store.getFixture("64b5c72de29c995275489ebb");
  assert.deepEqual(bare?.channels, []);
});

test("editing a card's channels clears the single-column link it may still carry", async () => {
  db.fixtures.push({
    _id: "64b5c72de29c995275489ecc",
    sport: "football",
    teamA: "Edited",
    teamB: "Card",
    startsAt: new Date("2026-11-05T16:00:00.000Z"),
    durationMinutes: 120,
    premiumChannelId: "pc_legacy",
    visible: true,
  });

  const edited = await store.updateFixture("64b5c72de29c995275489ecc", {
    channels: [{ channelId: PINNED, sourceType: "direct" }],
  });

  assert.deepEqual(edited?.channels, [{ channelId: PINNED, sourceType: "direct" }]);
  // The cleared column survives a re-read: without it, the old link would come back the next
  // time the board was loaded.
  const stored = db.fixtures.find((row) => row._id === "64b5c72de29c995275489ecc");
  assert.equal(stored?.premiumChannelId, null);
  assert.deepEqual((await store.getFixture("64b5c72de29c995275489ecc"))?.channels, [
    { channelId: PINNED, sourceType: "direct" },
  ]);
});

test("linking a card to a catalogue channel changes nothing about that channel", async () => {
  const before = JSON.stringify(db.channels);

  const created = await store.createFixture(FIXTURE_INPUT);
  await store.updateFixture(created._id, {
    channels: [
      { channelId: PINNED, sourceType: "direct" },
      { channelId: UNPINNED, sourceType: "direct" },
    ],
  });
  await store.deleteFixture(created._id);

  // Channels, links, pin state, priority: not one field moved, through the whole life of a
  // card that named two of them.
  assert.equal(JSON.stringify(db.channels), before);
});

test("a process with no database refuses to answer with an empty board", async () => {
  // The store has no local copy, so a read that could not happen is not the same answer as a
  // board with nothing on it. Refusing is the only honest one.
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

    await assert.rejects(() => store.listFixtures(), refused("the match board could not be read"));
    await assert.rejects(
      () => store.getFixture("64b5c72de29c995275489e5c"),
      refused("the match board could not be read")
    );
    await assert.rejects(() => store.createFixture(FIXTURE_INPUT), refused("nothing was saved"));
    await assert.rejects(
      () => store.updateFixture("64b5c72de29c995275489e5c", { visible: true }),
      refused("nothing was saved")
    );
    await assert.rejects(
      () => store.deleteFixture("64b5c72de29c995275489e5c"),
      refused("nothing was deleted")
    );
  } finally {
    dbModule.connectToDatabase = originalConnect;
  }
});

test("the cards are not in any local file", async () => {
  // A card that lived in a developer's file and a board that read the database would be two
  // different boards, and the admin would be editing one and publishing the other.
  assert.equal(fs.existsSync(path.join(projectCwd, "data", "fixtures.json")), false);
  assert.equal(fs.existsSync(path.join(projectCwd, "data", "premium-store.json")), existedBefore.premium);
  assert.equal(fs.existsSync(path.join(projectCwd, "data", "store.json")), existedBefore.catalogue);
});
