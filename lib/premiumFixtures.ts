import { parseMatchTitle } from "./teamFlags";

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

/**
 * The handle the stream box files a provider or a channel under.
 *
 * The box's own rule, copied rather than guessed: a handle that breaks it would be refused
 * there with a message about a field the admin never saw, and it is put in a path, so it must
 * not be able to carry a slash.
 *
 * The leading character is part of the rule and not an afterthought: the box refuses a handle
 * that starts with a dash or an underscore, so a handle accepted here and refused there would
 * be a form that says yes to a value the box will not take.
 */
export const BOX_HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** A stream id on a provider account: one to thirty-two characters of `[A-Za-z0-9_-]`. */
const STREAM_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** How many backups a channel may name. The box's own ceiling. */
export const MAX_BACKUP_STREAM_IDS = 8;

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
  /**
   * The provider account this channel plays from, and the streams it plays and falls back to.
   *
   * These three are the admin's copy of what the box holds for this channel. The box is the
   * source of truth — the failover itself happens there — but a row that kept nothing would
   * show an empty form on the next edit, so the panel needs to be able to say which provider
   * and which streams a channel was built on.
   *
   * A row with no provider is a channel with no stream yet: a name and a place on the rail.
   */
  providerId?: string;
  /** The stream the channel plays first. */
  streamId?: string;
  /** The streams it falls back to, in the order it falls back to them. */
  backupStreamIds?: string[];
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
 * The streams a channel falls back to, in the order it falls back to them.
 *
 * An empty list is a real answer — it means "no backups" — and a list that names the same
 * stream twice is not an order at all, so it is refused rather than quietly deduplicated.
 */
function toBackupStreamIds(raw: unknown, errors: string[]): string[] {
  if (!Array.isArray(raw)) {
    errors.push("Backup stream IDs must be a list");
    return [];
  }
  if (raw.length > MAX_BACKUP_STREAM_IDS) {
    errors.push(`Backup stream IDs must name at most ${MAX_BACKUP_STREAM_IDS} streams`);
    return [];
  }
  const ids: string[] = [];
  for (const entry of raw) {
    const value = typeof entry === "string" ? entry.trim() : "";
    if (!STREAM_ID_PATTERN.test(value)) {
      errors.push("Every backup stream ID must be 1-32 characters of letters, digits, - or _");
      return [];
    }
    if (ids.includes(value)) {
      errors.push("Backup stream IDs must not name the same stream twice");
      return [];
    }
    ids.push(value);
  }
  return ids;
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

  if (creating || has("providerId")) {
    const providerId = toText(body.providerId, "Provider", errors, { max: 64 }).toLowerCase();
    if (providerId && !BOX_HANDLE_PATTERN.test(providerId)) {
      errors.push("Provider must be 2-64 characters of letters, digits, - or _");
    } else value.providerId = providerId;
  }

  if (creating || has("streamId")) {
    const streamId = toText(body.streamId, "Stream ID", errors, { max: 32 });
    if (streamId && !STREAM_ID_PATTERN.test(streamId)) {
      errors.push("Stream ID must be 1-32 characters of letters, digits, - or _");
    } else value.streamId = streamId;
  }

  if (creating || has("backupStreamIds")) {
    value.backupStreamIds =
      body.backupStreamIds === undefined || body.backupStreamIds === null
        ? []
        : toBackupStreamIds(body.backupStreamIds, errors);
  }

  // A backup that names the primary stream is not a fallback: it is the same stream twice, and
  // the box refuses it. It is refused here too, so the form says which field is wrong instead
  // of the box refusing the whole channel over it.
  if (value.streamId && value.backupStreamIds?.includes(value.streamId)) {
    errors.push("Backup stream IDs must not name the primary stream");
  }

  return { value, errors };
}

/**
 * A provider registration: the account the box will play from.
 *
 * The credential itself never reaches this site's database. These fields are read from the
 * admin's form, put into the one request that carries them to the box, and forgotten — which
 * is why the input type holds them at all, and why nothing here is stored.
 */
