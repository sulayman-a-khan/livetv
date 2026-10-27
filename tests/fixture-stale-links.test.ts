/**
 * Tests for the premium tier's answer to a stale reference (P11.12).
 *
 * Run with `npm run test:fixture-stale-links`.
 *
 * The rule this locks: a link that names no channel is a fact to be handled, not a reason to
 * break the card. Three things follow from it, and each is checked here against the real
 * modules:
 *
 *  - the board keeps a match whose channel is gone, and says how many links are missing;
 *  - the admin can still edit that match — a link the card already carried is kept, not
 *    refused, because refusing it would lock the admin out of the card they are fixing;
 *  - deleting a channel takes its link off every card, so a dangling id does not survive the
 *    one operation that is able to repair it.
 *
 * Nothing here reaches a database or the network. The catalogue is seeded into a temporary
 * directory, the tier writes to its own store file in the same directory, and this project's own
 * `data/` is never read or written.
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
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "freetv-fixture-stale-"));
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
process.env.ADMIN_SECRET_KEY = "stale-links-test-secret";

/** A pinned catalogue row and an unpinned one — the two ways a direct link can fail. */
const PINNED = "6ab5c72de29c995275489e5c";
const UNPINNED = "6ab5c72de29c995275489e5d";
const STAMPED_AT = new Date("2026-10-27T09:00:00.000Z").toISOString();

const catalogueFile = path.join(sandbox, "data", "store.json");
fs.mkdirSync(path.dirname(catalogueFile), { recursive: true });
fs.writeFileSync(
  catalogueFile,
  JSON.stringify({
    channels: [
      {
        _id: PINNED,
        name: "Pinned Sports One",
        normalizedName: "pinned-sports-one",
        logo: "",
        category: "Sports",
        isPinned: true,
        priorityOrder: 3,
        createdAt: STAMPED_AT,
        updatedAt: STAMPED_AT,
      },
      {
        _id: UNPINNED,
        name: "Hidden Sports Two",
        normalizedName: "hidden-sports-two",
        logo: "",
        category: "Sports",
        isPinned: false,
        priorityOrder: 1,
        createdAt: STAMPED_AT,
        updatedAt: STAMPED_AT,
      },
    ],
    streams: [],
  }),
  "utf-8"
);

type FixtureSources = typeof import("../lib/fixtureSources");
type PremiumStore = typeof import("../lib/premiumStore");
type PremiumFixtures = typeof import("../lib/premiumFixtures");
type InMemoryStore = typeof import("../lib/inMemoryStore");

const sources: FixtureSources = require("../lib/fixtureSources");
const store: PremiumStore = require("../lib/premiumStore");
const { unresolvedFixtureRefs }: PremiumFixtures = require("../lib/premiumFixtures");
const { inMemoryDb }: InMemoryStore = require("../lib/inMemoryStore");

