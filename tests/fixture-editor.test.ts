/**
 * Tests for the fixture editor in the Direct HLS admin panel: what the panel sends, what the
 * admin API accepts, and what the homepage board then shows.
 *
 * Run with `npm run test:fixture-editor`.
 *
 * The cards live in MongoDB, so the database is stood in for
 * (`tests/helpers/fakeFixtureModel.ts`) and the catalogue is two channels it is showing and one
 * it is not. Nothing here reaches the network: no stream box is asked anything, because the
 * board is Direct HLS only, and no project's own `data/` file is read or written.
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
process.env.ADMIN_SECRET_KEY = "fixture-editor-test-secret";

/** Two channels the catalogue is showing, and one it is deliberately not. */
const PINNED = "6ab5c72de29c995275489e5c";
const PINNED_TWO = "6ab5c72de29c995275489e5d";
const UNPINNED = "6ab5c72de29c995275489e5e";

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
      priorityOrder: 1,
    },
    {
      _id: PINNED_TWO,
      name: "Pinned Sports Two",
      normalizedName: "pinned-sports-two",
      logo: "",
      category: "Sports",
      isPinned: true,
      priorityOrder: 2,
    },
    {
      _id: UNPINNED,
      name: "Hidden Sports Three",
      normalizedName: "hidden-sports-three",
      logo: "",
      category: "Sports",
      isPinned: false,
      priorityOrder: 3,
    },
  ],
});

after(() => {
  db.restore();
});

/** A kickoff half an hour ago, so the card reads as live on the board. */
const KICKOFF = new Date(Date.now() - 30 * 60_000).toISOString();

