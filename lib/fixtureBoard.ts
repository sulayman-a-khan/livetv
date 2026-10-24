/**
 * The viewer-facing half of the fixture board: which published matches are worth
 * showing, in what order, and what a card is allowed to say about them. Pure —
 * no MongoDB, no network, no React — so `npm run test:premium-fixtures` executes
 * the same rules the homepage renders.
 *
 * A projected card never carries a source URL or an upstream header. Those live
 * on the admin record, and this module is the only path a viewer takes.
 */

import type { FixturePhase, FixtureSport } from "./premiumFixtures";

/** Kickoffs further out than this are the admin's schedule, not today's board. */
const UPCOMING_WINDOW_MS = 24 * 60 * 60_000;

/** Cards the projection may hand the board; a phone shows only the first of them. */
const MAX_CARDS = 3;

/** The fixture fields the board reads, shaped so the store's record fits as-is. */
export interface BoardFixture {
  _id: string;
  sport: FixtureSport;
  teamA: string;
  teamB: string;
  teamALogo: string;
  teamBLogo: string;
  competition: string;
  startsAt: string;
  durationMinutes: number;
  premiumChannelId: string | null;
  visible: boolean;
  phase: FixturePhase;
}

/** The channel fields a card may name; `sourceUrl` is deliberately absent. */
export interface BoardChannel {
  _id: string;
  name: string;
  category: string;
  logoUrl: string;
  active: boolean;
}

export interface PublicFixture {
  id: string;
  sport: FixtureSport;
  teamA: string;
  teamB: string;
  teamALogo: string;
  teamBLogo: string;
  competition: string;
  startsAt: string;
  durationMinutes: number;
  phase: FixturePhase;
  channelName: string;
  channelLogo: string;
  channelCategory: string;
}

/**
 * Live matches first (soonest kickoff among them), then upcoming ones in kickoff
 * order, capped at the slots the slot can hold.
 *
 * A card is dropped when it is unpublished, when it has finished, when its
 * kickoff is more than a day away, or when the premium channel behind it is
 * missing or switched off — a card must not advertise a match nobody can watch.
 */
export function projectFixtures(
  fixtures: BoardFixture[],
  channels: BoardChannel[],
  now: Date
): PublicFixture[] {
  const byId = new Map(channels.map((channel) => [channel._id, channel]));
  const cutoff = now.getTime() + UPCOMING_WINDOW_MS;

  const shown = fixtures
    .filter((fixture) => fixture.visible && fixture.phase !== "finished")
    .map((fixture) => {
      const channel = fixture.premiumChannelId ? byId.get(fixture.premiumChannelId) : undefined;
      if (!channel || !channel.active) return null;
      const startsAt = new Date(fixture.startsAt).getTime();
      if (fixture.phase === "upcoming" && startsAt > cutoff) return null;
      return { fixture, channel };
    })
    .filter((entry): entry is { fixture: BoardFixture; channel: BoardChannel } => entry !== null)
    .sort((a, b) => {
      if (a.fixture.phase !== b.fixture.phase) return a.fixture.phase === "live" ? -1 : 1;
      return a.fixture.startsAt.localeCompare(b.fixture.startsAt);
    })
    .slice(0, MAX_CARDS);

  return shown.map(({ fixture, channel }) => ({
    id: fixture._id,
    sport: fixture.sport,
    teamA: fixture.teamA,
    teamB: fixture.teamB,
    teamALogo: fixture.teamALogo,
    teamBLogo: fixture.teamBLogo,
    competition: fixture.competition,
    startsAt: fixture.startsAt,
    durationMinutes: fixture.durationMinutes,
    phase: fixture.phase,
    channelName: channel.name,
    channelLogo: channel.logoUrl,
    channelCategory: channel.category,
  }));
}
