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
  validatePremiumSourcePush,
} from "../lib/premiumFixtures";
import {
  projectFixtures,
  type BoardChannel,
  type BoardFixture,
  type PublicFixture,
} from "../lib/fixtureBoard";

/**
 * The projection now also asks what the stream box said about itself before it offers a watch
 * link. These tests are about which cards appear, so they answer "ready" — the gate's own
 * behaviour is the test that closes this file.
 */
const READY_BOARD = (
  fixtures: BoardFixture[],
  channels: BoardChannel[],
  now: Date
): PublicFixture[] => projectFixtures(fixtures, channels, now, true);

/** A linked channel, spelled the way a stored row spells it. */
const secured = (channelId: string) => ({ channelId, sourceType: "secured" as const });
const direct = (channelId: string) => ({ channelId, sourceType: "direct" as const });

const GOOD_CHANNEL = {
  name: "Example Sports HD",
  proxyChannelKey: "prem-example-sports",
};

test("a premium channel needs a name, and its box handle must be a lane name", () => {
  assert.deepEqual(validatePremiumChannelInput({}, true).errors, ["Channel name is required"]);

  // A handle is the only thing a row keeps about where the stream comes from, so it has to
  // be spellable by the box: a space or a slash would be refused there over an unrelated field.
  const badKey = validatePremiumChannelInput(
    { name: "X", proxyChannelKey: "Prem Example/sports" },
    true
  );
  assert.deepEqual(badKey.errors, [
    "Stream box handle must be 2-64 characters of letters, digits, - or _",
  ]);

  const good = validatePremiumChannelInput(GOOD_CHANNEL, true);
  assert.deepEqual(good.errors, []);
  // The fields the admin left alone arrive as their defaults, so a stored row is
  // always complete rather than partly absent.
  assert.equal(good.value.category, "Premium");
  assert.equal(good.value.active, true);
  assert.equal(good.value.sortOrder, 99);
  assert.equal(good.value.proxyChannelKey, "prem-example-sports");

  const noKey = validatePremiumChannelInput({ name: "X" }, true);
  assert.deepEqual(noKey.errors, []);
  assert.equal(noKey.value.proxyChannelKey, "");

  // Entered in any case, stored in the box's own.
  assert.equal(
    validatePremiumChannelInput({ proxyChannelKey: "Prem-MixEd1" }, false).value.proxyChannelKey,
    "prem-mixed1"
  );
});

test("a patch only validates the keys that were sent", () => {
  // A single switch flip is the commonest write and must never re-ask for the name.
  const toggle = validatePremiumChannelInput({ active: false }, false);
  assert.deepEqual(toggle.errors, []);
  assert.deepEqual(toggle.value, { active: false });

  // With `creating` the same body is rejected, so a create cannot arrive half-empty.
  assert.equal(validatePremiumChannelInput({ active: false }, true).errors.length, 1);
});

test("a rail position outside the form's own range is refused", () => {
  assert.equal(validatePremiumChannelInput({ sortOrder: 0 }, false).errors.length, 1);
  assert.equal(validatePremiumChannelInput({ sortOrder: 1000 }, false).errors.length, 1);
  assert.equal(validatePremiumChannelInput({ sortOrder: 3 }, false).value.sortOrder, 3);
});

