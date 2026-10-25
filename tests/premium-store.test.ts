/**
 * Regression tests for the premium tier's storage rules (`lib/premiumStore.ts`).
 *
 * Run with `npm run test:premium-store`. That compiles the real store, the tier's own
 * local store file and `lib/db.ts` into `.tmp-tests/` and runs them here with no database
 * reachable, so the branch under test is the one a deployment takes when Atlas does not
 * answer: `connectToDatabase()` resolves to null, exactly as it does for an unset URI
 * (`lib/db.ts:52`) and for a connection that fails (`lib/db.ts:69`).
 *
 * Nothing connects, and the tier's local store file is written into a temporary directory
 * rather than this project's own `data/`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// --- the sandbox: this file's working directory is where the local store keeps itself ---

type NodeModuleWithHook = typeof Module & {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};

/**
 * The compiled store reaches its siblings through the app's `@/` alias, which the compiler
 * leaves in the emitted `require`. Point it at `.tmp-tests` so these tests load the real
 * modules rather than a stand-in for them.
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
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "freetv-premium-store-"));
/** Whether this project kept its own copy of each file before anything ran. */
const projectStoreFiles = {
  premium: path.join(projectCwd, "data", "premium-store.json"),
  catalogue: path.join(projectCwd, "data", "store.json"),
};
const existedBefore = {
  premium: fs.existsSync(projectStoreFiles.premium),
  catalogue: fs.existsSync(projectStoreFiles.catalogue),
};

process.chdir(sandbox);
// A blank URI is the shape of "this process has no database", and `VERCEL` is what
// `mustUseDatabase` reads — both are set per test below, before anything is loaded.
delete process.env.MONGODB_URI;
delete process.env.VERCEL;

type PremiumStore = typeof import("../lib/premiumStore");
const store: PremiumStore = require("../lib/premiumStore");