export interface ProviderInput {
  /** The handle the box files the account under. Derived from the label when none is given. */
  providerId: string;
  /** What the admin calls the account. */
  label: string;
  serverUrl: string;
  username: string;
  password: string;
}

/**
 * The handle a name implies.
 *
 * A provider's name is what the admin recognises it by, and the box files it under a handle
 * that has to survive being a path segment. So the name is turned into one: lower case, the
 * letters and digits kept, everything else a dash. A name with nothing left in it produces no
 * handle, and the admin has to give an id of their own.
 */
export function providerHandleFromLabel(label: string): string {
  const slug = (label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return BOX_HANDLE_PATTERN.test(slug) ? slug : "";
}

/**
 * The box's own rules for a provider address, checked here.
 *
 * The box refuses these itself, but it refuses them with a message about the field it
 * happened to be reading. The admin is told which field is wrong instead.
 */
function serverUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Server URL must be an absolute http(s) URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Server URL must be an http(s) URL";
  }
  if (url.search) return "Server URL must not carry a query";
  if (url.hash) return "Server URL must not carry a fragment";
  if (url.username || url.password) {
    return "Server URL must not embed a username or password";
  }
  return null;
}

/**
 * Validates what a provider registration must carry.
 *
 * A create names the whole account; an edit names only what changes, and a password that is
 * left out keeps the one the box already holds. A username or a password with a slash in it
 * is refused here because the box builds a panel address out of the three of them, and a
 * slash in either would change the path that is asked for.
 */
export function validateProviderInput(
  body: Record<string, unknown>,
  creating: boolean
): Validation<ProviderInput> {
  const value: Partial<ProviderInput> = {};
  const errors: string[] = [];
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (creating || has("label")) {
    const label = toText(body.label, "Provider name", errors, { required: creating, max: 80 });
    if (label) value.label = label;
  }

  if (creating || has("serverUrl")) {
    const serverUrl = toText(body.serverUrl, "Server URL", errors, { required: creating, max: 512 });
    if (serverUrl) {
      const problem = serverUrlProblem(serverUrl);
      if (problem) errors.push(problem);
      else value.serverUrl = serverUrl.replace(/\/+$/, "");
    }
  }

  if (creating || has("username")) {
    const username = toText(body.username, "Username", errors, { required: creating, max: 64 });
    if (username) {
      if (username.includes("/")) errors.push("Username must not contain a slash");
      else value.username = username;
    }
  }

  if (creating || has("password")) {
    const password = toText(body.password, "Password", errors, { required: creating, max: 64 });
    if (password) {
      if (password.includes("/")) errors.push("Password must not contain a slash");
      else value.password = password;
    }
  }

  // The handle is optional on a create: a name that makes one is enough. An id the admin typed
  // is kept as it was typed and lower cased, because the box lower cases it too. An edit never
  // renames the account — the handle is what the box files it under, and a rename would take
  // every channel that points at it with it.
  if (has("providerId")) {
    const typed = toText(body.providerId, "Provider ID", errors, { max: 64 }).toLowerCase();
    if (typed && !BOX_HANDLE_PATTERN.test(typed)) {
      errors.push("Provider ID must be 2-64 characters of letters, digits, - or _");
    } else if (typed) {
      value.providerId = typed;
    }
  } else if (creating && value.label) {
    const derived = providerHandleFromLabel(value.label);
    if (derived) value.providerId = derived;
    else errors.push("Provider name must contain a letter or digit, or give the provider an ID");
  }

  return { value, errors };
}

/**
 * The logo a channel that plays from the box may carry.
 *
 * The box refuses an http logo and it is right to: the app page is https, so the browser
 * would block the picture anyway. The rule is checked here so the admin is told which field
 * is wrong, rather than the box refusing a whole channel over its picture.
 *
 * A row with no provider is not checked: it has no lane on the box yet, and a picture is
 * not the box's business.
 */
export function boxLogoProblem(logoUrl: string, providerId: string): string | null {
  if (!providerId || !logoUrl) return null;
  return logoUrl.startsWith("https://")
    ? null
    : "Logo URL must be https for a channel that plays from the box";
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
