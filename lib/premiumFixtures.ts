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
  premiumChannelId: string | null;
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

  if (creating || has("premiumChannelId")) {
    const raw = body.premiumChannelId;
    const id = typeof raw === "string" ? raw.trim() : "";
    const none = raw === null || raw === undefined || id === "";
    // "No linked channel" arrives as the form's empty option, as null, or as
    // whitespace from a hand-made request. All three store as null so a later read
    // never has to tell them apart; a value that is not a string at all is refused
    // rather than quietly unlinking a match.
    if (none) value.premiumChannelId = null;
    else if (typeof raw !== "string" || id.length > 64)
      errors.push("Linked channel is not valid");
    else value.premiumChannelId = id;
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
