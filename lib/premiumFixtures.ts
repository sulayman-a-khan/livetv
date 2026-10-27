/**
 * The pure half of the premium tier: what a valid admin entry looks like, and how
 * a fixture's clock maps to the badge a card shows. Nothing in here touches
 * MongoDB, the network or React, so `npm run test:premium-fixtures` can execute
 * it directly — the storing half lives in `lib/premiumStore.ts`.
 */

/** The only sports a fixture card is entered for. */
export const FIXTURE_SPORTS = ["football", "cricket"] as const;
export type FixtureSport = (typeof FIXTURE_SPORTS)[number];

export const FIXTURE_PHASES = ["upcoming", "live", "finished"] as const;
export type FixturePhase = (typeof FIXTURE_PHASES)[number];

/**
 * Which of the two tiers a linked channel belongs to. A card says this on purpose rather
 * than trusting a row to be findable in one list or the other: the same 24-character id
 * shape means a catalogue channel in one tier and could mean anything in the other, and a
 * tap has to know which playback route — and which authorization flow — it belongs to.
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

export interface PremiumChannelInput {
  name: string;
  category: string;
  logoUrl: string;
  active: boolean;
  sortOrder: number;
  note: string;
  /**
   * The handle this channel's source is registered under on the proxy box. It is the only
   * thing this row keeps about where the stream comes from, and it is empty until the admin
   * pushes a source.
   */
  proxyChannelKey: string;
}

/**
 * The body of a push to the box: the line itself, and the headers it demands.
 * Validated on the way out and never stored — the vault on the box is the source of truth,
 * so a copy in this database would only be a second place for the credential to leak from.
 */
export interface PremiumSourceInput {
  sourceUrl: string;
  userAgent: string;
  referer: string;
}

export interface FixtureInput {
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
  visible: boolean;
}

export interface Validation<T> {
  value: Partial<T>;
  errors: string[];
}

/** True when the URL is something a browser or a fetch can actually reach. */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url);
}

