/**
 * Tests for what the fixture editor sends and what the tier keeps (the match title and the
 * playback order).
 *
 * Run with `npm run test:fixture-editor`.
 *
 * Two things are checked here against the real route and the real store:
 *
 *  - a match entered with a title keeps that title, and the two teams are read out of it;
 *  - the channels a card names are kept in the order the admin put them in, because that order
 *    is the priority the board offers them in and the order a fallback moves through.
 *
 * Nothing here reaches a database or the network: the tier writes to its own store file in a
 * temporary directory, and this project's own `data/` is never read or written.
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
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "freetv-fixture-editor-"));

process.chdir(sandbox);
delete process.env.MONGODB_URI;
delete process.env.VERCEL;
process.env.ADMIN_SECRET_KEY = "fixture-editor-test-secret";

type PremiumStore = typeof import("../lib/premiumStore");
const store: PremiumStore = require("../lib/premiumStore");

after(() => {
  process.chdir(projectCwd);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** The route's own answer, as the fields the contract is written in. */
async function post(
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { NextRequest } = require("next/server");
  const { POST } = require("../app/api/admin/fixtures/route.js");
  const res = await POST(
    new NextRequest("http://localhost/api/admin/fixtures", {
      method: "POST",
      headers: {
        "x-admin-secret": process.env.ADMIN_SECRET_KEY as string,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A premium channel a card may name, created through the tier's own store. */
async function securedChannel(name: string): Promise<string> {
  const channel = await store.createPremiumChannel({
    name,
    category: "Sports",
    logoUrl: "",
    active: true,
    sortOrder: 99,
    note: "",
    proxyChannelKey: "",
  });
  return channel._id;
}

test("a match entered with a title keeps that title, and the teams come out of it", async () => {
  const answer = await post({
    title: "Bangladesh vs India",
    sport: "cricket",
    startsAt: "2026-10-30T16:00:00.000Z",
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
  const answer = await post({
    title: "Opening ceremony",
    teamA: "One",
    teamB: "Two",
    sport: "football",
    startsAt: "2026-10-30T16:00:00.000Z",
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
  const first = await securedChannel("Editor Sports One");
  const second = await securedChannel("Editor Sports Two");

  const answer = await post({
    title: "One vs Two",
    sport: "football",
    startsAt: "2026-10-30T16:00:00.000Z",
    durationMinutes: 120,
    channels: [
      { channelId: second, sourceType: "secured" },
      { channelId: first, sourceType: "secured" },
    ],
    visible: false,
  });

  assert.equal(answer.status, 200, `the match was refused: ${JSON.stringify(answer.body)}`);
  const fixture = answer.body.fixture as { channels: { channelId: string }[] };
  // The order is the admin's, not the store's: it is the order the card tries its channels in
  // and the order a fallback moves through, so nothing may sort it on the way in.
  assert.deepEqual(
    fixture.channels.map((ref) => ref.channelId),
    [second, first]
  );
});

test("the card's channels are read back in the admin's order, for the fallback walk", async () => {
  const first = await securedChannel("Editor Sports Three");
  const second = await securedChannel("Editor Sports Four");

  const answer = await post({
    title: "Three vs Four",
    sport: "football",
    startsAt: "2026-10-30T16:00:00.000Z",
    durationMinutes: 120,
    channels: [
      { channelId: first, sourceType: "secured" },
      { channelId: second, sourceType: "secured" },
    ],
    visible: true,
  });

  assert.equal(answer.status, 200, `the match was refused: ${JSON.stringify(answer.body)}`);

  const { listCardChannelsFor } = require("../lib/fixtureSources");

  // A card nobody can see is not a reason to move a viewer anywhere, so it offers nothing — and
  // it must not take the card's place either, or a hidden card would decide where a failure goes.
  const hidden = await post({
    title: "Five vs Six",
    sport: "football",
    startsAt: "2026-10-30T16:00:00.000Z",
    durationMinutes: 120,
    channels: [{ channelId: first, sourceType: "secured" }],
    visible: false,
  });
  assert.equal(hidden.status, 200, `the match was refused: ${JSON.stringify(hidden.body)}`);

  const order = await listCardChannelsFor(first);

  // The order the fallback walks in is the order the admin put the channels in, read from the
  // card rather than rebuilt — so a card that names one channel and another that names three
  // answers the same question the same way.
  assert.deepEqual(
    order.map((ref: { channelId: string }) => ref.channelId),
    [first, second]
  );
  assert.deepEqual(
    order.map((ref: { sourceType: string }) => ref.sourceType),
    ["secured", "secured"]
  );
});
