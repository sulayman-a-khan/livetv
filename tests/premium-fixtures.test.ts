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
import { projectFixtures } from "../lib/fixtureBoard";

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

// --- the viewer projection (lib/fixtureBoard.ts) -------------------------------

test("a card only appears for a match on a premium channel the admin switched on", () => {
  const channel = { _id: "pc_one", name: "Example Sports HD", category: "Sports", logoUrl: "", active: true };
  const base = {
    _id: "fx_one",
    sport: "football" as const,
    teamA: "Team A",
    teamB: "Team B",
    teamALogo: "",
    teamBLogo: "",
    competition: "Test Cup",
    startsAt: new Date("2026-10-25T14:00:00.000Z").toISOString(),
    durationMinutes: 120,
    premiumChannelId: "pc_one",
    visible: true,
    phase: "upcoming" as const,
  };
  const now = new Date("2026-10-25T12:00:00.000Z");

  assert.equal(projectFixtures([base], [channel], now).length, 1);
  // No linked channel, a channel that is not in the list, and a switched-off one
  // all mean nobody can watch this match, so the card does not advertise it.
  assert.equal(projectFixtures([{ ...base, premiumChannelId: null }], [channel], now).length, 0);
  assert.equal(projectFixtures([base], [{ ...channel, active: false }], now).length, 0);
  assert.equal(projectFixtures([base], [], now).length, 0);
});

test("unpublished, finished and far-future matches stay off the board", () => {
  const channel = { _id: "pc_one", name: "Example Sports HD", category: "Sports", logoUrl: "", active: true };
  const now = new Date("2026-10-25T12:00:00.000Z");
  const base = {
    _id: "fx_one",
    sport: "football" as const,
    teamA: "Team A",
    teamB: "Team B",
    teamALogo: "",
    teamBLogo: "",
    competition: "",
    startsAt: new Date("2026-10-25T14:00:00.000Z").toISOString(),
    durationMinutes: 120,
    premiumChannelId: "pc_one",
    visible: true,
    phase: "upcoming" as const,
  };

  assert.equal(projectFixtures([{ ...base, visible: false }], [channel], now).length, 0);
  assert.equal(projectFixtures([{ ...base, phase: "finished" }], [channel], now).length, 0);
  // Two weeks out is the admin's schedule, not today's board.
  assert.equal(
    projectFixtures(
      [{ ...base, startsAt: new Date("2026-11-08T14:00:00.000Z").toISOString() }],
      [channel],
      now
    ).length,
    0
  );
  // 23 hours out still shows.
  assert.equal(
    projectFixtures(
      [{ ...base, startsAt: new Date("2026-10-26T11:00:00.000Z").toISOString() }],
      [channel],
      now
    ).length,
    1
  );
});

test("live matches lead the board, upcoming ones follow by kickoff, and three fill it", () => {
  const channel = { _id: "pc_one", name: "Example Sports HD", category: "Sports", logoUrl: "", active: true };
  const now = new Date("2026-10-25T12:00:00.000Z");
  const make = (id: string, startsAt: string, phase: "upcoming" | "live") => ({
    _id: id,
    sport: "cricket" as const,
    teamA: `A${id}`,
    teamB: `B${id}`,
    teamALogo: "",
    teamBLogo: "",
    competition: "",
    startsAt: new Date(startsAt).toISOString(),
    durationMinutes: 180,
    premiumChannelId: "pc_one",
    visible: true,
    phase,
  });

  const board = projectFixtures(
    [
      make("fx_c", "2026-10-25T18:00:00.000Z", "upcoming"),
      make("fx_l", "2026-10-25T11:00:00.000Z", "live"),
      make("fx_a", "2026-10-25T13:00:00.000Z", "upcoming"),
      make("fx_b", "2026-10-25T15:00:00.000Z", "upcoming"),
      make("fx_d", "2026-10-25T20:00:00.000Z", "upcoming"),
    ],
    [channel],
    now
  );

  assert.deepEqual(
    board.map((card) => `${card.id}:${card.phase}`),
    ["fx_l:live", "fx_a:upcoming", "fx_b:upcoming"]
  );
});

test("the projection names the channel but carries no source or header", () => {
  const channel = {
    _id: "pc_one",
    name: "Example Sports HD",
    category: "Sports",
    logoUrl: "https://host.example/logo.png",
    active: true,
  };
  const now = new Date("2026-10-25T12:00:00.000Z");
  const [card] = projectFixtures(
    [
      {
        _id: "fx_one",
        sport: "football" as const,
        teamA: "Team A",
        teamB: "Team B",
        teamALogo: "",
        teamBLogo: "",
        competition: "Test Cup",
        startsAt: now.toISOString(),
        durationMinutes: 120,
        premiumChannelId: "pc_one",
        visible: true,
        phase: "live" as const,
      },
    ],
    [channel],
    now
  );

  assert.equal(card.channelName, "Example Sports HD");
  assert.equal(card.channelLogo, "https://host.example/logo.png");
  assert.equal(card.channelCategory, "Sports");
  const leaked = Object.keys(card).filter((key) => /source|header|url/i.test(key));
  // channelLogo is the only URL a card may carry; it is the picture, not the stream.
  assert.deepEqual(leaked.filter((key) => key !== "channelLogo"), []);
});