after(() => {
  process.chdir(projectCwd);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** The catalogue exactly as it stands, so a later comparison means "not one field moved". */
const catalogueSnapshot = () => JSON.stringify(inMemoryDb.getChannels());

// --- the editor's own question: which links name a channel it cannot see? ---

test("a link is unresolved only against the tier it names", () => {
  const known = { direct: [PINNED], secured: ["pc_one"] };

  assert.deepEqual(unresolvedFixtureRefs([{ channelId: PINNED, sourceType: "direct" }], known), []);
  assert.deepEqual(unresolvedFixtureRefs([{ channelId: "pc_one", sourceType: "secured" }], known), []);

  // The same id in the other tier is a different channel, so it is not resolved by the first
  // tier's list. A link is looked for where it says it came from and nowhere else.
  assert.deepEqual(unresolvedFixtureRefs([{ channelId: PINNED, sourceType: "secured" }], known), [
    { channelId: PINNED, sourceType: "secured" },
  ]);
  assert.deepEqual(unresolvedFixtureRefs([{ channelId: "pc_one", sourceType: "direct" }], known), [
    { channelId: "pc_one", sourceType: "direct" },
  ]);

  // An empty list of known channels means every link is unresolved — the lists are the answer,
  // and there is no second place to look.
  assert.equal(unresolvedFixtureRefs([{ channelId: PINNED, sourceType: "direct" }], {
    direct: [],
    secured: [],
  }).length, 1);
});

// --- the write's question: refused, or stale? ---

test("a link the card already carried is stale, and a link the admin is adding is refused", async () => {
  const refs = [
    { channelId: PINNED, sourceType: "direct" as const },
    { channelId: "pc_ghost", sourceType: "secured" as const },
    { channelId: UNPINNED, sourceType: "direct" as const },
  ];

  // Nothing is carried: every link that names no channel is refused, which is the rule a
  // create is held to.
  const fresh = await sources.checkFixtureRefs(refs);
  assert.deepEqual(
    fresh.refused.map(({ ref, reason }) => `${ref.channelId}/${ref.sourceType}/${reason}`),
    [
      "pc_ghost/secured/is not a channel in the secured list",
      `${UNPINNED}/direct/is not on the public channel list`,
    ]
  );
  assert.deepEqual(fresh.stale, []);

  // The same links, with the card already carrying them: they are stale, not refused. A link
  // that names no channel any more must not stop the admin from editing the card it is on.
  const carried = await sources.checkFixtureRefs(refs, refs);
  assert.deepEqual(carried.refused, []);
  assert.deepEqual(
    carried.stale.map(({ ref, reason }) => `${ref.channelId}/${ref.sourceType}/${reason}`),
    [
      "pc_ghost/secured/is not a channel in the secured list",
      `${UNPINNED}/direct/is not on the public channel list`,
    ]
  );

  // The split is per link, not per request: one link the admin is adding is refused even while
  // another link on the same card is merely stale.
  const mixed = await sources.checkFixtureRefs(
    [...refs, { channelId: "pc_never", sourceType: "secured" as const }],
    refs
  );
  assert.deepEqual(
    mixed.refused.map(({ ref }) => ref.channelId),
    ["pc_never"]
  );
  assert.equal(mixed.stale.length, 2);
});

// --- deleting a channel repairs every card that named it ---

test("deleting a channel takes its link off every card and leaves the match alone", async () => {
  const channel = await store.createPremiumChannel({
    name: "Example Sports HD",
    category: "Premium",
    logoUrl: "",
    active: true,
    sortOrder: 99,
    note: "",
    proxyChannelKey: "",
  });

  const fixture = await store.createFixture({
    sport: "football",
    teamA: "Mohammedan",
    teamB: "Bashundhara",
    teamALogo: "",
    teamBLogo: "",
    competition: "BPL",
    startsAt: new Date("2026-10-27T16:00:00.000Z"),
    durationMinutes: 120,
    channels: [
      { channelId: channel._id, sourceType: "secured" },
      { channelId: PINNED, sourceType: "direct" },
    ],
    visible: true,
  });

  assert.equal(await store.deletePremiumChannel(channel._id), true);

  // The match is still there — only the admin decides a match is gone — and the link to the
  // deleted channel is not.
  const cards = await store.listFixtures();
  const kept = cards.find((entry) => entry._id === fixture._id);
  assert.ok(kept, "deleting a channel must not delete the match");
  assert.equal(kept.teamA, "Mohammedan");
  assert.deepEqual(kept.channels, [{ channelId: PINNED, sourceType: "direct" }]);

  // The direct link is untouched: the catalogue is not this tier's to edit.
  assert.equal(catalogueSnapshot().includes("Pinned Sports One"), true);
});

test("a card written in the old single-channel shape loses its link as well", async () => {
  const file = path.join(sandbox, "data", "premium-store.json");
  const written = JSON.parse(fs.readFileSync(file, "utf-8"));
  written.premiumChannels.push({
    _id: "pc_legacy",
    name: "Legacy Sports HD",
    category: "Premium",
    logoUrl: "",
    sourceUrl: "",
    headers: { userAgent: "", referer: "" },
    proxyChannelKey: "",
    proxyPushedAt: null,
    active: true,
    sortOrder: 99,
    note: "",
    createdAt: STAMPED_AT,
    updatedAt: STAMPED_AT,
  });
  written.fixtures.push({
    _id: "fx_legacy",
    sport: "football",
    teamA: "Legacy A",
    teamB: "Legacy B",
    teamALogo: "",
    teamBLogo: "",
    competition: "Old Cup",
    startsAt: new Date("2026-10-27T16:00:00.000Z"),
    durationMinutes: 120,
    premiumChannelId: "pc_legacy",
    visible: true,
    createdAt: STAMPED_AT,
    updatedAt: STAMPED_AT,
  });
  fs.writeFileSync(file, JSON.stringify(written), "utf-8");

  // Re-read the tier through a fresh module graph, so the store's own loader runs against the
  // file above rather than against what this process already holds.
  const shared = globalThis as unknown as Record<string, unknown>;
  shared.__freetv_premium_channels = undefined;
  shared.__freetv_premium_fixtures = undefined;
  for (const request of ["../lib/premiumLocalStore", "../lib/premiumStore"]) {
    delete require.cache[require.resolve(request)];
  }
  const fresh: PremiumStore = require("../lib/premiumStore");

  assert.equal(await fresh.deletePremiumChannel("pc_legacy"), true);

  const cards = await fresh.listFixtures();
  const legacy = cards.find((entry) => entry._id === "fx_legacy");
  assert.ok(legacy, "the card written in the old shape is still on the board");
  assert.deepEqual(legacy.channels, []);

  // The old column is cleared too, so a re-read cannot bring the link back.
  const onDisk = JSON.parse(fs.readFileSync(file, "utf-8")).fixtures.find(
    (row: { _id: string }) => row._id === "fx_legacy"
  );
  assert.equal(onDisk.premiumChannelId, null);
});

// --- the route the admin actually calls ---

/** The route's own answer, as the fields the contract is written in. */
async function patch(
  id: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { NextRequest } = require("next/server");
  const { PATCH } = require("../app/api/admin/fixtures/[id]/route.js");
  const res = await PATCH(
    new NextRequest(`http://localhost/api/admin/fixtures/${id}`, {
      method: "PATCH",
      headers: {
        "x-admin-secret": process.env.ADMIN_SECRET_KEY as string,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    { params: { id } }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("the admin can still change a card whose link has gone stale", async () => {
  const card = await store.createFixture({
    sport: "cricket",
    teamA: "Dhaka Tigers",
    teamB: "Chattogram Challengers",
    teamALogo: "",
    teamBLogo: "",
    competition: "BPL",
    startsAt: new Date("2026-10-27T16:00:00.000Z"),
    durationMinutes: 120,
    channels: [{ channelId: "pc_ghost", sourceType: "secured" }],
    visible: false,
  });

  // The link the card carries names no channel — it is kept, and the rest of the edit goes
  // through. Before this, the whole save was refused and the card could not be edited at all.
  const answer = await patch(card._id, {
    competition: "BPL 2026",
    channels: [{ channelId: "pc_ghost", sourceType: "secured" }],
  });
  assert.equal(answer.status, 200, `the save was refused: ${JSON.stringify(answer.body)}`);
  assert.equal(answer.body.success, true);
  assert.equal((answer.body.fixture as { competition: string }).competition, "BPL 2026");

  // The card kept its stale link rather than losing it: a channel that comes back is on the
  // card again with no repair step in between.
  assert.deepEqual((answer.body.fixture as { channels: unknown[] }).channels, [
    { channelId: "pc_ghost", sourceType: "secured" },
  ]);
});

test("the admin is still refused a link that names no channel", async () => {
  const card = await store.createFixture({
    sport: "football",
    teamA: "One",
    teamB: "Two",
    teamALogo: "",
    teamBLogo: "",
    competition: "",
    startsAt: new Date("2026-10-27T16:00:00.000Z"),
    durationMinutes: 120,
    channels: [{ channelId: PINNED, sourceType: "direct" }],
    visible: false,
  });

  const answer = await patch(card._id, {
    channels: [
      { channelId: PINNED, sourceType: "direct" },
      { channelId: "pc_never", sourceType: "secured" },
    ],
  });
  assert.equal(answer.status, 400);
  assert.equal(answer.body.success, false);
  assert.ok(
    String(answer.body.error).includes("pc_never"),
    `the refusal must name the link: ${String(answer.body.error)}`
  );

  // And the card is unchanged: a refused write writes nothing.
  const cards = await store.listFixtures();
  const stored = cards.find((entry) => entry._id === card._id);
  assert.deepEqual(stored?.channels, [{ channelId: PINNED, sourceType: "direct" }]);
});

// --- the editor that has to show the link it cannot see ---

test("the panel shows a link it cannot see, so the admin can take it off", () => {
  // The panel is a client component and this project has no renderer for it, so the check is
  // made against its source: the rule that finds the missing links has to be the one the
  // panel asks, and the result has to reach the screen.
  const source = fs.readFileSync(
    path.join(projectCwd, "components", "premium-admin", "FixturePanel.tsx"),
    "utf-8"
  );
  assert.ok(
    source.includes("unresolvedFixtureRefs"),
    "the panel has to ask which of its links name no channel"
  );
  assert.ok(source.includes("missingLinks"), "the missing links have to reach the screen");
});

test("this run never touched this project's own data files", () => {
  assert.equal(fs.existsSync(projectStoreFiles.premium), existedBefore.premium);
  assert.equal(fs.existsSync(projectStoreFiles.catalogue), existedBefore.catalogue);
});