/** The route's own answer, as the fields the contract is written in. */
async function call(
  route: "post" | "patch" | "del" | "get",
  url: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const method = route === "post" ? "POST" : route === "patch" ? "PATCH" : route === "del" ? "DELETE" : "GET";
  const res = await fetchRoute(route, url, method, body);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The three admin routes the editor uses, and the public board. */
function fetchRoute(
  route: "post" | "patch" | "del" | "get",
  url: string,
  method: string,
  body?: Record<string, unknown>
): Promise<Response> {
  const { NextRequest } = require("next/server");
  const request = new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      "x-admin-secret": process.env.ADMIN_SECRET_KEY as string,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (route === "post") {
    const { POST } = require("../app/api/admin/fixtures/route.js");
    return POST(request);
  }
  if (route === "patch") {
    const { PATCH } = require("../app/api/admin/fixtures/[id]/route.js");
    const id = url.split("/").pop() as string;
    return PATCH(request, { params: { id } });
  }
  if (route === "del") {
    const { DELETE } = require("../app/api/admin/fixtures/[id]/route.js");
    const id = url.split("/").pop() as string;
    return DELETE(request, { params: { id } });
  }
  if (url.startsWith("/api/admin/fixtures/sources")) {
    const { GET } = require("../app/api/admin/fixtures/sources/route.js");
    return GET(request);
  }
  if (url.startsWith("/api/admin/fixtures")) {
    const { GET } = require("../app/api/admin/fixtures/route.js");
    return GET(request);
  }
  const { GET } = require("../app/api/fixtures/route.js");
  return GET(request);
}

// --- what the editor sends ----------------------------------------------------

test("a match entered with a title keeps that title, and the teams come out of it", async () => {
  const answer = await call("post", "/api/admin/fixtures", {
    title: "Bangladesh vs India",
    sport: "cricket",
    startsAt: KICKOFF,
    durationMinutes: 180,
    channels: [],
    visible: false,
  });

  assert.equal(answer.status, 200, `the match was refused: ${JSON.stringify(answer.body)}`);
  const fixture = answer.body.fixture as {
    title: string;
    teamA: string;
    teamB: string;
    durationMinutes: number;
    visible: boolean;
  };
  // The title is the admin's own wording, and it is kept rather than being read and thrown away.
  assert.equal(fixture.title, "Bangladesh vs India");
  // The two teams are the same fact said the other way round, and the card needs both.
  assert.equal(fixture.teamA, "Bangladesh");
  assert.equal(fixture.teamB, "India");
  assert.equal(fixture.durationMinutes, 180);
  assert.equal(fixture.visible, false);
});

test("a title that names no pair is kept as a title and names no team of its own", async () => {
  const answer = await call("post", "/api/admin/fixtures", {
    title: "Opening ceremony",
    teamA: "One",
    teamB: "Two",
    sport: "football",
    startsAt: KICKOFF,
    durationMinutes: 120,
    channels: [],
    visible: false,
  });

  assert.equal(answer.status, 200, `the match was refused: ${JSON.stringify(answer.body)}`);
  const fixture = answer.body.fixture as { title: string; teamA: string; teamB: string };
  assert.equal(fixture.title, "Opening ceremony");
  assert.equal(fixture.teamA, "One");
  assert.equal(fixture.teamB, "Two");
});

test("the channels a card names are kept in the order the admin put them in", async () => {
  const answer = await call("post", "/api/admin/fixtures", {
    title: "One vs Two",
    sport: "football",
    startsAt: KICKOFF,
    durationMinutes: 120,
    channels: [
      { channelId: PINNED_TWO, sourceType: "direct" },
      { channelId: PINNED, sourceType: "direct" },
    ],
    visible: false,
  });

  assert.equal(answer.status, 200, `the match was refused: ${JSON.stringify(answer.body)}`);
  const fixture = answer.body.fixture as { channels: { channelId: string }[] };
  // The order is the admin's, not the store's: it is the order the card tries its channels in
  // and the order a fallback moves through, so nothing may sort it on the way in.
  assert.deepEqual(
    fixture.channels.map((ref) => ref.channelId),
    [PINNED_TWO, PINNED]
  );
});

test("the card's channels are read back in the admin's order, for the fallback walk", async () => {
  const answer = await call("post", "/api/admin/fixtures", {
    title: "Three vs Four",
    sport: "football",
    startsAt: KICKOFF,
    durationMinutes: 120,
    channels: [
      { channelId: PINNED, sourceType: "direct" },
      { channelId: PINNED_TWO, sourceType: "direct" },
    ],
    visible: true,
  });

  assert.equal(answer.status, 200, `the match was refused: ${JSON.stringify(answer.body)}`);
  const fixture = answer.body.fixture as { channels: { channelId: string }[] };

  // The order is the admin's, not the store's: it is the order the card tries its channels in
  // and the order a fallback moves through, so nothing may sort it on the way out.
  assert.deepEqual(
    fixture.channels.map((ref) => ref.channelId),
    [PINNED, PINNED_TWO]
  );

  // A card nobody can see is not a reason to move a viewer anywhere, so it offers nothing — and
  // it must not take the card's place either, or a hidden card would decide where a failure goes.
  const hidden = await call("post", "/api/admin/fixtures", {
    title: "Five vs Six",
    sport: "football",
    startsAt: KICKOFF,
    durationMinutes: 120,
    channels: [{ channelId: PINNED, sourceType: "direct" }],
    visible: false,
  });
  assert.equal(hidden.status, 200, `the match was refused: ${JSON.stringify(hidden.body)}`);
  const hiddenId = (hidden.body.fixture as { _id: string })._id;

  const board = await call("get", "/api/fixtures");
  const boardIds = (board.body.fixtures as { id: string }[]).map((card) => card.id);
  assert.equal(boardIds.includes(hiddenId), false);
});

// --- what the editor may link -------------------------------------------------

test("the editor is offered the catalogue's own channels, and nothing else", async () => {
  const answer = await call("get", "/api/admin/fixtures/sources");

  assert.equal(answer.status, 200, `the list was refused: ${JSON.stringify(answer.body)}`);
  const direct = answer.body.direct as { channelId: string; name: string; sourceType: string }[];

  // Only the channels the catalogue is showing, because a card that linked one the app keeps
  // off screen would advertise a channel nobody can find.
  assert.deepEqual(
    direct.map((option) => option.channelId),
    [PINNED, PINNED_TWO]
  );
  assert.equal(direct[0].sourceType, "direct");
  assert.equal(direct[0].name, "Pinned Sports One");

  // A reference is an id and a source. Nothing about how a channel is delivered has any business
  // being in the list a fixture editor builds references from.
  assert.deepEqual(Object.keys(direct[0]).sort(), [
    "category",
    "channelId",
    "logoUrl",
    "name",
    "sourceType",
  ]);
});

test("a card may only link a channel the catalogue is showing", async () => {
  const before = db.fixtures.length;
  const answer = await call("post", "/api/admin/fixtures", {
    title: "Hidden vs Shown",
    sport: "football",
    startsAt: KICKOFF,
    durationMinutes: 120,
    channels: [{ channelId: UNPINNED, sourceType: "direct" }],
    visible: false,
  });

  assert.equal(answer.status, 400);
  assert.equal(answer.body.success, false);
  assert.ok(
    String(answer.body.error).includes(UNPINNED),
    `the refusal must name the link: ${String(answer.body.error)}`
  );

  // And nothing was written: a refused write writes nothing.
  assert.equal(db.fixtures.length, before);
});

test("a premium channel cannot be linked from this panel any more", async () => {
  const before = db.fixtures.length;
  const answer = await call("post", "/api/admin/fixtures", {
    title: "Secured vs Refused",
    sport: "football",
    startsAt: KICKOFF,
    durationMinutes: 120,
    channels: [{ channelId: "pc_one", sourceType: "secured" }],
    visible: false,
  });

  assert.equal(answer.status, 400);
  assert.ok(
    String(answer.body.error).includes("must be a Direct HLS channel"),
    `the refusal must say why: ${String(answer.body.error)}`
  );
  assert.equal(db.fixtures.length, before);
});

// --- editing ------------------------------------------------------------------

test("an edit changes only what was sent", async () => {
  const created = await call("post", "/api/admin/fixtures", {
    title: "Publish v Me",
    sport: "football",
    startsAt: KICKOFF,
    durationMinutes: 120,
    channels: [{ channelId: PINNED, sourceType: "direct" }],
    visible: false,
  });
  assert.equal(created.status, 200, `the match was refused: ${JSON.stringify(created.body)}`);
  const id = (created.body.fixture as { _id: string })._id;

  const published = await call("patch", `/api/admin/fixtures/${id}`, { visible: true });
  assert.equal(published.status, 200, `the edit was refused: ${JSON.stringify(published.body)}`);
  const fixture = published.body.fixture as { visible: boolean; title: string; channels: unknown[] };
  // A single switch flip must never re-ask for the rest of the card.
  assert.equal(fixture.visible, true);
  assert.equal(fixture.title, "Publish v Me");
  assert.deepEqual(fixture.channels, [{ channelId: PINNED, sourceType: "direct" }]);
});

test("a link the card already carried survives an edit, and a new one has to name a channel", async () => {
  // A card whose channel has since been taken off the public list.
  const created = await call("post", "/api/admin/fixtures", {
    title: "Stale v Fresh",
    sport: "football",
    startsAt: KICKOFF,
    durationMinutes: 120,
    channels: [{ channelId: UNPINNED, sourceType: "direct" }],
    visible: false,
  });
  // The create is refused, because a link that names no channel cannot be added — so the stale
  // link is put on the card the way the world produces one: the channel is shown first and
  // taken off the list afterwards.
  assert.equal(created.status, 400);

  db.fixtures.push({
    _id: "64b5c72de29c995275489eaa",
    title: "Stale v Fresh",
    sport: "football",
    teamA: "Stale",
    teamB: "Fresh",
    teamALogo: "",
    teamBLogo: "",
    competition: "",
    startsAt: new Date(KICKOFF),
    durationMinutes: 120,
    channels: [{ channelId: UNPINNED, sourceType: "direct" }],
    visible: false,
  });

  // The link the card carries is kept, and the rest of the edit goes through: refusing it would
  // lock the admin out of the very card they are trying to fix.
  const kept = await call("patch", "/api/admin/fixtures/64b5c72de29c995275489eaa", {
    competition: "BPL 2026",
    channels: [{ channelId: UNPINNED, sourceType: "direct" }],
  });
  assert.equal(kept.status, 200, `the edit was refused: ${JSON.stringify(kept.body)}`);
  const edited = kept.body.fixture as { competition: string; channels: unknown[] };
  assert.equal(edited.competition, "BPL 2026");
  assert.deepEqual(edited.channels, [{ channelId: UNPINNED, sourceType: "direct" }]);

  // A link the admin is adding now still has to name a channel the catalogue is showing.
  const refused = await call("patch", "/api/admin/fixtures/64b5c72de29c995275489eaa", {
    channels: [
      { channelId: UNPINNED, sourceType: "direct" },
      { channelId: "6ab5c72de29c995275489fff", sourceType: "direct" },
    ],
  });
  assert.equal(refused.status, 400);
  assert.ok(
    String(refused.body.error).includes("6ab5c72de29c995275489fff"),
    `the refusal must name the link: ${String(refused.body.error)}`
  );
});

test("a card can be deleted, and then it is gone from the board", async () => {
  const created = await call("post", "/api/admin/fixtures", {
    title: "Gone v Away",
    sport: "football",
    startsAt: KICKOFF,
    durationMinutes: 120,
    channels: [{ channelId: PINNED, sourceType: "direct" }],
    visible: true,
  });
  assert.equal(created.status, 200);
  const id = (created.body.fixture as { _id: string })._id;

  const removed = await call("del", `/api/admin/fixtures/${id}`);
  assert.equal(removed.status, 200, `the delete was refused: ${JSON.stringify(removed.body)}`);
  assert.equal(removed.body.success, true);

  const board = await call("get", "/api/fixtures");
  const ids = (board.body.fixtures as { id: string }[]).map((card) => card.id);
  assert.equal(ids.includes(id), false);
});

// --- what the homepage shows --------------------------------------------------

test("the homepage board shows a published card and links the catalogue's own watch page", async () => {
  const created = await call("post", "/api/admin/fixtures", {
    title: "Shown v Board",
    sport: "football",
    startsAt: KICKOFF,
    durationMinutes: 120,
    channels: [{ channelId: PINNED, sourceType: "direct" }],
    visible: true,
  });
  assert.equal(created.status, 200, `the match was refused: ${JSON.stringify(created.body)}`);
  const id = (created.body.fixture as { _id: string })._id;

  const board = await call("get", "/api/fixtures");
  assert.equal(board.status, 200, `the board was refused: ${JSON.stringify(board.body)}`);
  assert.equal(board.body.success, true);

  const card = (board.body.fixtures as { id: string; title: string; watchPath: string | null; choices: { name: string; watchPath: string | null }[] }[]).find(
    (entry) => entry.id === id
  );
  assert.ok(card, "the published card has to be on the board");
  assert.equal(card.title, "Shown v Board");
  // One channel to offer means a tap goes straight to it, on the route the Direct HLS tier has
  // always answered on.
  assert.equal(card.watchPath, `/watch/${PINNED}`);
  assert.equal(card.choices[0].name, "Pinned Sports One");
  assert.equal(card.choices[0].watchPath, `/watch/${PINNED}`);
});

test("an unpublished card stays off the board", async () => {
  const created = await call("post", "/api/admin/fixtures", {
    title: "Hidden v Board",
    sport: "football",
    startsAt: KICKOFF,
    durationMinutes: 120,
    channels: [{ channelId: PINNED, sourceType: "direct" }],
    visible: false,
  });
  assert.equal(created.status, 200);
  const id = (created.body.fixture as { _id: string })._id;

  const board = await call("get", "/api/fixtures");
  const ids = (board.body.fixtures as { id: string }[]).map((card) => card.id);
  assert.equal(ids.includes(id), false);
});

test("the admin's own list is the database's list", async () => {
  const answer = await call("get", "/api/admin/fixtures");

  assert.equal(answer.status, 200, `the list was refused: ${JSON.stringify(answer.body)}`);
  assert.equal(answer.body.dbMode, "mongodb");
  assert.equal(answer.body.count, db.fixtures.length);
  const ids = (answer.body.fixtures as { _id: string }[]).map((fixture) => fixture._id);
  assert.equal(ids.includes("64b5c72de29c995275489eaa"), true);
});
