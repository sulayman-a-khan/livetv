import { parseMatchTitle } from "./teamFlags";
import {
  toBool,
  toIntInRange,
  toOptionalUrl,
  toText,
  type Validation,
} from "./validation";

/**
 * The pure rules of a match card: what a valid admin entry looks like, and how a
 * fixture's clock maps to the badge a card shows.
 *
 * A card names channels from the Direct HLS catalogue, and may also carry one broadcast
 * address the admin typed for the match itself, so this module knows nothing about the
 * premium tier, the stream box or a local store file: it is the vocabulary the editor, the
 * admin API and the public board all speak, and the storing half lives in
 * `lib/fixtureStore.ts`.
 */

/** The only sports a fixture card is entered for. */
export const FIXTURE_SPORTS = ["football", "cricket"] as const;
export type FixtureSport = (typeof FIXTURE_SPORTS)[number];

export const FIXTURE_PHASES = ["upcoming", "live", "finished"] as const;
export type FixturePhase = (typeof FIXTURE_PHASES)[number];

/**
 * The tiers a stored reference may name.
 *
 * `secured` is here for rows written while a card could still name a premium
 * channel: it is read and kept, and never written. A card names catalogue
 * channels, so a new reference may only be `direct`.
 */
export const FIXTURE_SOURCE_TYPES = ["direct", "secured"] as const;
export type FixtureSourceType = (typeof FIXTURE_SOURCE_TYPES)[number];

/**
 * One channel a match can be watched on. `channelId` is the row's own id and nothing else:
 * a reference may not carry a URL, a header, a token or any other key, because a fixture row
 * is readable by the public board and by anyone who can open the admin panel's list.
 */
export interface FixtureChannelRef {
  channelId: string;
  sourceType: FixtureSourceType;
}

/** The only keys a reference may arrive with. Anything else is refused, not stripped. */
const FIXTURE_REF_KEYS = ["channelId", "sourceType"];

/**
 * A card is drawn on a phone, so the choices it can offer are capped at what one screen
 * holds. A larger number would be a data-entry mistake rather than a schedule.
 */
export const MAX_FIXTURE_CHANNELS = 8;

/** What the direct catalogue names its rows by, in MongoDB and in its local mirror alike. */
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** A row id from either tier: no spaces, no punctuation a URL could be hiding in. */
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface FixtureInput {
  /**
   * The card's title, as the admin typed it: "Bangladesh vs India", "BAN vs IND".
   *
   * It is a convenience, not the truth: a title that names two teams says the same thing as
   * the two team fields, so the teams are read out of it and the card still shows the title
   * the admin wrote. A title that names no pair is kept as a title and nothing else.
   */
  title?: string;
  sport: FixtureSport;
  teamA: string;
  teamB: string;
  teamALogo: string;
  teamBLogo: string;
  competition: string;
  startsAt: Date;
  durationMinutes: number;
  /** Every channel this match can be watched on, in the order the admin picked them. */
  channels: FixtureChannelRef[];
  /**
   * An https address the admin entered for this match itself. Empty when the card is
   * watched on its linked channels only; absent on a patch that does not change it.
   */
  directUrl?: string;
  visible: boolean;
}

/** Kickoff accepts a date-time, a plain date, or epoch milliseconds. */
function toStartDate(raw: unknown, errors: string[]): Date | null {
  if (raw === undefined || raw === null || raw === "") {
    errors.push("Kickoff time is required");
    return null;
  }
  const date = raw instanceof Date ? raw : new Date(typeof raw === "string" ? raw : Number(raw));
  if (Number.isNaN(date.getTime())) {
    errors.push("Kickoff time must be a real date and time");
    return null;
  }
  return date;
}

/**
 * The broadcast address a card may carry, read from a payload that may have come from anywhere.
 *
 * The board is served over HTTPS, so a plain-http address would be blocked as mixed content the
 * moment a viewer pressed play: it is refused here rather than stored as a link that cannot work.
 * Credentials are refused for the same reason they are refused on a channel link — the address is
 * published on a card, and a password in it would be published with it.
 */
function toDirectUrl(raw: unknown, errors: string[]): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  if (value.length > 2048) {
    errors.push("Direct broadcast link is too long");
    return "";
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    errors.push("Direct broadcast link must be an https:// address");
    return "";
  }
  if (url.protocol !== "https:" || !url.hostname) {
    errors.push("Direct broadcast link must be an https:// address");
    return "";
  }
  if (url.username || url.password) {
    errors.push("Direct broadcast link must not carry a username or password");
    return "";
  }
  return value;
}

