/**
 * The viewer-facing half of the fixture board: which published matches are worth
 * showing, in what order, and what a card is allowed to say about them. Pure —
 * no MongoDB, no network, no React — so `npm run test:premium-fixtures` executes
 * the same rules the homepage renders.
 *
 * A projected card never carries a source URL or an upstream header. Those live
 * on the admin record, and this module is the only path a viewer takes.
 */

import type { FixtureChannelRef, FixturePhase, FixtureSourceType, FixtureSport } from "./premiumFixtures";

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
  /** Every channel the admin linked, each naming the tier it comes from. */
  channels: FixtureChannelRef[];
  visible: boolean;
  phase: FixturePhase;
}

/**
 * The channel fields a card may name. `sourceUrl` is deliberately absent, and
 * `proxyChannelKey` is only a handle: it names nothing a viewer could use without
 * the box signing a URL for it.
 */
export interface BoardChannel {
  _id: string;
  name: string;
  category: string;
  logoUrl: string;
  active: boolean;
  proxyChannelKey: string;
}

/**
 * A direct catalogue row as the board sees it: a name, a category and a picture.
 *
 * Health, ranking and failover are not in here because they are not this tier's to judge —
 * the existing watch page owns them, and a card that tried to predict them would be a second,
 * weaker copy of a working system.
 */
export interface BoardDirectChannel {
  _id: string;
  name: string;
  category: string;
  logoUrl: string;
}

/**
 * Why a choice cannot be opened, as a fact rather than a sentence — the card turns this into
 * the words a viewer reads, so the rule stays testable and the wording stays in one place.
 *
 * `ready` is the only state with a route. The others are all true statements about the channel
 * itself, which is why the card keeps naming it instead of hiding it.
 */
export type ChoiceState = "ready" | "box-offline" | "not-pushed" | "off-air";

/** One channel a viewer can pick from a card, with the answer to "can I watch it right now?". */
export interface FixtureChoice {
  channelId: string;
  sourceType: FixtureSourceType;
  name: string;
  category: string;
  logoUrl: string;
  /**
   * The existing playback route for this tier — `/watch/…` for a direct channel, `/premium/…`
   * for a secured one — or null when this choice has nothing to open. A tap on a null choice is
   * never a navigation, and no new delivery path is invented here: these are the two addresses
   * the two tiers already answer on.
   */
  watchPath: string | null;
  state: ChoiceState;
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
  /**
   * Every linked channel this board can name, in the order the admin picked them, each saying
   * whether it can be opened now. A reference whose channel no longer exists is not in here —
   * there is no name to show for it — and is Phase 3's subject.
   */
  choices: FixtureChoice[];
  /**
   * Where a tap goes, or null. Non-null only when exactly one choice can be opened, which is the
   * whole difference between a card that plays and a card that has to ask: one answer needs no
   * dialog, two need the viewer to pick, none leave it a poster.
   */
  watchPath: string | null;
}

/** The choices a viewer can actually open, in the order they were picked. */
export function offersOf(choices: FixtureChoice[]): FixtureChoice[] {
  return choices.filter((choice) => choice.watchPath !== null);
}

/**
 * One linked channel, as far as this board can take it.
 *
 * A reference whose id is not in its tier's list resolves to nothing: the board has no name for
 * it and will not show a raw id to a viewer. That is a stale reference, and dropping the whole
 * card over it would be the other mistake — so the match stays on the board with the choices that
 * do resolve, which is what the card has always been able to advertise.
 */
function resolveChoice(
  ref: FixtureChannelRef,
  securedById: Map<string, BoardChannel>,
  directById: Map<string, BoardDirectChannel>,
  securedReady: boolean
): FixtureChoice | null {
  if (ref.sourceType === "direct") {
    const channel = directById.get(ref.channelId);
    if (!channel) return null;
    // Nothing about the stream box bears on a direct channel: it plays from its own origin
    // through the existing watch page, so it is offered whether or not the box is answering.
    return {
      channelId: channel._id,
      sourceType: "direct",
      name: channel.name,
      category: channel.category,
      logoUrl: channel.logoUrl,
      watchPath: `/watch/${channel._id}`,
      state: "ready",
    };
  }

  const channel = securedById.get(ref.channelId);
  if (!channel) return null;
  // Most specific answer first: a channel the admin switched off, or whose source nobody ever
  // pushed, would also read as unopenable during an outage, and "the box is down" would be the
  // wrong explanation for it.
  const state: ChoiceState = !channel.active
    ? "off-air"
    : !channel.proxyChannelKey
      ? "not-pushed"
      : !securedReady
        ? "box-offline"
        : "ready";
  return {
    channelId: channel._id,
    sourceType: "secured",
    name: channel.name,
    category: channel.category,
    logoUrl: channel.logoUrl,
    watchPath: state === "ready" ? `/premium/${channel._id}` : null,
    state,
  };
}

/**
 * Live matches first (soonest kickoff among them), then upcoming ones in kickoff
 * order, capped at the slots the slot can hold.
 *
 * A card is dropped when it is unpublished, when it has finished, when its kickoff is more than
 * a day away, or when none of its linked channels resolves to a channel this board can name —
 * a card must not advertise a match in nobody's voice. A channel that exists but cannot be opened
 * right now keeps its card and says so instead: a match being played is not the same fact as a
 * stream being able to deliver it.
 *
 * `securedReady` is the box's own readiness verdict, measured server-side by
 * `lib/premiumReadiness.ts`. It decides what a card may *offer*, not what it may say:
 * the teams, the competition and the clock are the fixture's metadata and stay on the board
 * through an outage, and it reaches only the secured half of a card — a direct choice plays from
 * its own origin and is never taken off air by a box that cannot answer. Nothing here infers
 * readiness from `active` or from a row having a handle — an intention is not a stream.
 */
export function projectFixtures(
  fixtures: BoardFixture[],
  channels: BoardChannel[],
  directChannels: BoardDirectChannel[],
  now: Date,
  securedReady: boolean
): PublicFixture[] {
  const securedById = new Map(channels.map((channel) => [channel._id, channel]));
  const directById = new Map(directChannels.map((channel) => [channel._id, channel]));
  const cutoff = now.getTime() + UPCOMING_WINDOW_MS;

  const shown = fixtures
    .filter((fixture) => fixture.visible && fixture.phase !== "finished")
    .map((fixture) => {
      const choices = fixture.channels
        .map((ref) => resolveChoice(ref, securedById, directById, securedReady))
        .filter((choice): choice is FixtureChoice => choice !== null);
      if (choices.length === 0) return null;
      const startsAt = new Date(fixture.startsAt).getTime();
      if (fixture.phase === "upcoming" && startsAt > cutoff) return null;
      return { fixture, choices };
    })
    .filter((entry): entry is { fixture: BoardFixture; choices: FixtureChoice[] } => entry !== null)
    .sort((a, b) => {
      if (a.fixture.phase !== b.fixture.phase) return a.fixture.phase === "live" ? -1 : 1;
      return a.fixture.startsAt.localeCompare(b.fixture.startsAt);
    })
    .slice(0, MAX_CARDS);

  return shown.map(({ fixture, choices }) => {
    // The card's own link is the rule the card is drawn by: exactly one thing to offer means a
    // tap can go straight to it, more than one means the viewer has to choose, so the answer to
    // "is this a link?" is computed here once rather than re-derived in the markup.
    const offers = offersOf(choices);
    return {
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
      choices,
      watchPath: offers.length === 1 ? offers[0].watchPath : null,
    };
  });
}