function toBool(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

/**
 * Whole numbers only, and never outside the range the admin form itself offers,
 * so a hand-crafted request cannot store a value the panel then cannot display.
 */
function toIntInRange(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
  errors: string[]
): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${label} must be a whole number between ${min} and ${max}`);
    return fallback;
  }
  return n;
}

/** A trimmed string, refused when it is longer than the field on screen. */
function toText(
  raw: unknown,
  label: string,
  errors: string[],
  options: { required?: boolean; max: number; fallback?: string }
): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    if (options.required) errors.push(`${label} is required`);
    return options.fallback ?? "";
  }
  if (value.length > options.max) {
    errors.push(`${label} must be ${options.max} characters or fewer`);
    return "";
  }
  return value;
}

/** An optional URL field: empty is allowed, a non-empty value must be http(s). */
function toOptionalUrl(raw: unknown, label: string, errors: string[]): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  if (!isHttpUrl(value) || value.length > 2048) {
    errors.push(`${label} must be a valid http(s) URL`);
    return "";
  }
  return value;
}

/**
 * Validates a create (every field considered) or a patch (only the keys that were
 * actually sent), so a toggle of one switch never rewrites the rest of the record.
 */
export function validatePremiumChannelInput(
  body: Record<string, unknown>,
  creating: boolean
): Validation<PremiumChannelInput> {
  const value: Partial<PremiumChannelInput> = {};
  const errors: string[] = [];
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (creating || has("name")) {
    const name = toText(body.name, "Channel name", errors, { required: true, max: 120 });
    if (name) value.name = name;
  }

  if (creating || has("proxyChannelKey")) {
    // The handle is usually the one `lib/premiumProxy.ts` derives and a push writes back, but
    // an admin who registered his lane on the box by hand may enter it here, so it is a field
    // of the row like any other. The proxy's own key rule is `[a-z0-9_-]`, and a key that
    // breaks it would be refused there with a message about an unrelated field.
    const key = toText(body.proxyChannelKey, "Stream box handle", errors, { max: 64 }).toLowerCase();
    if (key && !/^[a-z0-9_-]{2,64}$/.test(key)) {
      errors.push("Stream box handle must be 2-64 characters of letters, digits, - or _");
    } else value.proxyChannelKey = key;
  }

  if (creating || has("category")) {
    const category = toText(body.category, "Category", errors, {
      max: 40,
      fallback: "Premium",
    });
    value.category = category || "Premium";
  }

  if (creating || has("logoUrl")) {
    const logo = toOptionalUrl(body.logoUrl, "Logo URL", errors);
    value.logoUrl = logo;
  }

  if (creating || has("active")) value.active = toBool(body.active, true);
  if (creating || has("note")) {
    value.note = toText(body.note, "Note", errors, { max: 200 });
  }
  if (creating || has("sortOrder")) {
    value.sortOrder = toIntInRange(body.sortOrder, 99, 1, 999, "Rail position", errors);
  }

  return { value, errors };
}

/**
 * What a push to the stream box must carry: one manifest URL, and at most the two headers
 * that source demands. A line that is not an http(s) URL could not be played by anything, and
 * a header value containing a line break would be joined onto the wire as a second header,
 * so neither reaches the box.
 */
export function validatePremiumSourcePush(
  body: Record<string, unknown>
): { value: PremiumSourceInput; errors: string[] } {
  const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
  const errors: string[] = [];
  if (!sourceUrl) errors.push("Source URL is required");
  else if (!isHttpUrl(sourceUrl) || sourceUrl.length > 2048)
    errors.push("Source URL must be a valid http(s) URL");

  const userAgent = toText(body.userAgent, "User-Agent", errors, { max: 300 });
  if (/[\r\n]/.test(userAgent)) errors.push("User-Agent must not contain a line break");

  const refererRaw = body.referer;
  const referer = typeof refererRaw === "string" ? refererRaw.trim() : "";
  if (/[\r\n]/.test(referer)) errors.push("Referer must not contain a line break");
  if (referer) {
    try {
      const url = new URL(referer);
      if (url.protocol !== "https:" && url.protocol !== "http:")
        errors.push("Referer must be an http(s) URL");
    } catch {
      errors.push("Referer must be an absolute URL, or empty");
    }
  }

  return {
    value: { sourceUrl, userAgent, referer },
    errors,
  };
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
 * The channels a match is tied to, read from a payload that may have come from anywhere.
 *
 * A reference is only ever an id plus the tier it belongs to. Keys beyond those two are
 * refused rather than ignored, because the one thing this list must never end up holding is
 * a source line, a header or a token — and a fixture row is what the public board reads.
 */
function toChannelRefs(raw: unknown, label: string, errors: string[]): FixtureChannelRef[] {
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

    const sourceRaw = typeof ref.sourceType === "string" ? ref.sourceType.trim().toLowerCase() : "";
    if (!(FIXTURE_SOURCE_TYPES as readonly string[]).includes(sourceRaw)) {
      errors.push(`${at} source must be one of: ${FIXTURE_SOURCE_TYPES.join(", ")}`);
      return;
    }
    const sourceType = sourceRaw as FixtureSourceType;

    const idRaw = typeof ref.channelId === "string" ? ref.channelId.trim() : "";
    if (!CHANNEL_ID_PATTERN.test(idRaw)) {
      errors.push(`${at} id is not valid`);
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
 * The links on a card that name no channel in the lists the editor was given.
 *
 * The direct list holds only the channels the catalogue is currently showing, so a direct link
 * missing from it is either gone or deliberately taken off screen — two facts with two different
 * repairs, which is why the editor asks about them by tier rather than guessing. A secured link
 * missing from its list names a channel this tier no longer has.
 *
 * This is the editor's own question — "what is on this card that I cannot see?" — asked of the
 * lists the editor was handed. The server answers the same question separately, for a write.
 */
export function unresolvedFixtureRefs(
  refs: FixtureChannelRef[],
  known: { direct: string[]; secured: string[] }
): FixtureChannelRef[] {
  const direct = new Set(known.direct);
  const secured = new Set(known.secured);
  return refs.filter((ref) =>
    ref.sourceType === "direct" ? !direct.has(ref.channelId) : !secured.has(ref.channelId)
  );
}

export function validateFixtureInput(
  body: Record<string, unknown>,
  creating: boolean
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

  if (creating || has("teamA")) {
    const teamA = toText(body.teamA, "Team A", errors, { required: true, max: 60 });
    if (teamA) value.teamA = teamA;
  }
  if (creating || has("teamB")) {
    const teamB = toText(body.teamB, "Team B", errors, { required: true, max: 60 });
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
        : toChannelRefs(body.channels, "Linked channel", errors);
  }

  // The single-channel field this tier shipped with is gone from the write path on purpose:
  // a request that still sends it would otherwise store a second, vaguer answer to "where is
  // this match watched", and rows that predate the list are read through the projection
  // instead (`toFixtureRecord` in `lib/premiumStore.ts`).
  if (has("premiumChannelId")) {
    errors.push("Linked channel is now sent as a channels list with a source for each entry");
  }

  if (creating || has("visible")) value.visible = toBool(body.visible, false);

  return { value, errors };
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
