/**
 * Regression tests for the one door a fixture card has to the Direct HLS catalogue
 * (`lib/fixtureSources.ts`).
 *
 * Run with `npm run test:fixture-sources`. It compiles the real module, the premium store and
 * the catalogue's own local store into `.tmp-tests/` and runs them with no database reachable,
 * so the branch under test is the one a local run takes. The catalogue is seeded from a file
 * this test writes into a temporary directory: nothing here reads or rewrites this project's
 * own `data/`.
 *
 * The point of the file is the promise the Direct HLS system is protected by: a fixture may
 * name a direct channel, and naming it must not be able to change it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

type NodeModuleWithHook = typeof Module & {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};

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
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "freetv-fixture-sources-"));
const projectStoreFiles = {
  premium: path.join(projectCwd, "data", "premium-store.json"),
  catalogue: path.join(projectCwd, "data", "store.json"),
};
const existedBefore = {
  premium: fs.existsSync(projectStoreFiles.premium),
  catalogue: fs.existsSync(projectStoreFiles.catalogue),
};

process.chdir(sandbox);
delete process.env.MONGODB_URI;
delete process.env.VERCEL;

/** Two rows of the catalogue, in the shape the catalogue's own store file keeps. */
const STAMPED_AT = new Date("2026-10-24T09:00:00.000Z").toISOString();
const PINNED = {
  _id: "6ab5c72de29c995275489e5c",
  name: "Pinned Sports One",
  normalizedName: "pinned-sports-one",
  logo: "",
  category: "Sports",
  isPinned: true,
  priorityOrder: 3,
  createdAt: STAMPED_AT,
  updatedAt: STAMPED_AT,
};
const UNPINNED = {
  _id: "6ab5c72de29c995275489e5d",
  name: "Hidden Sports Two",
  normalizedName: "hidden-sports-two",
  logo: "",
  category: "Sports",
  isPinned: false,
  priorityOrder: 1,
  createdAt: STAMPED_AT,
  updatedAt: STAMPED_AT,
};

const catalogueFile = path.join(sandbox, "data", "store.json");
fs.mkdirSync(path.dirname(catalogueFile), { recursive: true });
fs.writeFileSync(
  catalogueFile,
  JSON.stringify({
    channels: [PINNED, UNPINNED],
    streams: [
      {
        _id: "6ab5c72de29c995275489e60",
        channelId: PINNED._id,
        url: "https://origin.example/pinned/index.m3u8",
        priority: 1,
        status: "active",
        failedAttempts: 0,
        firstFailedAt: null,
        lastCheckedAt: null,
        latency: 40,
        createdAt: STAMPED_AT,
        updatedAt: STAMPED_AT,
      },
    ],
  }),
  "utf-8"
);

type FixtureSources = typeof import("../lib/fixtureSources");
type PremiumStore = typeof import("../lib/premiumStore");
type InMemoryStore = typeof import("../lib/inMemoryStore");

const sources: FixtureSources = require("../lib/fixtureSources");
const store: PremiumStore = require("../lib/premiumStore");
const { inMemoryDb }: InMemoryStore = require("../lib/inMemoryStore");

