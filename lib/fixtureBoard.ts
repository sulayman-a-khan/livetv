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
  /**
   * The card's title, as the admin wrote it.
   *
   * Optional because a card written before titles existed has none: the title is a
   * convenience the admin reads, and the two team fields are what a card is actually made of.
   */
  title?: string;
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
 * A direct catalogue row as the board sees it: a name, a category and a picture, plus whether the
 * catalogue is currently showing it.
 *
 * Health, ranking and failover are not in here because they are not this tier's to judge —
 * the existing watch page owns them, and a card that tried to predict them would be a second,
 * weaker copy of a working system.
 *
 * `listed` is the catalogue's own visibility choice, not a health verdict: an unpinned channel
 * exists, has a watch page, and is deliberately kept off the public grid. A card may name it and
 * must not link it, because the write path already refuses a reference to a channel the app is
 * not showing.
 */
export interface BoardDirectChannel {
  _id: string;
  name: string;
  category: string;
  logoUrl: string;
  listed: boolean;
}

/**
 * Why a choice cannot be opened, as a fact rather than a sentence — the card turns this into
 * the words a viewer reads, so the rule stays testable and the wording stays in one place.
 *
 * `ready` is the only state with a route. The others are all true statements about a channel this
 * board can still *name*, which is why the card keeps naming it instead of hiding it. A reference
 * that names no channel at all is not a state: it has nothing to say, and lands in
 * `staleReferences` instead.
 */
export type ChoiceState = "ready" | "box-offline" | "not-pushed" | "off-air" | "delisted";

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
  /** The card's title, as the admin wrote it. */
  title: string;
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
   * Every linked channel this board can still name, in the order the admin picked them, each saying
   * whether it can be opened now.
   */
  choices: FixtureChoice[];
  /**
   * How many of the admin's links name a channel that this tier no longer has at all — deleted, or
   * written down wrong. A count and nothing else: there is no name to show for such a reference and
   * inventing one would be a lie, so the card says "a linked channel is gone" rather than naming it.
   *
   * This is the difference between a stale link and an unavailable channel, and it is the reason a
   * card survives its own bad reference: the count keeps the fact without the id.
   */
  staleReferences: number;
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
 * A stored reference list, taken as the board wants it: first occurrence wins, and an entry that
 * cannot name a channel is dropped rather than guessed at.
 *
 * The store already does this on the way out of a row (`readFixtureChannels`), and doing it again
 * here costs nothing on a correct row, so a card whose stored list holds the same channel twice is
 * not turned into a two-choice dialog by a duplicate nobody can see.
 */
export function dedupeRefs(refs: FixtureChannelRef[]): FixtureChannelRef[] {
  const seen = new Set<string>();
  const out: FixtureChannelRef[] = [];
  for (const ref of refs) {
    const channelId = typeof ref?.channelId === "string" ? ref.channelId.trim() : "";
    if (!channelId) continue;
    if (ref?.sourceType !== "direct" && ref?.sourceType !== "secured") continue;
    const at = `${ref.sourceType}:${channelId}`;
    if (seen.has(at)) continue;
    seen.add(at);
    out.push({ channelId, sourceType: ref.sourceType });
  }
  return out;
}

/**
 * The ids one tier's worth of references asks about, without duplicates.
 *
 * This is what keeps a board read a *batch*: the route asks its tier once for every id any published
 * card names, instead of once per card or once per link. A reference that names the same channel
 * twice is asked about once, and an id the tier cannot hold costs nothing more than its absence —
 * the read decides what is spellable, not this list.
 */
export function referencedChannelIds(fixtures: BoardFixture[], sourceType: FixtureSourceType): string[] {
  const ids = new Set<string>();
  for (const fixture of fixtures) {
    for (const ref of dedupeRefs(fixture.channels)) {
      if (ref.sourceType !== sourceType) continue;
      ids.add(ref.channelId);
    }
  }
  return Array.from(ids);
}