/**
 * The channels a match is tied to, read from a payload that may have come from anywhere.
 *
 * A reference is only ever an id plus the tier it belongs to. Keys beyond those two are
 * refused rather than ignored, because the one thing this list must never end up holding is
 * a source line, a header or a token — and a fixture row is what the public board reads.
 *
 * A reference may only name a catalogue channel. The one exception is a reference to the
 * premium tier that the card already carried: it is kept, because dropping it on the way in
 * would silently change a card the admin opened to fix something else, and refusing it would
 * lock them out of that card entirely. Adding one is refused.
 */
function toChannelRefs(
  raw: unknown,
  label: string,
  errors: string[],
  carried: FixtureChannelRef[]
): FixtureChannelRef[] {
  if (!Array.isArray(raw)) {
    errors.push(`${label} must be a list of channels`);
    return [];
  }
  if (raw.length > MAX_FIXTURE_CHANNELS) {
    errors.push(`${label} can hold at most ${MAX_FIXTURE_CHANNELS} channels`);
    return [];
  }

  const refs: FixtureChannelRef[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const at = `${label} ${index + 1}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${at} must name a channel id and a source`);
      return;
    }
    const ref = entry as Record<string, unknown>;
    const extra = Object.keys(ref).filter((key) => !FIXTURE_REF_KEYS.includes(key));
    if (extra.length > 0) {
      errors.push(`${at} carries ${extra.join(", ")} — a linked channel stores only an id and a source`);
      return;
    }

    const idRaw = typeof ref.channelId === "string" ? ref.channelId.trim() : "";
    if (!CHANNEL_ID_PATTERN.test(idRaw)) {
      errors.push(`${at} id is not valid`);
      return;
    }

    const sourceRaw = typeof ref.sourceType === "string" ? ref.sourceType.trim().toLowerCase() : "";
    if (!(FIXTURE_SOURCE_TYPES as readonly string[]).includes(sourceRaw)) {
      errors.push(`${at} must be a Direct HLS channel — a match links catalogue channels only`);
      return;
    }
    const sourceType = sourceRaw as FixtureSourceType;
    if (
      sourceType !== "direct" &&
      !carried.some((entry2) => entry2.sourceType === sourceType && entry2.channelId === idRaw)
    ) {
      errors.push(`${at} must be a Direct HLS channel — a match links catalogue channels only`);
      return;
    }

    // The direct catalogue's ids are ObjectIds, in production and in the local mirror that
    // was exported from it. Anything looser would be a card pointing at nothing.
    if (sourceType === "direct" && !OBJECT_ID_PATTERN.test(idRaw)) {
      errors.push(`${at} id must be a 24-character catalogue channel id`);
      return;
    }

    const key = `${sourceType}:${idRaw}`;
    if (seen.has(key)) {
      errors.push(`${at} is listed twice`);
      return;
    }
    seen.add(key);
    refs.push({ channelId: idRaw, sourceType });
  });

  return refs;
}

/**
 * The links on a card that name no channel in the list the editor was given.
 *
 * The direct list holds only the channels the catalogue is currently showing, so a direct link
 * missing from it is either gone or deliberately taken off screen — two facts with two different
 * repairs, which is why the editor asks about them rather than guessing.
 *
 * This is the editor's own question — "what is on this card that I cannot see?" — asked of the
 * list the editor was handed. The server answers the same question separately, for a write.
 */
export function unresolvedFixtureRefs(
  refs: FixtureChannelRef[],
  known: { direct: string[] }
): FixtureChannelRef[] {
  const direct = new Set(known.direct);
  return refs.filter((ref) => ref.sourceType === "direct" && !direct.has(ref.channelId));
}

/**
 * Validates a create (every field considered) or a patch (only the keys that were
 * actually sent), so a toggle of one switch never rewrites the rest of the record.
 *
 * `carried` is the list the stored card already holds. A patch is judged against it, so a
 * link the card has always carried survives an edit while a link the admin is adding has
 * to name a catalogue channel.
 */
