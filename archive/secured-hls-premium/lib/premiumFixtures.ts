import {
  isHttpUrl,
  toBool,
  toIntInRange,
  toOptionalUrl,
  toText,
  type Validation,
} from "./validation";

export type { Validation };

/**
 * The pure half of the premium tier: what a valid admin entry looks like for a premium
 * channel, a provider registration and a push to the stream box. Nothing in here touches
 * MongoDB, the network or React, so `npm run test:premium-channels` can execute it
 * directly — the storing half lives in `lib/premiumStore.ts`.
 *
 * The rules for a match card are not here: they belong to the Direct HLS panel that writes
 * them, and live in `lib/fixtures.ts`.
 */

/**
 * The handle the stream box files a provider or a channel under.
 *
 * The box's own rule, copied rather than guessed: a handle that breaks it would be refused
 * there with a message about a field the admin never saw, and it is put in a path, so it must
 * not be able to carry a slash.
 *
 * The leading character is part of the rule and not an afterthought: the box refuses a handle
 * that starts with a dash or an underscore, so a handle accepted here and refused there would be
 * a form that says yes to a value the box will not take.
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
