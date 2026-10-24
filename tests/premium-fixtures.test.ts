/**
 * Focused tests for the premium tier's entry rules (`lib/premiumFixtures.ts`).
 *
 * Run with `npm run test:premium-fixtures` — that compiles the pure rule modules
 * plus this file into `.tmp-tests/` and runs them on Node's own test runner.
 * Nothing here touches MongoDB, the network or a running server.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countdownMs,
  fixturePhase,
  validateFixtureInput,
  validatePremiumChannelInput,
} from "../lib/premiumFixtures";

const GOOD_CHANNEL = {
  name: "Example Sports HD",
  sourceUrl: "https://host.example/live/one/index.m3u8",
};

test("a premium channel needs a name and an http(s) source", () => {
  assert.deepEqual(validatePremiumChannelInput({}, true).errors, [
    "Channel name is required",
    "Source URL is required",
  ]);

  const wrongScheme = validatePremiumChannelInput(
    { name: "X", sourceUrl: "ftp://host/one.m3u8" },
    true
  );
  assert.deepEqual(wrongScheme.errors, ["Source URL must be a valid http(s) URL"]);

  const good = validatePremiumChannelInput(GOOD_CHANNEL, true);
  assert.deepEqual(good.errors, []);
  // The fields the admin left alone arrive as their defaults, so a stored row is
  // always complete rather than partly absent.
  assert.equal(good.value.category, "Premium");
  assert.equal(good.value.active, true);
  assert.equal(good.value.sortOrder, 99);
  assert.deepEqual(good.value.headers, { userAgent: "", referer: "" });
});

test("a patch only validates the keys that were sent", () => {
  // A single switch flip is the commonest write and must never re-ask for the URL.
  const toggle = validatePremiumChannelInput({ active: false }, false);
  assert.deepEqual(toggle.errors, []);
  assert.deepEqual(toggle.value, { active: false });

  // With `creating` the same body is rejected, so a create cannot arrive half-empty.
  assert.equal(validatePremiumChannelInput({ active: false }, true).errors.length, 2);
});

test("a rail position outside the form's own range is refused", () => {
  assert.equal(validatePremiumChannelInput({ sortOrder: 0 }, false).errors.length, 1);
  assert.equal(validatePremiumChannelInput({ sortOrder: 1000 }, false).errors.length, 1);
  assert.equal(validatePremiumChannelInput({ sortOrder: 3 }, false).value.sortOrder, 3);
});

test("headers are read as a pair and a bad referer is named as such", () => {
  const patch = validatePremiumChannelInput(
    { headers: { userAgent: "Mozilla/5.0", referer: "not a url" } },
    false
  );
  assert.deepEqual(patch.errors, ["Referer must be a valid http(s) URL"]);

  const ok = validatePremiumChannelInput(
    { headers: { userAgent: "Mozilla/5.0", referer: "https://partner.example" } },
    false
  );
  assert.deepEqual(ok.value.headers, {
    userAgent: "Mozilla/5.0",
    referer: "https://partner.example",
  });
});

const GOOD_FIXTURE = {
  sport: "football",
  teamA: "Mohammedan",
  teamB: "Bashundhara",
  startsAt: "2026-10-25T16:00:00.000Z",
};

test("a fixture is football or cricket, needs both teams and a real kickoff", () => {
  const empty = validateFixtureInput({}, true);
  assert.deepEqual(empty.errors, [
    "Sport is required",
    "Team A is required",
    "Team B is required",
    "Kickoff time is required",
  ]);

  const wrongSport = validateFixtureInput(
    { ...GOOD_FIXTURE, sport: "tennis" },
    true
  );
  assert.equal(wrongSport.errors[0], "Sport must be one of: football, cricket");

  const nonsenseDate = validateFixtureInput({ ...GOOD_FIXTURE, startsAt: "next friday" }, true);
  assert.deepEqual(nonsenseDate.errors, ["Kickoff time must be a real date and time"]);

  const good = validateFixtureInput(GOOD_FIXTURE, true);
  assert.deepEqual(good.errors, []);
  // A newly entered match starts unpublished: an unwanted match on the homepage is
  // the failure this feature has to avoid, so publishing is always deliberate.
  assert.equal(good.value.visible, false);
  assert.equal(good.value.durationMinutes, 120);
  assert.equal(good.value.premiumChannelId, null);
});

test("an unlinked fixture is spelled as empty and stored as null", () => {
  assert.equal(validateFixtureInput({ premiumChannelId: "" }, false).value.premiumChannelId, null);
  assert.equal(validateFixtureInput({ premiumChannelId: null }, false).value.premiumChannelId, null);
  assert.equal(
    validateFixtureInput({ premiumChannelId: "6ab5c72de29c995275489e5c" }, false).value
      .premiumChannelId,
    "6ab5c72de29c995275489e5c"
  );
  assert.deepEqual(validateFixtureInput({ premiumChannelId: "   " }, false).errors, []);
});

test("a fixture is upcoming before kickoff, live until its length runs out", () => {
  const kickoff = new Date("2026-10-25T14:00:00.000Z");
  const before = new Date("2026-10-25T13:59:59.000Z");
  const midway = new Date("2026-10-25T15:30:00.000Z");
  const past = new Date("2026-10-25T16:00:01.000Z");

  assert.equal(fixturePhase(kickoff, 120, before), "upcoming");
  assert.equal(fixturePhase(kickoff, 120, kickoff), "live");
  assert.equal(fixturePhase(kickoff, 120, midway), "live");
  assert.equal(fixturePhase(kickoff, 120, past), "finished");
  // A zero or negative length would strand a card on LIVE forever, so the shortest
  // window the rule allows is one minute: still live at 30 seconds, finished past it.
  assert.equal(fixturePhase(kickoff, 0, new Date("2026-10-25T14:00:30.000Z")), "live");
  assert.equal(fixturePhase(kickoff, 0, midway), "finished");
  assert.equal(fixturePhase(kickoff, -60, new Date("2026-10-25T14:00:59.000Z")), "live");

  assert.equal(countdownMs(kickoff, before), 1000);
  assert.equal(countdownMs(kickoff, past), 0);
});