export function validateFixtureInput(
  body: Record<string, unknown>,
  creating: boolean,
  carried: FixtureChannelRef[] = []
): Validation<FixtureInput> {
  const value: Partial<FixtureInput> = {};
  const errors: string[] = [];
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (creating || has("sport")) {
    const sport = typeof body.sport === "string" ? body.sport.trim().toLowerCase() : "";
    if (!sport) errors.push("Sport is required");
    else if (!(FIXTURE_SPORTS as readonly string[]).includes(sport))
      errors.push(`Sport must be one of: ${FIXTURE_SPORTS.join(", ")}`);
    else value.sport = sport as FixtureSport;
  }

  // A title that names two teams is the same answer as the two team fields, so the teams
  // are read out of it rather than asked for twice. An explicit team field always wins: the
  // admin may have typed the fixture in the other order.
  const title = creating || has("title") ? toText(body.title, "Title", errors, { max: 120 }) : undefined;
  if (creating || has("title")) value.title = title ?? "";
  const parsed = title ? parseMatchTitle(title) : null;

  if (creating || has("teamA")) {
    const fromTitle = parsed && !has("teamA") ? parsed.teamA : "";
    const teamA = fromTitle || toText(body.teamA, "Team A", errors, { required: true, max: 60 });
    if (teamA) value.teamA = teamA;
  }
  if (creating || has("teamB")) {
    const fromTitle = parsed && !has("teamB") ? parsed.teamB : "";
    const teamB = fromTitle || toText(body.teamB, "Team B", errors, { required: true, max: 60 });
    if (teamB) value.teamB = teamB;
  }

  if (creating || has("teamALogo")) value.teamALogo = toOptionalUrl(body.teamALogo, "Team A logo", errors);
  if (creating || has("teamBLogo")) value.teamBLogo = toOptionalUrl(body.teamBLogo, "Team B logo", errors);

  if (creating || has("competition")) {
    value.competition = toText(body.competition, "Competition", errors, { max: 80 });
  }

  if (creating || has("startsAt")) {
    const startsAt = toStartDate(body.startsAt, errors);
    if (startsAt) value.startsAt = startsAt;
  }

  if (creating || has("durationMinutes")) {
    value.durationMinutes = toIntInRange(body.durationMinutes, 120, 1, 720, "Match length", errors);
  }

  if (creating || has("channels")) {
    // An absent field on a create is "no channel chosen yet" — the way the single-field version
    // of this card stored null — while a field that is present and is not a list is a malformed
    // payload. An empty list is the same answer stated outright.
    value.channels =
      creating && body.channels === undefined
        ? []
        : toChannelRefs(body.channels, "Linked channel", errors, carried);
  }

  if (creating || has("directUrl")) {
    value.directUrl = toDirectUrl(body.directUrl, errors);
  }

  // The single-channel field this tier shipped with is gone from the write path on purpose:
  // a request that still sends it would otherwise store a second, vaguer answer to "where is
  // this match watched", and rows that predate the list are read through the projection
  // instead (`readFixtureChannels` in `lib/fixtureStore.ts`).
  if (has("premiumChannelId")) {
    errors.push("Linked channel is now sent as a channels list with a source for each entry");
  }

  if (creating || has("visible")) value.visible = toBool(body.visible, false);

  return { value, errors };
}

/**
 * A date-time as the editor's own field shows it: local wall clock, no seconds, no zone.
 *
 * The panel is where a kickoff is typed, so the value it reads back has to be the shape it
 * writes — a `datetime-local` input with no seconds and no offset, in the reader's own zone.
 * Anything else round-trips through that input as a different minute.
 */
export function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

/**
 * The minutes between two local date-times, or null when either of them is not a time.
 *
 * A match's length and the end the admin typed are two ways of saying one thing, so the
 * number is derived from the two clock values rather than kept beside them: a card can never
 * claim one length and end at another.
 */
export function minutesBetween(start: string, end: string): number | null {
  if (!start || !end) return null;
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 60_000);
}

/**
 * The end of a match that starts at `start` and runs for `minutes`, as the editor shows it.
 */
export function endTimeAfter(start: string, minutes: number): string {
  const from = new Date(start);
  if (Number.isNaN(from.getTime()) || !Number.isFinite(minutes)) return "";
  return toLocalInputValue(new Date(from.getTime() + minutes * 60_000).toISOString());
}

/**
 * Which badge a fixture carries right now. Kickoff starts it and the expected
 * length ends it, so a finished match stops advertising itself without the admin
 * having to remember to switch it off. A match is never "live" before kickoff.
 */
export function fixturePhase(startsAt: Date, durationMinutes: number, now: Date): FixturePhase {
  const start = startsAt.getTime();
  if (now.getTime() < start) return "upcoming";
  const end = start + Math.max(1, durationMinutes) * 60_000;
  return now.getTime() < end ? "live" : "finished";
}

/** Milliseconds until kickoff, clamped at zero for a match already underway. */
export function countdownMs(startsAt: Date, now: Date): number {
  return Math.max(0, startsAt.getTime() - now.getTime());
}