test("a push to the box carries one manifest URL and at most two headers", () => {
  assert.deepEqual(validatePremiumSourcePush({}).errors, ["Source URL is required"]);
  assert.deepEqual(validatePremiumSourcePush({ sourceUrl: "ftp://host/one.m3u8" }).errors, [
    "Source URL must be a valid http(s) URL",
  ]);
  assert.deepEqual(
    validatePremiumSourcePush({ sourceUrl: `https://host/${"x".repeat(2100)}` }).errors,
    ["Source URL must be a valid http(s) URL"]
  );

  const ok = validatePremiumSourcePush({
    sourceUrl: "https://host/live/one/index.m3u8?token=abc",
    userAgent: "Mozilla/5.0",
    referer: "https://partner.example",
  });
  assert.deepEqual(ok.errors, []);
  // All three keys are always answered, so the route that pushes never has to guess at
  // an absent header.
  assert.deepEqual(ok.value, {
    sourceUrl: "https://host/live/one/index.m3u8?token=abc",
    userAgent: "Mozilla/5.0",
    referer: "https://partner.example",
  });

  // A header value with a line break in it is a second header by the time it reaches the
  // origin, so it is refused here rather than arriving as an unexplained transport error.
  assert.deepEqual(validatePremiumSourcePush({ sourceUrl: "https://h/a.m3u8", userAgent: "A\r\nX-Injected: 1" }).errors, [
    "User-Agent must not contain a line break",
  ]);
  assert.deepEqual(validatePremiumSourcePush({ sourceUrl: "https://h/a.m3u8", referer: "/relative" }).errors, [
    "Referer must be an absolute URL, or empty",
  ]);
  assert.deepEqual(validatePremiumSourcePush({ sourceUrl: "https://h/a.m3u8", referer: "ftp://h" }).errors, [
    "Referer must be an http(s) URL",
  ]);
  // No headers at all is the normal case: the source needs nothing of its own.
  assert.deepEqual(validatePremiumSourcePush({ sourceUrl: "https://h/a.m3u8" }).value, {
    sourceUrl: "https://h/a.m3u8",
    userAgent: "",
    referer: "",
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
  assert.deepEqual(good.value.channels, []);
});

/** The first error a payload produced, which is what the admin reads on screen. */
const firstError = (body: Record<string, unknown>) =>
  validateFixtureInput({ ...GOOD_FIXTURE, channels: body.channels }, true).errors;

test("a card can be linked to one channel, several, or channels from both tiers", () => {
  const directOnly = validateFixtureInput(
    { channels: [direct("6ab5c72de29c995275489e5c")] },
    false
  );
  assert.deepEqual(directOnly.errors, []);
  assert.deepEqual(directOnly.value.channels, [
    { channelId: "6ab5c72de29c995275489e5c", sourceType: "direct" },
  ]);

  const securedOnly = validateFixtureInput({ channels: [secured("pc_one")] }, false);
  assert.deepEqual(securedOnly.errors, []);

  const mixed = validateFixtureInput({
    channels: [direct("6ab5c72de29c995275489e5c"), secured("pc_one"), secured("pc_two")],
  }, false);
  assert.deepEqual(mixed.errors, []);
  // Order is the admin's, not the store's: the card offers the choices in the order they were
  // picked, so the projection must not sort them into a canonical shape.
  assert.deepEqual(mixed.value.channels, [
    { channelId: "6ab5c72de29c995275489e5c", sourceType: "direct" },
    { channelId: "pc_one", sourceType: "secured" },
    { channelId: "pc_two", sourceType: "secured" },
  ]);

  // Nothing linked at all is an answer, not a missing field: a match can be entered with its
  // schedule and its channel chosen later.
  const none = validateFixtureInput({ channels: [] }, false);
  assert.deepEqual(none.errors, []);
  assert.deepEqual(none.value.channels, []);
});

test("a reference that is not an id plus a known source is refused", () => {
  // The tier is what tells a tap which playback route and which authorization flow it belongs
  // to, so a card cannot be allowed to guess it.
  assert.deepEqual(firstError({ channels: [{ channelId: "pc_one", sourceType: "premium" }] }), [
    "Linked channel 1 source must be one of: direct, secured",
  ]);
  assert.deepEqual(firstError({ channels: [{ channelId: "pc_one" }] }), [
    "Linked channel 1 source must be one of: direct, secured",
  ]);
  assert.deepEqual(firstError({ channels: ["pc_one"] }), [
    "Linked channel 1 must name a channel id and a source",
  ]);

  // An id is an id: no spaces, no path, no URL dressed as one.
  assert.deepEqual(firstError({ channels: [{ channelId: "https://host/a.m3u8", sourceType: "secured" }] }), [
    "Linked channel 1 id is not valid",
  ]);
  assert.deepEqual(firstError({ channels: [{ channelId: "pc one", sourceType: "secured" }] }), [
    "Linked channel 1 id is not valid",
  ]);
  assert.deepEqual(firstError({ channels: [{ channelId: "", sourceType: "secured" }] }), [
    "Linked channel 1 id is not valid",
  ]);

  // Direct catalogue rows are ObjectId-keyed in production and in the local mirror alike, so
  // anything looser would name a channel that cannot exist.
  assert.deepEqual(
    firstError({ channels: [{ channelId: "ch_spotlight", sourceType: "direct" }] }),
    ["Linked channel 1 id must be a 24-character catalogue channel id"]
  );

  // The list is a list, and short enough to choose from.
  assert.deepEqual(firstError({ channels: "pc_one" }), ["Linked channel must be a list of channels"]);
  assert.deepEqual(
    firstError({ channels: Array.from({ length: 9 }, (_, i) => secured(`pc_${i}`)) }),
    ["Linked channel can hold at most 8 channels"]
  );
  assert.deepEqual(
    firstError({ channels: [secured("pc_one"), secured("pc_one")] }),
    ["Linked channel 2 is listed twice"]
  );
});

test("a reference carries no key beyond an id and a source, because a card is public", () => {
  // This is the whole reason the shape is closed: a fixture row is what the viewer board reads,
  // so a source line, a header or a token smuggled onto it would leave the tier's own vault and
  // arrive in a browser. Refused, not stripped — an admin must hear that it did not land.
  assert.deepEqual(
    firstError({
      channels: [
        { channelId: "pc_one", sourceType: "secured", sourceUrl: "https://origin.internal/a.m3u8" },
      ],
    }),
    ["Linked channel 1 carries sourceUrl — a linked channel stores only an id and a source"]
  );
  assert.deepEqual(
    firstError({ channels: [{ channelId: "pc_one", sourceType: "secured", headers: { userAgent: "X" } }] }),
    ["Linked channel 1 carries headers — a linked channel stores only an id and a source"]
  );
  assert.deepEqual(
    firstError({ channels: [{ channelId: "pc_one", sourceType: "secured", token: "hunter2" }] }),
    ["Linked channel 1 carries token — a linked channel stores only an id and a source"]
  );
});

test("the single-channel field is refused instead of being reinterpreted", () => {
  // It named a premium row and nothing else, but a write that still sends it would be storing
  // a second, vaguer answer to "where is this match watched".
  assert.deepEqual(validateFixtureInput({ premiumChannelId: "pc_one" }, false).errors, [
    "Linked channel is now sent as a channels list with a source for each entry",
  ]);
  assert.equal(validateFixtureInput({ premiumChannelId: "pc_one" }, false).value.channels, undefined);
  // Reading a row that still holds it is a different question, and is answered in
  // `tests/premium-store.test.ts`.
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
  const channel = {
    _id: "pc_one",
    name: "Example Sports HD",
    category: "Sports",
    logoUrl: "",
    active: true,
    proxyChannelKey: "prem-one",
  };
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
    channels: [secured("pc_one")],
    visible: true,
    phase: "upcoming" as const,
  };
  const now = new Date("2026-10-25T12:00:00.000Z");

  assert.equal(READY_BOARD([base], [channel], now).length, 1);
  // No linked channel, a channel that is not in the list, and a switched-off one
  // all mean nobody can watch this match, so the card does not advertise it.
  assert.equal(READY_BOARD([{ ...base, channels: [] }], [channel], now).length, 0);
  assert.equal(READY_BOARD([base], [{ ...channel, active: false }], now).length, 0);
  assert.equal(READY_BOARD([base], [], now).length, 0);
});

test("unpublished, finished and far-future matches stay off the board", () => {
  const channel = {
    _id: "pc_one",
    name: "Example Sports HD",
    category: "Sports",
    logoUrl: "",
    active: true,
    proxyChannelKey: "prem-one",
  };
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
    channels: [secured("pc_one")],
    visible: true,
    phase: "upcoming" as const,
  };

  assert.equal(READY_BOARD([{ ...base, visible: false }], [channel], now).length, 0);
  assert.equal(READY_BOARD([{ ...base, phase: "finished" }], [channel], now).length, 0);
  // Two weeks out is the admin's schedule, not today's board.
  assert.equal(
    READY_BOARD(
      [{ ...base, startsAt: new Date("2026-11-08T14:00:00.000Z").toISOString() }],
      [channel],
      now
    ).length,
    0
  );
  // 23 hours out still shows.
  assert.equal(
    READY_BOARD(
      [{ ...base, startsAt: new Date("2026-10-26T11:00:00.000Z").toISOString() }],
      [channel],
      now
    ).length,
    1
  );
});

