/**
 * The premium tier's half of the stale-reference rule (P11.12).
 *
 * This file is archived with the rest of the Secured HLS / Premium tier. It is not compiled
 * or run while the tier is archived — `tsconfig.json` excludes `archive/` — and it is kept
 * here so that restoring the tier does not have to reconstruct it from git history.
 *
 * On restoration, move this file back to `tests/fixture-stale-links-premium.test.ts` and put
 * it back into `tsconfig.tests.json` and `package.json`. Its requires are already written
 * against the paths the file had when it was active: `../lib/premiumStore` and
 * `@/models/PremiumChannel`, both of which live in `archive/secured-hls-premium/` and are
 * moved back to `lib/` and `models/` by the same restoration.
 *
 * The rule it locks: deleting a premium channel takes its link off every card, so a dangling
 * id does not survive the one operation that is able to repair it.
 *
 * Nothing here reaches a database or the network: the catalogue and the cards are stood in for
 * (`tests/helpers/fakeFixtureModel.ts`), and this project's own `data/` is never read or written.
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
process.env.ADMIN_SECRET_KEY = "stale-links-premium-test-secret";

/** A catalogue row the app is showing, and one it is deliberately not. */
const PINNED = "6ab5c72de29c995275489e5c";
const UNPINNED = "6ab5c72de29c995275489e5d";
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

/**
 * The premium tier's own rows, as far as the delete below reaches them: one channel, and the
 * one call a delete makes on it.
 */
const premiumModule = require("@/models/PremiumChannel") as { default: unknown };
const originalPremiumModel = premiumModule.default;
let premiumRows: { _id: string }[] = [];
premiumModule.default = {
  async deleteOne(filter: { _id?: string }) {
    const index = premiumRows.findIndex((row) => String(row._id) === String(filter?._id));
    if (index < 0) return { deletedCount: 0 };
    premiumRows.splice(index, 1);
    return { deletedCount: 1 };
  },
};

after(() => {
  premiumModule.default = originalPremiumModel;
  db.restore();
});

type PremiumStore = typeof import("../lib/premiumStore");
type FixtureStore = typeof import("../lib/fixtureStore");

const store: PremiumStore = require("../lib/premiumStore");
const fixtureStore: FixtureStore = require("../lib/fixtureStore");

// --- deleting a channel repairs every card that named it ---

test("deleting a premium channel takes its link off every card and leaves the match alone", async () => {
  premiumRows = [{ _id: "64b5c72de29c995275489e01" }];

  db.fixtures.push({
    _id: "64b5c72de29c995275489e10",
    title: "Mohammedan v Bashundhara",
    sport: "football",
    teamA: "Mohammedan",
    teamB: "Bashundhara",
    teamALogo: "",
    teamBLogo: "",
    competition: "BPL",
    startsAt: new Date("2026-11-05T16:00:00.000Z"),
    durationMinutes: 120,
    channels: [
      { channelId: "64b5c72de29c995275489e01", sourceType: "secured" },
      { channelId: PINNED, sourceType: "direct" },
    ],
    visible: true,
  });

  assert.equal(await store.deletePremiumChannel("64b5c72de29c995275489e01"), true);

  // The match is still there — only the admin decides a match is gone — and the link to the
  // deleted channel is not.
  const cards = await fixtureStore.listFixtures();
  const kept = cards.find((entry) => entry._id === "64b5c72de29c995275489e10");
  assert.ok(kept, "deleting a channel must not delete the match");
  assert.equal(kept.teamA, "Mohammedan");
  assert.deepEqual(kept.channels, [{ channelId: PINNED, sourceType: "direct" }]);
});
