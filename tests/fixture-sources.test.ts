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

test("a direct channel is known only when it is on the public catalogue", async () => {
  const known = await sources.existingDirectChannelIds([PINNED._id, UNPINNED._id, "6ab5c72de29c995275489e5e"]);
  assert.deepEqual(known, new Set([PINNED._id]));

  // An empty list asks nothing at all, so a card with no links costs no query.
  assert.deepEqual(await sources.existingDirectChannelIds([]), new Set());
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
  // that rather than that the channel does not exist.
  assert.deepEqual(
    unknown.map(({ ref, reason }) => `${ref.channelId}/${ref.sourceType}/${reason}`),
    [
      "pc_ghost/secured/is not a channel in the secured list",
      `${UNPINNED._id}/direct/is not a channel on the direct catalogue`,
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
  await sources.existingDirectChannelIds([PINNED._id, UNPINNED._id]);

  // Channels, links, pin state, priority, probe bookkeeping: not one field moved, through the
  // whole write-read-delete life of a card that named two of them.
  assert.equal(catalogueSnapshot(), before);
  assert.equal(fs.existsSync(path.join(sandbox, "data", "premium-store.json")), true);
});

test("a deployment with no database refuses to guess whether a direct channel exists", async () => {
  process.env.VERCEL = "1";

  await assert.rejects(
    () => sources.existingDirectChannelIds([PINNED._id]),
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