test("live matches lead the board, upcoming ones follow by kickoff, and three fill it", () => {
  const channel = {
    _id: "pc_one",
    name: "Example Sports HD",
    category: "Sports",
    logoUrl: "",
    active: true,
    proxyChannelKey: "prem-one",
  };
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
    channels: [secured("pc_one")],
    visible: true,
    phase,
  });

  const board = READY_BOARD(
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
    proxyChannelKey: "prem-one",
  };
  const now = new Date("2026-10-25T12:00:00.000Z");
  const [card] = READY_BOARD(
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
        channels: [secured("pc_one")],
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
  // The card's own address on this site, so a tap can reach the premium watch route.
  assert.equal(card.watchPath, "/premium/pc_one");
  const leaked = Object.keys(card).filter((key) => /source|header|token|stream|proxy/i.test(key));
  assert.deepEqual(leaked, []);
  // The only absolute URL a card may carry is the picture; nothing on it names a server
  // a viewer could ask for a stream from.
  const urls = Object.values(card).filter(
    (value) => typeof value === "string" && /^https?:\/\//i.test(value)
  );
  assert.deepEqual(urls, ["https://host.example/logo.png"]);
});

test("a channel with nothing on the box still makes a card, just not a link", () => {
  const now = new Date("2026-10-25T12:00:00.000Z");
  const [card] = READY_BOARD(
    [
      {
        _id: "fx_one",
        sport: "football" as const,
        teamA: "Team A",
        teamB: "Team B",
        teamALogo: "",
        teamBLogo: "",
        competition: "",
        startsAt: now.toISOString(),
        durationMinutes: 120,
        channels: [secured("pc_one")],
        visible: true,
        phase: "live" as const,
      },
    ],
    [
      {
        _id: "pc_one",
        name: "Example Sports HD",
        category: "Sports",
        logoUrl: "",
        active: true,
        proxyChannelKey: "",
      },
    ],
    now
  );

  // Tapping it would open a player with nothing to play, so the card stays a card.
  assert.equal(card.watchPath, null);
});

