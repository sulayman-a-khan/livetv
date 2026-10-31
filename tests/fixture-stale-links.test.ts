/**
 * Tests for the Direct HLS tier's answer to a stale reference (P11.12).
 *
 * Run with `npm run test:fixture-stale-links`.
 *
 * The rule this locks: a link that names no channel is a fact to be handled, not a reason to
 * break the card. Three things follow from it, and each is checked here against the real
 * modules:
 *
 *  - the editor is told which of its links name no channel;
 *  - the admin can still edit a card whose link has gone stale — a link the card already carried
 *    is kept, not refused, because refusing it would lock the admin out of the card they are
 *    fixing;
 *  - a catalogue channel that is deleted leaves the card and its link in place, so the link
 *    becomes a stale reference the board counts and the admin can repair.
 *
 * Nothing here reaches a database or the network: the catalogue and the cards are stood in for
 * (`tests/helpers/fakeFixtureModel.ts`), and this project's own `data/` is never read or written.
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

delete process.env.MONGODB_URI;
delete process.env.VERCEL;
process.env.ADMIN_SECRET_KEY = "stale-links-test-secret";

/** A catalogue row the app is showing, and one it is deliberately not. */
const PINNED = "6ab5c72de29c995275489e5c";
const UNPINNED = "6ab5c72de29c995275489e5d";
const GONE = "6ab5c72de29c995275489e5e";
const STAMPED_AT = new Date("2026-10-27T09:00:00.000Z").toISOString();

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
});

after(() => {
  db.restore();
});

type FixtureSources = typeof import("../lib/fixtureSources");
type FixtureStore = typeof import("../lib/fixtureStore");

const sources: FixtureSources = require("../lib/fixtureSources");
const fixtureStore: FixtureStore = require("../lib/fixtureStore");
const { projectFixtures } = require("../lib/fixtureBoard") as typeof import("../lib/fixtureBoard");

// --- the editor's own question: which links name a channel it cannot see? ---

/** The panel's own rule, read from the module it uses. */
const unresolvedRefs = (
  refs: { channelId: string; sourceType: "direct" | "secured" }[],
  known: { direct: string[] }
) => require("../lib/fixtures").unresolvedFixtureRefs(refs, known);

test("a link is unresolved only against the list it names", () => {
  const known = { direct: [PINNED] };

  assert.deepEqual(unresolvedRefs([{ channelId: PINNED, sourceType: "direct" }], known), []);
  assert.deepEqual(unresolvedRefs([{ channelId: GONE, sourceType: "direct" }], known), [
    { channelId: GONE, sourceType: "direct" },
  ]);

  // A link from the other tier is not judged against the catalogue's list: it names no channel
  // *there*, and a card may still carry one from before this panel owned it.
  assert.deepEqual(unresolvedRefs([{ channelId: "pc_one", sourceType: "secured" }], known), []);
});

// --- the write's question: refused, or stale? ---

test("a link the card already carried is stale, and a link the admin is adding is refused", async () => {
  const refs = [
    { channelId: PINNED, sourceType: "direct" as const },
    { channelId: GONE, sourceType: "direct" as const },
    { channelId: UNPINNED, sourceType: "direct" as const },
  ];

  // Nothing is carried: every link that names no channel is refused, which is the rule a
  // create is held to.
  const fresh = await sources.checkFixtureRefs(refs);
  assert.deepEqual(
    fresh.refused.map(({ ref, reason }) => `${ref.channelId}/${reason}`),
    [
      `${GONE}/is not a channel on the direct catalogue`,
      `${UNPINNED}/is not on the public channel list`,
    ]
  );
  assert.deepEqual(fresh.stale, []);

  // The same links, with the card already carrying them: they are stale, not refused. A link
  // that names no channel any more must not stop the admin from editing the card it is on.
  const carried = await sources.checkFixtureRefs(refs, refs);
  assert.deepEqual(carried.refused, []);
  assert.deepEqual(
    carried.stale.map(({ ref, reason }) => `${ref.channelId}/${reason}`),
    [
      `${GONE}/is not a channel on the direct catalogue`,
      `${UNPINNED}/is not on the public channel list`,
    ]
  );

  // The split is per link, not per request: one link the admin is adding is refused even while
  // another link on the same card is merely stale.
  const mixed = await sources.checkFixtureRefs(
    [...refs, { channelId: "6ab5c72de29c995275489fff", sourceType: "direct" as const }],
    refs
  );
  assert.deepEqual(
    mixed.refused.map(({ ref }) => ref.channelId),
    ["6ab5c72de29c995275489fff"]
  );
  assert.equal(mixed.stale.length, 2);
});

// --- deleting a channel leaves a stale link behind, and the match alone --------