after(() => {
  process.chdir(projectCwd);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// --- the inputs, straight from what the admin panel sends ---

const CHANNEL_INPUT = {
  name: "Example Sports HD",
  category: "Premium",
  logoUrl: "",
  active: true,
  sortOrder: 99,
  note: "",
  proxyChannelKey: "",
};

const FIXTURE_INPUT = {
  sport: "football" as const,
  teamA: "Mohammedan",
  teamB: "Bashundhara",
  teamALogo: "",
  teamBLogo: "",
  competition: "BPL",
  startsAt: new Date("2026-10-25T16:00:00.000Z"),
  durationMinutes: 120,
  premiumChannelId: null as string | null,
  visible: false,
};

/** A real row's id: this is what a production panel is sending when the write arrives. */
const OBJECT_ID = "64b5c72de29c995275489e5c";

/**
 * A refusal has to say both what happened to the request and what it did not do, because
 * the admin reads this sentence on screen and decides from it whether to try again.
 */
function refusedWith(action: string) {
  return (err: unknown) => {
    const e = err as Error & { status?: number };
    assert.equal(
      e.status,
      503,
      `a refusal must carry the status the route hands back, got ${e.status}: ${e.message}`
    );
    assert.equal(e.message, `Database unavailable — ${action}`);
    return true;
  };
}

test("a deployment with no database refuses every premium write instead of answering from its local store", async () => {
  process.env.VERCEL = "1";

  await assert.rejects(() => store.createPremiumChannel(CHANNEL_INPUT), refusedWith("nothing was saved"));
  await assert.rejects(
    () => store.updatePremiumChannel(OBJECT_ID, { active: false }),
    refusedWith("nothing was saved")
  );
  await assert.rejects(
    () => store.setPremiumProxy(OBJECT_ID, { proxyChannelKey: "prem-one", proxyPushedAt: new Date() }),
    refusedWith("nothing was saved")
  );
  await assert.rejects(() => store.deletePremiumChannel(OBJECT_ID), refusedWith("nothing was deleted"));

  await assert.rejects(() => store.createFixture(FIXTURE_INPUT), refusedWith("nothing was saved"));
  await assert.rejects(
    () => store.updateFixture(OBJECT_ID, { visible: true }),
    refusedWith("nothing was saved")
  );
  await assert.rejects(() => store.deleteFixture(OBJECT_ID), refusedWith("nothing was deleted"));

  // The link check gates a write, so it refuses too rather than reporting a live
  // channel as missing from the list.
  await assert.rejects(
    () => store.premiumChannelExists(OBJECT_ID),
    refusedWith("the premium list could not be checked")
  );

  // None of those refusals wrote anything: the tier's local store file was never created,
  // and the tier still reports itself as empty instead of half-saved.
  assert.equal(fs.existsSync(path.join(sandbox, "data", "premium-store.json")), false);
  assert.equal((await store.listPremiumChannels()).length, 0);
  assert.equal((await store.listFixtures()).length, 0);
  // And the Direct HLS catalogue's own store was not brought into this at all.
  assert.equal(fs.existsSync(path.join(sandbox, "data", "store.json")), false);
});

test("a deployment still reads the local store rather than 503-ing a page that advertises nothing", async () => {
  process.env.VERCEL = "1";

  // Reads are unguarded on purpose. An empty premium list shows no card and plays no
  // stream, so a viewer-facing page fails honestly; only a write can lie about success.
  assert.deepEqual(await store.listPremiumChannels(), []);
  assert.deepEqual(await store.listFixtures(), []);
  assert.equal(await store.getPublicPremiumChannel(OBJECT_ID), null);
});

test("off a deployment the same writes go to the tier's own local store and answer on the next read", async () => {
  delete process.env.VERCEL;

  // The refusals above left nothing behind, so this is a clean tier.
  assert.equal((await store.listPremiumChannels()).length, 0);

  const channel = await store.createPremiumChannel(CHANNEL_INPUT);
  assert.match(channel._id, /^pc_/);
  assert.equal(channel.name, "Example Sports HD");
  // A premium row starts with no stream: the source lives on the box, not here.
  assert.equal(channel.sourceUrl, "");
  assert.equal(channel.proxyChannelKey, "");
  assert.equal(channel.proxyPushedAt, null);

  assert.equal((await store.listPremiumChannels()).length, 1);
  assert.equal(await store.premiumChannelExists(channel._id), true);

  const renamed = await store.updatePremiumChannel(channel._id, { active: false });
  assert.equal(renamed?.active, false);
  assert.equal(renamed?.name, "Example Sports HD");

  const pushed = await store.setPremiumProxy(channel._id, {
    proxyChannelKey: "prem-one",
    proxyPushedAt: new Date("2026-10-26T09:00:00.000Z"),
  });
  assert.equal(pushed?.proxyChannelKey, "prem-one");
  assert.equal(pushed?.proxyPushedAt, "2026-10-26T09:00:00.000Z");

  const fixture = await store.createFixture({ ...FIXTURE_INPUT, premiumChannelId: channel._id });
  assert.match(fixture._id, /^fx_/);
  assert.equal(fixture.premiumChannelId, channel._id);
  assert.equal(fixture.visible, false);

  const published = await store.updateFixture(fixture._id, { visible: true });
  assert.equal(published?.visible, true);
  assert.equal(published?.teamA, "Mohammedan");

  // What was written is on disk in this sandbox, in the tier's own file only.
  const file = path.join(sandbox, "data", "premium-store.json");
  assert.ok(fs.existsSync(file));
  const written = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.deepEqual(
    written.premiumChannels.map((row: { _id: string }) => row._id),
    [channel._id]
  );
  assert.deepEqual(
    written.fixtures.map((row: { _id: string }) => row._id),
    [fixture._id]
  );

  assert.equal(await store.deleteFixture(fixture._id), true);
  assert.equal((await store.listFixtures()).length, 0);
  assert.equal(await store.deletePremiumChannel(channel._id), true);
  assert.equal((await store.listPremiumChannels()).length, 0);
  assert.equal(await store.premiumChannelExists(channel._id), false);
});

test("the local run never touched this project's own data files", () => {
  assert.equal(fs.existsSync(projectStoreFiles.premium), existedBefore.premium);
  assert.equal(fs.existsSync(projectStoreFiles.catalogue), existedBefore.catalogue);
});