// --- the readiness gate (the box's own verdict, not a row's intentions) ---------

const GATED_FIXTURE = {
  _id: "fx_one",
  sport: "football" as const,
  teamA: "Mohammedan",
  teamB: "Bashundhara",
  teamALogo: "",
  teamBLogo: "",
  competition: "BPL",
  startsAt: new Date("2026-10-25T11:00:00.000Z").toISOString(),
  durationMinutes: 120,
  channels: [secured("pc_one")],
  visible: true,
  phase: "live" as const,
};

const PUSHED_CHANNEL = {
  _id: "pc_one",
  name: "Example Sports HD",
  category: "Sports",
  logoUrl: "",
  active: true,
  proxyChannelKey: "prem-one",
};

test("a watch link needs the box to say it is ready, not merely a row that means to have one", () => {
  const now = new Date("2026-10-25T12:00:00.000Z");

  const ready = projectFixtures([GATED_FIXTURE], [PUSHED_CHANNEL], now, true);
  // Both ways the gate can say no — the box reporting itself down, and nobody having heard from
  // it at all — reach the projection as `false`, because a board that cannot promise a stream
  // must not link one.
  const notReady = projectFixtures([GATED_FIXTURE], [PUSHED_CHANNEL], now, false);

  assert.equal(ready[0].watchPath, "/premium/pc_one");
  // A row that has a handle is an intention the admin had, not a stream the box can deliver.
  assert.equal(notReady[0].watchPath, null);
});