after(() => {
  process.chdir(projectCwd);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** The catalogue exactly as it stands, so a later comparison means "not one field moved". */
const catalogueSnapshot = () => JSON.stringify(inMemoryDb.getChannels()) + JSON.stringify(inMemoryDb.getStreams());

test("the direct list an editor offers is the public catalogue, and only its names", async () => {
  const options = await sources.listDirectChannelOptions();

  // An unpinned channel exists in the database and in the admin dashboard, and the public
  // catalogue deliberately does not show it. A card that linked one would advertise a channel
  // the app keeps off screen, so it is not offered here either.
  assert.deepEqual(
    options.map((option) => option.channelId),
    [PINNED._id]
  );
  assert.equal(options[0].sourceType, "direct");
  assert.equal(options[0].name, "Pinned Sports One");

  // A reference is an id and a source. Nothing about how a direct channel is delivered has any
  // business being in the list a fixture editor builds references from.
  assert.deepEqual(Object.keys(options[0]).sort(), ["category", "channelId", "logoUrl", "name", "sourceType"]);
  const printed = JSON.stringify(options);
  assert.equal(printed.includes("origin.example"), false);
  assert.equal(printed.includes("m3u8"), false);
});

test("a board's links are resolved in one read, and by both facts that matter", async () => {
  const rows = await sources.listDirectChannelsByIds([
    PINNED._id,
    UNPINNED._id,
    "6ab5c72de29c995275489e5e",
    "not even an id",
  ]);

  // The pinned one and the unpinned one both come back, because they are both channels and the card
  // has to say different things about them. The two ids with no row behind them come back as
  // absence, which is the board's stale-link case — and an id this tier cannot hold is not sent to
  // the database to find that out.
  assert.deepEqual(
    rows.map((row) => `${row._id}/${row.listed}`),
    [`${PINNED._id}/true`, `${UNPINNED._id}/false`]
  );
  assert.equal(rows[0].name, "Pinned Sports One");

  // Five fields, all of them names: a board read that pulled a stream url or a probe bookkeeping
  // field would be a wider door than a match card has any use for.
  assert.deepEqual(Object.keys(rows[0]).sort(), ["_id", "category", "listed", "logoUrl", "name"]);
  const printed = JSON.stringify(rows);
  assert.equal(printed.includes("origin.example"), false);
  assert.equal(printed.includes("m3u8"), false);

  // An empty list asks nothing at all, so a board of premium-only cards costs no catalogue read.
  assert.deepEqual(await sources.listDirectChannelsByIds([]), []);
});

test("resolving a hundred links is one read, not a hundred", async () => {
  const before = catalogueSnapshot();
  const listChannels = inMemoryDb.getChannels.bind(inMemoryDb);
  let reads = 0;
  // Counted at the store, which is where a per-reference query would show up: the whole batch is
  // resolved by one call however many ids it names, and the ids nobody has a row for are answered
  // by absence rather than by another question.
  (inMemoryDb as unknown as { getChannels: () => unknown[] }).getChannels = () => {
    reads += 1;
    return listChannels();
  };

  try {
    const ids = [
      PINNED._id,
      UNPINNED._id,
      "6ab5c72de29c995275489e5e",
      ...Array.from({ length: 100 }, (_, i) => `6ab5c72de29c995275489e${String(i).padStart(2, "0")}`),
    ];
    const rows = await sources.listDirectChannelsByIds(ids);
    assert.equal(reads, 1, "one batch read for the whole set");
    assert.deepEqual(rows.map((row) => row._id), [PINNED._id, UNPINNED._id]);
  } finally {
    (inMemoryDb as unknown as { getChannels: () => unknown[] }).getChannels = listChannels;
  }

  assert.equal(catalogueSnapshot(), before);
});

test("a direct channel is offered only when the catalogue is showing it", async () => {
  const mixed = await sources.unknownFixtureRefs([
    { channelId: PINNED._id, sourceType: "direct" },
    { channelId: UNPINNED._id, sourceType: "direct" },
  ]);

  // The unpinned row is refused on the way in, and the reason is the true one: the channel exists
  // and is not being shown. Telling an admin it is "not a channel" would send them looking for a
  // row that is on their own dashboard.
  assert.deepEqual(
    mixed.map(({ ref, reason }) => `${ref.channelId}/${reason}`),
    [`${UNPINNED._id}/is not on the public channel list`]
  );

  // An empty list asks nothing at all, so a card with no links costs no query.
  assert.deepEqual(await sources.unknownFixtureRefs([]), []);
});

test("a mixed list is checked against each tier it names", async () => {
  const channel = await store.createPremiumChannel({
    name: "Example Sports HD",
    category: "Premium",
    logoUrl: "",
    active: true,
    sortOrder: 99,
    note: "",
    proxyChannelKey: "",
  });

  const valid = [
    { channelId: PINNED._id, sourceType: "direct" as const },
    { channelId: channel._id, sourceType: "secured" as const },
  ];
  assert.deepEqual(await sources.unknownFixtureRefs(valid), []);

  const broken = [
    { channelId: PINNED._id, sourceType: "direct" as const },
    { channelId: "pc_ghost", sourceType: "secured" as const },
    { channelId: UNPINNED._id, sourceType: "direct" as const },
  ];
  const unknown = await sources.unknownFixtureRefs(broken);

  // Every mistake in one answer, and each one says which tier it was looked for in — an id that
  // exists in the catalogue is still an unknown *secured* channel, and the admin has to be told
  // that rather than that the channel does not exist. The unpinned direct row is refused too, but
  // with the reason that fits it: a channel that is there and not shown.
  assert.deepEqual(
    unknown.map(({ ref, reason }) => `${ref.channelId}/${ref.sourceType}/${reason}`),
    [
      "pc_ghost/secured/is not a channel in the secured list",
      `${UNPINNED._id}/direct/is not on the public channel list`,
    ]
  );
  assert.equal(typeof sources.describeUnknownFixtureRefs(unknown), "string");
});

test("linking a match to a direct channel changes nothing about that channel", async () => {
  const before = catalogueSnapshot();

  const fixture = await store.createFixture({
    sport: "football",
    teamA: "Mohammedan",
    teamB: "Bashundhara",
    teamALogo: "",
    teamBLogo: "",
    competition: "BPL",
    startsAt: new Date("2026-10-26T16:00:00.000Z"),
    durationMinutes: 120,
    channels: [{ channelId: PINNED._id, sourceType: "direct" }],
    visible: true,
  });
  assert.deepEqual(fixture.channels, [{ channelId: PINNED._id, sourceType: "direct" }]);

  await store.updateFixture(fixture._id, {
    channels: [
      { channelId: PINNED._id, sourceType: "direct" },
      { channelId: UNPINNED._id, sourceType: "direct" },
    ],
  });
  await store.deleteFixture(fixture._id);
  await sources.listDirectChannelOptions();
  await sources.listDirectChannelsByIds([PINNED._id, UNPINNED._id]);
  await sources.unknownFixtureRefs([
    { channelId: PINNED._id, sourceType: "direct" },
    { channelId: UNPINNED._id, sourceType: "direct" },
  ]);

  // Channels, links, pin state, priority, probe bookkeeping: not one field moved, through the
  // whole write-read-delete life of a card that named two of them.
  assert.equal(catalogueSnapshot(), before);
  assert.equal(fs.existsSync(path.join(sandbox, "data", "premium-store.json")), true);
});

test("a deployment with no database refuses to guess whether a direct channel exists", async () => {
  process.env.VERCEL = "1";

  await assert.rejects(
    () => sources.listDirectChannelsByIds([PINNED._id]),
    (err: unknown) => {
      const e = err as Error & { status?: number };
      assert.equal(e.status, 503);
      assert.equal(e.message, "Database unavailable — the channel catalogue could not be checked");
      return true;
    }
  );

  delete process.env.VERCEL;
});

test("this run never touched this project's own data files", () => {
  assert.equal(fs.existsSync(projectStoreFiles.premium), existedBefore.premium);
  assert.equal(fs.existsSync(projectStoreFiles.catalogue), existedBefore.catalogue);
});
