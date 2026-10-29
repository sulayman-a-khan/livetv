/**
 * Tests for team recognition on the match board (`lib/teamFlags.ts`).
 *
 * Run with `npm run test:team-flags` — that compiles the pure module plus this file
 * into `.tmp-tests/` and runs them on Node's own test runner. Nothing here touches
 * MongoDB, the network or a running server.
 *
 * The cases that matter are the ones an admin would be embarrassed by if they broke: a
 * flag on the wrong country, a flag on a club, and a title that does not split.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeTeamName,
  parseMatchTitle,
  resolveTeamCountry,
  teamFlagUrl,
} from "../lib/teamFlags";

test("a national team is recognised by its full name", () => {
  assert.equal(resolveTeamCountry("Bangladesh"), "bd");
  assert.equal(resolveTeamCountry("India"), "in");
  assert.equal(resolveTeamCountry("Brazil"), "br");
  assert.equal(resolveTeamCountry("Argentina"), "ar");
  assert.equal(resolveTeamCountry("South Africa"), "za");
  assert.equal(resolveTeamCountry("New Zealand"), "nz");
});

test("a national team is recognised by its common abbreviation", () => {
  assert.equal(resolveTeamCountry("BAN"), "bd");
  assert.equal(resolveTeamCountry("IND"), "in");
  assert.equal(resolveTeamCountry("PAK"), "pk");
  assert.equal(resolveTeamCountry("ENG"), "gb-eng");
  assert.equal(resolveTeamCountry("AUS"), "au");
  assert.equal(resolveTeamCountry("WI"), "wi");
});

test("the name is read the way an admin would type it", () => {
  assert.equal(resolveTeamCountry("bangladesh"), "bd");
  assert.equal(resolveTeamCountry("  Bangladesh  "), "bd");
  assert.equal(resolveTeamCountry("BANGLADESH"), "bd");
  assert.equal(resolveTeamCountry("Côte d'Ivoire"), "ci");
  assert.equal(resolveTeamCountry("South-Africa"), "za");
  assert.equal(resolveTeamCountry("U.S.A."), "us");
});

test("a qualifier does not change which country a team is from", () => {
  assert.equal(resolveTeamCountry("Bangladesh Women"), "bd");
  assert.equal(resolveTeamCountry("India U19"), "in");
  assert.equal(resolveTeamCountry("England XI"), "gb-eng");
});

test("the four home nations keep their own flags", () => {
  assert.equal(resolveTeamCountry("England"), "gb-eng");
  assert.equal(resolveTeamCountry("Scotland"), "gb-sct");
  assert.equal(resolveTeamCountry("Wales"), "gb-wls");
  assert.equal(resolveTeamCountry("Northern Ireland"), "gb-nir");
});

test("SA is South Africa in a cricket card and KSA is Saudi Arabia", () => {
  assert.equal(resolveTeamCountry("SA"), "za");
  assert.equal(resolveTeamCountry("KSA"), "sa");
  assert.equal(resolveTeamCountry("Saudi Arabia"), "sa");
});

test("a name that is not a national team is not given a flag", () => {
  assert.equal(resolveTeamCountry("Abahani Limited"), null);
  assert.equal(resolveTeamCountry(""), null);
  assert.equal(resolveTeamCountry("   "), null);
  assert.equal(resolveTeamCountry("???"), null);
});

test("the flag is drawn from the country the team belongs to", () => {
  assert.equal(teamFlagUrl("Bangladesh"), "https://flagcdn.com/w80/bd.png");
  assert.equal(teamFlagUrl("BAN"), "https://flagcdn.com/w80/bd.png");
  assert.equal(teamFlagUrl("England"), "https://flagcdn.com/w80/gb-eng.png");
  assert.equal(teamFlagUrl("Abahani Limited"), null);
});

test("a normalised name keeps its words and loses its punctuation", () => {
  assert.equal(normalizeTeamName("New Zealand"), "new zealand");
  assert.equal(normalizeTeamName("South-Africa"), "south africa");
  assert.equal(normalizeTeamName("U.S.A."), "usa");
});

test("a title splits into the two teams it names", () => {
  assert.deepEqual(parseMatchTitle("Bangladesh vs India"), {
    teamA: "Bangladesh",
    teamB: "India",
  });
  assert.deepEqual(parseMatchTitle("Brazil vs Argentina"), {
    teamA: "Brazil",
    teamB: "Argentina",
  });
  assert.deepEqual(parseMatchTitle("BAN vs IND"), { teamA: "BAN", teamB: "IND" });
  assert.deepEqual(parseMatchTitle("Bangladesh v India"), {
    teamA: "Bangladesh",
    teamB: "India",
  });
  assert.deepEqual(parseMatchTitle("Bangladesh - India"), {
    teamA: "Bangladesh",
    teamB: "India",
  });
});

test("a title that does not name two teams is left alone", () => {
  assert.equal(parseMatchTitle("Bangladesh"), null);
  assert.equal(parseMatchTitle(""), null);
  assert.equal(parseMatchTitle("Bangladesh vs India vs Pakistan"), null);
  assert.equal(parseMatchTitle("vs India"), null);
});