test("an outage takes the watch away and leaves the match on the board", () => {
  const now = new Date("2026-10-25T12:00:00.000Z");
  const ready = projectFixtures([GATED_FIXTURE], [PUSHED_CHANNEL], now, true)[0];
  const notReady = projectFixtures([GATED_FIXTURE], [PUSHED_CHANNEL], now, false)[0];

  // Same card, same metadata, same channel named on it: only the offer of a stream differs.
  assert.equal(notReady.id, ready.id);
  assert.equal(notReady.teamA, ready.teamA);
  assert.equal(notReady.teamB, ready.teamB);
  assert.equal(notReady.competition, ready.competition);
  assert.equal(notReady.startsAt, ready.startsAt);
  assert.equal(notReady.phase, ready.phase);
  assert.equal(notReady.channelName, ready.channelName);
  assert.equal(notReady.channelCategory, ready.channelCategory);

  const differing = (Object.keys(ready) as (keyof PublicFixture)[]).filter(
    (key) => JSON.stringify(ready[key]) !== JSON.stringify(notReady[key])
  );
  assert.deepEqual(differing, ["watchPath"]);
});

test("readiness is the same answer for every card, and a card that was never pushed stays unlinked", () => {
  const now = new Date("2026-10-25T12:00:00.000Z");
  const board = projectFixtures(
    [GATED_FIXTURE, { ...GATED_FIXTURE, _id: "fx_two", channels: [secured("pc_two")] }],
    [PUSHED_CHANNEL, { ...PUSHED_CHANNEL, _id: "pc_two", proxyChannelKey: "" }],
    now,
    false
  );

  assert.equal(board.length, 2);
  assert.deepEqual(
    board.map((card) => card.watchPath),
    [null, null]
  );
});

// --- mixed references (what a card may now name) --------------------------------

test("a direct reference joins the card without changing what the card links to", () => {
  const now = new Date("2026-10-25T12:00:00.000Z");
  const mixed = {
    ...GATED_FIXTURE,
    channels: [direct("6ab5c72de29c995275489e5c"), secured("pc_one")],
  };

  const board = projectFixtures([mixed], [PUSHED_CHANNEL], now, true);
  assert.equal(board.length, 1);
  // The card still answers with the secured row this tier knows how to sign for, and it finds it
  // by asking the list which entry is secured — not by taking whatever comes first.
  assert.equal(board[0].watchPath, "/premium/pc_one");
  assert.equal(board[0].channelName, PUSHED_CHANNEL.name);
});

test("a card that names only direct channels offers nothing this board knows how to open", () => {
  const now = new Date("2026-10-25T12:00:00.000Z");
  const directOnly = {
    ...GATED_FIXTURE,
    _id: "fx_direct",
    channels: [direct("6ab5c72de29c995275489e5c")],
  };

  // Pinned as the interim it is: the viewer-facing half of a mixed card — offering a direct
  // choice at all, and saying so when a link is stale — is what the chooser and the stale-reference
  // phases build, and this is the behaviour they change deliberately.
  assert.equal(projectFixtures([directOnly], [PUSHED_CHANNEL], now, true).length, 0);
});