/**
 * One linked channel, as far as this board can take it.
 *
 * A reference whose id is not in its tier's list resolves to null: the board has no name for it and
 * will not show a raw id to a viewer. That is a stale reference, and it is counted by the caller
 * rather than returned — dropping the whole card over it would be the other mistake, since the
 * match, its teams and its other channels are all still true.
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
    // What does bear on it is whether the catalogue is showing that channel at all.
    return {
      channelId: channel._id,
      sourceType: "direct",
      name: channel.name,
      category: channel.category,
      logoUrl: channel.logoUrl,
      watchPath: channel.listed ? `/watch/${channel._id}` : null,
      state: channel.listed ? "ready" : "delisted",
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
 * The next channel to try when the one playing could not, in the order the admin set.
 *
 * The card's order is the priority: the first channel on it is tried first, and the ones after
 * it are what a failure moves to. A refusal that names the box rather than the channel — the box
 * is down, unreachable, or could not sign — is not about this channel, so another channel on the
 * same box would answer the same way: the walk steps over those and looks for one that plays
 * from its own origin.
 *
 * `remaining` is the card's channels after the one that just failed, in the card's own order.
 */
export function nextFallbackChannel(
  remaining: readonly { channelId: string; sourceType: FixtureSourceType }[],
  code: string | null
): { channelId: string; sourceType: FixtureSourceType } | null {
  const boxLevel =
    code === "box_unavailable" || code === "box_unreachable" || code === "sign_failed";
  for (const candidate of remaining) {
    if (boxLevel && candidate.sourceType === "secured") continue;
    return candidate;
  }
  return null;
}

/**
 * Live matches first (soonest kickoff among them), then upcoming ones in kickoff
 * order, capped at the slots the slot can hold.
 *
 * A card is dropped when it is unpublished, when it has finished, when its kickoff is more than
 * a day away, or when it names no channel at all — a card must not advertise a match in nobody's
 * voice. Every other case keeps the card. In particular a reference whose channel has gone does not
 * take a match off the board: the choices that still resolve are offered, the ones that cannot be
 * opened right now explain themselves, and the links that name nothing go out as a count.
 *
 * Nothing is remembered about a stale reference between reads, which is how a reference repairs
 * itself: a channel that comes back — re-pinned, re-pushed, or restored under its own id — is on the
 * card again on the next read with no repair step in between.
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
      const refs = dedupeRefs(fixture.channels);
      // Nothing linked is the one case a card has no voice for. Every link gone stale is a
      // different fact — the match is real and published, and its channels are what is missing —
      // so it stays on the board and says that.
      if (refs.length === 0) return null;
      const choices: FixtureChoice[] = [];
      for (const ref of refs) {
        const choice = resolveChoice(ref, securedById, directById, securedReady);
        if (choice) choices.push(choice);
      }
      const startsAt = new Date(fixture.startsAt).getTime();
      if (fixture.phase === "upcoming" && startsAt > cutoff) return null;
      return { fixture, choices, staleReferences: refs.length - choices.length };
    })
    .filter(
      (
        entry
      ): entry is { fixture: BoardFixture; choices: FixtureChoice[]; staleReferences: number } =>
        entry !== null
    )
    .sort((a, b) => {
      if (a.fixture.phase !== b.fixture.phase) return a.fixture.phase === "live" ? -1 : 1;
      return a.fixture.startsAt.localeCompare(b.fixture.startsAt);
    })
    .slice(0, MAX_CARDS);

  return shown.map(({ fixture, choices, staleReferences }) => {
    // The card's own link is the rule the card is drawn by: exactly one thing to offer means a
    // tap can go straight to it, more than one means the viewer has to choose, so the answer to
    // "is this a link?" is computed here once rather than re-derived in the markup.
    const offers = offersOf(choices);
    return {
      id: fixture._id,
      title: fixture.title || "",
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
      staleReferences,
      watchPath: offers.length === 1 ? offers[0].watchPath : null,
    };
  });
}