test("a catalogue channel that is deleted leaves the card's link behind, and the match alone", async () => {
  db.fixtures.push({
    _id: "64b5c72de29c995275489e10",
    title: "Mohammedan v Bashundhara",
    sport: "football",
    teamA: "Mohammedan",
    teamB: "Bashundhara",
    teamALogo: "",
    teamBLogo: "",
    competition: "BPL",
    startsAt: new Date(Date.now() - 30 * 60_000),
    durationMinutes: 120,
    channels: [{ channelId: UNPINNED, sourceType: "direct" }],
    visible: true,
  });

  // The catalogue row is gone. Nothing in the Direct HLS tier takes the link off the card when
  // that happens, and that is the point: the link becomes a stale reference the board counts and
  // the admin can repair, rather than a dangling id nobody can see.
  const at = db.channels.findIndex((row) => String(row._id) === UNPINNED);
  assert.notEqual(at, -1, "the catalogue row has to be there to be deleted");
  db.channels.splice(at, 1);

  // The match is still there — only the admin decides a match is gone — and so is its link.
  const cards = await fixtureStore.listFixtures();
  const kept = cards.find((entry) => entry._id === "64b5c72de29c995275489e10");
  assert.ok(kept, "deleting a channel must not delete the match");
  assert.equal(kept.teamA, "Mohammedan");
  assert.deepEqual(kept.channels, [{ channelId: UNPINNED, sourceType: "direct" }]);

  // And the board counts the link as one it cannot open, instead of hiding the card.
  const board = projectFixtures(cards, [], [], new Date(), false);
  const card = board.find((entry) => entry.id === "64b5c72de29c995275489e10");
  assert.ok(card, "the match stays on the board");
  assert.equal(card.staleReferences, 1);
  assert.equal(card.watchPath, null);
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
  db.fixtures.push({
    _id: "64b5c72de29c995275489e11",
    title: "Dhaka Tigers v Chattogram Challengers",
    sport: "cricket",
    teamA: "Dhaka Tigers",
    teamB: "Chattogram Challengers",
    teamALogo: "",
    teamBLogo: "",
    competition: "BPL",
    startsAt: new Date("2026-11-05T16:00:00.000Z"),
    durationMinutes: 120,
    channels: [{ channelId: GONE, sourceType: "direct" }],
    visible: false,
  });

  // The link the card carries names no channel — it is kept, and the rest of the edit goes
  // through. Before this, the whole save was refused and the card could not be edited at all.
  const answer = await patch("64b5c72de29c995275489e11", {
    competition: "BPL 2026",
    channels: [{ channelId: GONE, sourceType: "direct" }],
  });
  assert.equal(answer.status, 200, `the save was refused: ${JSON.stringify(answer.body)}`);
  assert.equal(answer.body.success, true);
  assert.equal((answer.body.fixture as { competition: string }).competition, "BPL 2026");

  // The card kept its stale link rather than losing it: a channel that comes back is on the
  // card again with no repair step in between.
  assert.deepEqual((answer.body.fixture as { channels: unknown[] }).channels, [
    { channelId: GONE, sourceType: "direct" },
  ]);
});

test("the admin is still refused a link that names no channel", async () => {
  db.fixtures.push({
    _id: "64b5c72de29c995275489e12",
    title: "One v Two",
    sport: "football",
    teamA: "One",
    teamB: "Two",
    teamALogo: "",
    teamBLogo: "",
    competition: "",
    startsAt: new Date("2026-11-05T16:00:00.000Z"),
    durationMinutes: 120,
    channels: [{ channelId: PINNED, sourceType: "direct" }],
    visible: false,
  });

  const answer = await patch("64b5c72de29c995275489e12", {
    channels: [
      { channelId: PINNED, sourceType: "direct" },
      { channelId: "6ab5c72de29c995275489fff", sourceType: "direct" },
    ],
  });
  assert.equal(answer.status, 400);
  assert.equal(answer.body.success, false);
  assert.ok(
    String(answer.body.error).includes("6ab5c72de29c995275489fff"),
    `the refusal must name the link: ${String(answer.body.error)}`
  );

  // And the card is unchanged: a refused write writes nothing.
  const cards = await fixtureStore.listFixtures();
  const stored = cards.find((entry) => entry._id === "64b5c72de29c995275489e12");
  assert.deepEqual(stored?.channels, [{ channelId: PINNED, sourceType: "direct" }]);
});

// --- the editor that has to show the link it cannot see ---

test("the panel shows a link it cannot see, so the admin can take it off", () => {
  // The panel is a client component and this project has no renderer for it, so the check is
  // made against its source: the rule that finds the missing links has to be the one the
  // panel asks, and the result has to reach the screen.
  const source = fs.readFileSync(path.join(projectCwd, "components", "FixturePanel.tsx"), "utf-8");
  assert.ok(
    source.includes("unresolvedFixtureRefs"),
    "the panel has to ask which of its links name no channel"
  );
  assert.ok(source.includes("missingLinks"), "the missing links have to reach the screen");
});
