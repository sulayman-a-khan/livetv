/**
 * The write half of the 24/7 proxy control tier.
 *
 * The read half (`lib/proxyControl.ts`) may look at the box. This module may change it, and
 * it is the only place in the site that holds the box's *write* credential — derived for the
 * one box this server is talking to, the same credential the premium tier uses to push a
 * source onto the box.
 *
 * Four properties this file has to keep, and each one is a decision rather than a detail:
 *
 *   - **The browser never holds a proxy credential.** A panel asks this server for an action
 *     by name; the server performs it with the token in its own environment and answers with
 *     a projection. A panel that could write to the box itself would need that token in the
 *     page, where it would be readable by anything that can read the page.
 *   - **The action list is closed.** A caller names one of the actions below and supplies the
 *     arguments that action reads. It cannot supply a path, a URL, a host or a body: the
 *     request to the box is built here from a table, with an argument that has been
 *     pattern-checked against the box's own rules. There is no route through this module
 *     that reaches a box path the table does not name.
 *   - **A credential is an argument, never a stored value.** A provider's password is read
 *     from the request, put into the body of the one request that needs it, and forgotten.
 *     It is not written down here, not logged, and not echoed back in the answer.
 *   - **The box's answer is projected, not passed through.** Its admin projections carry a
 *     lane identity and a stream id; its error bodies carry free text that can name a host.
 *     None of that is copied here, so none of it can reach a browser. What travels back is a
 *     machine code and a handful of numbers.
 *
 * The admin secret is checked before the box is asked at all, so an unauthorized caller cannot
 * make this server write on their behalf.
 */
import { isProxyAdminSecretValid } from "./proxyControl";
import { boxConfigProblem, currentBoxToken, resolveBoxAddress } from "./boxRegistry";
import { boxSecret } from "./boxCredentials";

/**
 * How long the box has to answer an action.
 *
 * The slowest action is the probe: the box opens the upstream itself and waits for a
 * manifest, which it allows twelve seconds for. The site waits longer than that so the box's
 * own answer — rather than a timeout on this side — is what the operator gets to see.
 */
const ACTION_TIMEOUT_MS = 20_000;

/**
 * The largest answer read from the box. A write answer is a handful of rows; the cap keeps a
 * misconfigured base URL from turning a panel into a memory sink.
 */
const MAX_ACTION_BYTES = 64 * 1024;

/**
 * Every action this server performs, and the only ones. The names are the contract between
 * the panel and this module, so they are listed here rather than being derived from whatever
 * the request happens to carry.
 */
export const PROXY_ACTION_NAMES = [
  "refresh_vault",
  "set_provider_active",
  "set_channel_active",
  "probe_channel",
  "create_provider",
  "update_provider",
  "delete_provider",
  "create_channel",
  "update_channel",
  "delete_channel",
] as const;

export type ProxyActionName = (typeof PROXY_ACTION_NAMES)[number];

/**
 * Every argument an action may read. The list is closed for the same reason the action list
 * is: a caller can send anything at all, and everything that is not named here is ignored —
 * never read, never forwarded to the box.
 */
const ARG_NAMES = [
  "target",
  "active",
  "label",
  "serverUrl",
  "username",
  "password",
  "displayName",
  "category",
  "logoUrl",
  "providerId",
  "streamId",
  "backupStreamIds",
] as const;

type ArgName = (typeof ARG_NAMES)[number];

/** The value an argument may carry. */
type ArgValue = string | boolean | string[];

/** The arguments one action was given, after validation. */
interface ActionArgs {
  target?: string;
  active?: boolean;
  label?: string;
  serverUrl?: string;
  username?: string;
  password?: string;
  displayName?: string;
  category?: string;
  logoUrl?: string;
  providerId?: string;
  streamId?: string;
  backupStreamIds?: string[];
}

/**
 * The box's own key rule, copied from `ProxyServer/src/config.ts`: two to sixty-four
 * characters of `[a-z0-9_-]`, starting with a letter or a digit.
 *
 * Matching it here is what makes the handle safe to put in a path — no slash, no dot, no
 * percent sign, nothing that could turn one request into two — and matching it here means
 * the box never has to answer with a validation error for an id the panel could not have
 * produced.
 */
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

/** A stream id on a provider account: one to thirty-two characters of `[A-Za-z0-9_-]`. */
const STREAM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** How many backup streams a channel may name. The box's own ceiling. */
const MAX_BACKUP_STREAM_IDS = 8;

/**
 * The box's own length limits, copied from `ProxyServer/src/registry.ts`.
 *
 * They are copied rather than guessed so that a value this server accepts is a value the box
 * accepts: a label of a hundred characters would otherwise be refused by the box with a
 * message about a field the admin never saw, which is the worst way to be told.
 */
const LIMITS = {
  displayName: 80,
  label: 80,
  category: 40,
  logoUrl: 512,
  serverUrl: 512,
  username: 64,
  password: 64,
} as const;

/** What one action reads, and whether it has to be there. */
interface ArgSpec {
  name: ArgName;
  required: boolean;
}

interface ActionSpec {
  method: "POST" | "PATCH" | "DELETE";
  /** The arguments this action reads. */
  args: ArgSpec[];
  /** The box path. Built only from a validated handle, so it cannot carry a slash or a dot. */
  path: (args: ActionArgs) => string;
  /** The body to send, when the action has one. */
  body?: (args: ActionArgs) => Record<string, unknown>;
}

/**
 * The table. Every request to the box's write surface comes from one of these rows, and the
 * path of each is assembled here rather than supplied by the caller.
 */
const ACTIONS: Record<ProxyActionName, ActionSpec> = {
  /** Re-read the vault: the operator edited a row by hand and wants the box to notice now. */
  refresh_vault: {
    method: "POST",
    args: [],
    path: () => "/admin/refresh",
  },
  /** Take one provider account out of service, or put it back. */
  set_provider_active: {
    method: "PATCH",
    args: [
      { name: "target", required: true },
      { name: "active", required: true },
    ],
    path: (args) => `/admin/providers/${encodeURIComponent(args.target ?? "")}`,
    body: (args) => ({ active: args.active }),
  },
  /** Take one channel out of service, or put it back. */
  set_channel_active: {
    method: "PATCH",
    args: [
      { name: "target", required: true },
      { name: "active", required: true },
    ],
    path: (args) => `/admin/channels/${encodeURIComponent(args.target ?? "")}`,
    body: (args) => ({ active: args.active }),
  },
  /** "Does this credential work?" — the box probes the source through the channel's own lane. */
  probe_channel: {
    method: "POST",
    args: [{ name: "target", required: true }],
    path: (args) => `/admin/channels/${encodeURIComponent(args.target ?? "")}/probe`,
  },

  /**
   * Register a provider account on the box.
   *
   * The address and the credential travel in this one request and are sealed by the box before
   * they are stored; nothing here keeps a copy of them. The lane is keyed on the credential,
   * so two providers with the same address and user are refused by the box as duplicates.
   */
  create_provider: {
    method: "POST",
    args: [
      { name: "target", required: true },
      { name: "label", required: true },
      { name: "serverUrl", required: true },
      { name: "username", required: true },
      { name: "password", required: true },
    ],
    path: () => "/admin/providers",
    body: (args) => ({
      providerId: args.target,
      label: args.label,
      kind: "xtream",
      serverUrl: args.serverUrl,
      username: args.username,
      password: args.password,
      // One upstream connection per provider, which is the promise the whole lane design rests
      // on: a second connection would be a second stream the account did not ask for.
      maxConnections: 1,
    }),
  },
  /**
   * Edit a provider account.
   *
   * Every field except the password may be left out, and the box keeps what it has. The
   * password is only sent when the admin typed a new one, which is how the stored credential
   * survives an edit that never touched it.
   */
  update_provider: {
    method: "PATCH",
    args: [
      { name: "target", required: true },
      { name: "label", required: false },
      { name: "serverUrl", required: false },
      { name: "username", required: false },
      { name: "password", required: false },
    ],
    path: (args) => `/admin/providers/${encodeURIComponent(args.target ?? "")}`,
    body: (args) => {
      const body: Record<string, unknown> = {};
      if (args.label) body.label = args.label;
      if (args.serverUrl) body.serverUrl = args.serverUrl;
      if (args.username) body.username = args.username;
      if (args.password) body.password = args.password;
      return body;
    },
  },
  /** Take a provider account off the box. The box refuses while a channel still points at it. */
  delete_provider: {
    method: "DELETE",
    args: [{ name: "target", required: true }],
    path: (args) => `/admin/providers/${encodeURIComponent(args.target ?? "")}`,
  },
  /**
   * Register a channel on the box, with the stream it plays and the streams it falls back to.
   *
   * The failover order is the order of `backupStreamIds`: the box tries the primary, then the
   * first backup, then the second.
   */
  create_channel: {
    method: "POST",
    args: [
      { name: "target", required: true },
      { name: "displayName", required: true },
      { name: "providerId", required: true },
      { name: "streamId", required: true },
      { name: "backupStreamIds", required: false },
      { name: "category", required: false },
      { name: "logoUrl", required: false },
      { name: "active", required: false },
    ],
    path: () => "/admin/channels",
    body: (args) => ({
      channelKey: args.target,
      displayName: args.displayName,
      category: args.category || "premium",
      logoUrl: args.logoUrl || "",
      // A new channel is on air unless the caller says otherwise; the panel's own live switch
      // is what takes it off again.
      active: args.active !== false,
      providerId: args.providerId,
      streamId: args.streamId,
      backupStreamIds: args.backupStreamIds ?? [],
    }),
  },
  /**
   * Edit a channel on the box.
   *
   * Only the fields that were sent are changed, so renaming a channel never quietly drops
   * its failover order and never switches a channel the admin took off air back on.
   */
  update_channel: {
    method: "PATCH",
    args: [
      { name: "target", required: true },
      { name: "displayName", required: false },
      { name: "providerId", required: false },
      { name: "streamId", required: false },
      { name: "backupStreamIds", required: false },
      { name: "category", required: false },
      { name: "logoUrl", required: false },
    ],
    path: (args) => `/admin/channels/${encodeURIComponent(args.target ?? "")}`,
    body: (args) => {
      const body: Record<string, unknown> = {};
      if (args.displayName) body.displayName = args.displayName;
      if (args.providerId) body.providerId = args.providerId;
      if (args.streamId) body.streamId = args.streamId;
      if (args.backupStreamIds) body.backupStreamIds = args.backupStreamIds;
      if (args.category) body.category = args.category;
      if (args.logoUrl) body.logoUrl = args.logoUrl;
      return body;
    },
  },
  /** Take a channel off the box. */
  delete_channel: {
    method: "DELETE",
    args: [{ name: "target", required: true }],
    path: (args) => `/admin/channels/${encodeURIComponent(args.target ?? "")}`,
  },
};

/** A handle the box itself would accept, lowercased the way the box lowercases it. */
function handleOf(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return HANDLE_RE.test(raw) ? raw.toLowerCase() : null;
}

type ReadResult<T extends ArgValue> = { ok: true; value: T } | { ok: false; message: string };

/** Free text: trimmed, without control characters, and within the box's own limit. */
function readText(raw: unknown, label: string, max: number, required: boolean): ReadResult<string> {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    if (required) return { ok: false, message: `${label} is required` };
    return { ok: true, value: "" };
  }
  if (value.length > max) return { ok: false, message: `${label} must be ${max} characters or fewer` };
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, message: `${label} must not contain control characters` };
  }
  return { ok: true, value };
}

/**
 * A credential: like text, but it may not contain a slash.
 *
 * The box builds a panel URL out of the address, the user and the password, and a slash in
 * either of the last two would change the path that is asked for. The box refuses it too;
 * refusing it here means the panel says which field is wrong.
 */
function readCredential(
  raw: unknown,
  label: string,
  max: number,
  required: boolean
): ReadResult<string> {
  const text = readText(raw, label, max, required);
  if (!text.ok) return text;
  if (text.value.includes("/")) {
    return { ok: false, message: `${label} must not contain a slash` };
  }
  return text;
}

/**
 * A panel address.
 *
 * The box refuses a metadata address, a private address in production, a query and a
 * fragment; the last two are refused here as well because they are the admin's own typos
 * rather than the box's policy. The address itself is checked by the box, which knows what
 * its own network looks like and this server does not.
 */
function readServerUrl(raw: unknown): ReadResult<string> {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: false, message: "Server URL is required" };
  if (value.length > LIMITS.serverUrl) {
    return { ok: false, message: `Server URL must be ${LIMITS.serverUrl} characters or fewer` };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "Server URL must be an absolute http(s) URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "Server URL must be an http(s) URL" };
  }
  if (url.hash) return { ok: false, message: "Server URL must not carry a fragment" };
  if (url.search) return { ok: false, message: "Server URL must not carry a query" };
  if (url.username || url.password) {
    return { ok: false, message: "Server URL must not embed a username or password" };
  }
  return { ok: true, value: value.replace(/\/+$/, "") };
}

/**
 * A channel's picture.
 *
 * The app page is https, so an http logo would be blocked by the browser anyway — which is
 * the box's rule too, and the reason a logo is checked here rather than left to fail later.
 */
function readLogoUrl(raw: unknown): ReadResult<string> {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: true, value: "" };
  if (value.length > LIMITS.logoUrl) {
    return { ok: false, message: `Logo URL must be ${LIMITS.logoUrl} characters or fewer` };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "Logo URL must be an absolute URL" };
  }
  if (url.protocol !== "https:") return { ok: false, message: "Logo URL must be https" };
  return { ok: true, value };
}

/** One stream id on a provider account. */
function readStreamId(raw: unknown, required: boolean): ReadResult<string> {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    if (required) return { ok: false, message: "Stream ID is required" };
    return { ok: true, value: "" };
  }
  if (!STREAM_ID_RE.test(value)) {
    return { ok: false, message: "Stream ID must be 1-32 characters of letters, digits, - or _" };
  }
  return { ok: true, value };
}

/**
 * The streams a channel falls back to, in the order it falls back to them.
 *
 * An empty list is a real answer — it means "no backups" — so a list that was sent is never
 * confused with a list that was not sent at all.
 */
function readBackupStreamIds(raw: unknown): ReadResult<string[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "Backup stream IDs must be a list" };
  }
  if (raw.length > MAX_BACKUP_STREAM_IDS) {
    return {
      ok: false,
      message: `Backup stream IDs must name at most ${MAX_BACKUP_STREAM_IDS} streams`,
    };
  }
  const ids: string[] = [];
  for (const entry of raw) {
    const value = typeof entry === "string" ? entry.trim() : "";
    if (!STREAM_ID_RE.test(value)) {
      return {
        ok: false,
        message: "Every backup stream ID must be 1-32 characters of letters, digits, - or _",
      };
    }
    if (ids.includes(value)) {
      return { ok: false, message: "Backup stream IDs must not name the same stream twice" };
    }
    ids.push(value);
  }
  return { ok: true, value: ids };
}

/**
 * Reads one argument, or says which argument is wrong.
 *
 * The switch is here rather than in a table of functions because the readers have different
 * shapes — some take a maximum, some take a flag — and a table of closures would hide which
 * rule belongs to which field.
 */
function readArg(name: ArgName, raw: unknown, required: boolean): ReadResult<ArgValue> {
  switch (name) {
    case "target": {
      const handle = handleOf(raw);
      return handle
        ? { ok: true, value: handle }
        : { ok: false, message: "Target id must be 2-64 characters of letters, digits, - or _" };
    }
    case "providerId": {
      const handle = handleOf(raw);
      return handle
        ? { ok: true, value: handle }
        : { ok: false, message: "Provider id must be 2-64 characters of letters, digits, - or _" };
    }
    case "active":
      return typeof raw === "boolean"
        ? { ok: true, value: raw }
        : { ok: false, message: "active must be true or false" };
    case "label":
      return readText(raw, "Label", LIMITS.label, required);
    case "displayName":
      return readText(raw, "Channel name", LIMITS.displayName, required);
    case "category":
      return readText(raw, "Category", LIMITS.category, required);
    case "serverUrl":
      return readServerUrl(raw);
    case "username":
      return readCredential(raw, "Username", LIMITS.username, required);
    case "password":
      return readCredential(raw, "Password", LIMITS.password, required);
    case "logoUrl":
      return readLogoUrl(raw);
    case "streamId":
      return readStreamId(raw, required);
    case "backupStreamIds":
      return readBackupStreamIds(raw);
  }
}

/**
 * What an action is allowed to report. Numbers, booleans and two short enums — nothing that
 * can name a host, a credential, a lane or a stream.
 */
export interface ProxyActionDetail {
  /** The row's new state, for the two set-active actions. */
  active?: boolean | null;
  /** The vault's counters, for the refresh. */
  providers?: number | null;
  stored?: number | null;
  resolvable?: number | null;
  /** True when the vault reported a problem. The text stays on the box. */
  hasError?: boolean | null;
  /** How the probe was made: through the channel's own lane, or straight at a cold row. */
  via?: "lane" | "cold" | null;
  /** Whether the probed source answered. */
  probeOk?: boolean | null;
  httpStatus?: number | null;
  levels?: number | null;
  segments?: number | null;
  bytes?: number | null;
  tookMs?: number | null;
  /** True when a row was taken off the box. */
  removed?: boolean | null;
  /** How many backups the channel now carries. A count, never the ids. */
  backupCount?: number | null;
}

export interface ProxyActionDeps {
  /** Defaults to `PROXY_BASE_URL`. Never taken from a request. */
  baseUrl?: string;
  /** The box's admin token. Defaults to the token derived for the enrolled box. Never taken from a request. */
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ProxyActionResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Why this server could not perform the action, in its own words.
 *
 * These are the panel's whole vocabulary for a failure, and they are closed so the panel can
 * say each one in its own language instead of showing the server's English text. The box's
 * own refusal code travels separately, in `result.code`.
 */
export type ProxyActionFailureCode =
  | "unauthorized"
  | "unknown_action"
  | "invalid_target"
  | "invalid_active"
  | "invalid_argument"
  | "not_configured"
  | "unreachable"
  | "unreadable_answer"
  | "refused"
  | "unknown_row"
  | "conflict"
  | "refused_credential"
  | "box_error";

/**
 * What a caller may send.
 *
 * The index signature is deliberate: a caller can send anything at all, and every field
 * other than the ones below is ignored — never read, never forwarded. Naming them here is
 * what says which are real.
 */
export interface ProxyActionRequest {
  action?: unknown;
  target?: unknown;
  active?: unknown;
  label?: unknown;
  serverUrl?: unknown;
  username?: unknown;
  password?: unknown;
  displayName?: unknown;
  category?: unknown;
  logoUrl?: unknown;
  providerId?: unknown;
  streamId?: unknown;
  backupStreamIds?: unknown;
  [key: string]: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The box's own refusal code, when it gave one. Machine-shaped by construction: the codes are
 * snake_case identifiers, and a body that carries anything else is treated as carrying no
 * code at all rather than as carrying text.
 */
function codeOf(body: Record<string, unknown>): string | null {
  const raw = body.code;
  return typeof raw === "string" && /^[a-z0-9_]{1,40}$/.test(raw) ? raw : null;
}

/**
 * The projection of one answer. Each action reports only the fields that answer its own
 * question: the vault's counters for a refresh, the new state for an activation, the
 * manifest's shape for a probe, and for a write that added or changed a row, only what it
 * is safe to say — the row's own state and how many backups it carries.
 */
function detailOf(action: ProxyActionName, body: Record<string, unknown>): ProxyActionDetail {
  switch (action) {
    case "refresh_vault": {
      const registry = record(body.registry);
      return {
        providers: numOrNull(registry.providers),
        stored: numOrNull(registry.stored),
        resolvable: numOrNull(registry.resolvable),
        hasError: typeof registry.error === "string" && registry.error !== "",
      };
    }
    case "set_provider_active": {
      const provider = record(body.provider);
      return { active: typeof provider.active === "boolean" ? provider.active : null };
    }
    case "set_channel_active": {
      const channel = record(body.channel);
      return { active: typeof channel.active === "boolean" ? channel.active : null };
    }
    case "probe_channel": {
      const probe = record(body.probe);
      const via = body.via === "lane" || body.via === "cold" ? body.via : null;
      return {
        via,
        probeOk: typeof body.ok === "boolean" ? body.ok : null,
        httpStatus: numOrNull(probe.httpStatus),
        levels: numOrNull(probe.levels),
        segments: numOrNull(probe.segments),
        bytes: numOrNull(typeof body.bytes === "number" ? body.bytes : probe.bytes),
        tookMs: numOrNull(probe.tookMs),
      };
    }
    case "create_provider":
    case "update_provider": {
      const provider = record(body.provider);
      return { active: typeof provider.active === "boolean" ? provider.active : null };
    }
    case "delete_provider": {
      return { removed: typeof body.removed === "string" || body.removed === true ? true : null };
    }
    case "create_channel":
    case "update_channel": {
      const channel = record(body.channel);
      return {
        active: typeof channel.active === "boolean" ? channel.active : null,
        backupCount: numOrNull(channel.backupCount),
      };
    }
    case "delete_channel": {
      return { removed: typeof body.removed === "string" || body.removed === true ? true : null };
    }
  }
}

/**
 * The status the site answers with.
 *
 * A failed probe is not a failed action: the box ran the probe and the source did not
 * answer, which is the answer the operator asked for. Everything else maps onto what the
 * caller can act on — a row that is not there (404), a change the box refused (400), a row
 * that already exists or is still in use (409), and anything the box could not do at all
 * (502, which includes a refused credential, because that is this server's problem and not
 * the caller's).
 */
function siteStatusFor(
  action: ProxyActionName,
  boxStatus: number,
  body: Record<string, unknown>
): number {
  if (boxStatus >= 200 && boxStatus < 300) return 200;
  if (action === "probe_channel" && boxStatus === 502 && body.via === "cold") return 200;
  if (boxStatus === 400) return 400;
  if (boxStatus === 404) return 404;
  if (boxStatus === 409) return 409;
  return 502;
}

/**
 * What the panel is told when the box refused. A phrase chosen here, never the box's own
 * text: the box's message can name a host, and the panel has no need for it.
 */
function failurePhrase(boxStatus: number): string {
  if (boxStatus === 400) return "the stream box refused the change";
  if (boxStatus === 404) return "the stream box does not know that row";
  if (boxStatus === 409) return "the stream box already has that row, or it is still in use";
  if (boxStatus === 401 || boxStatus === 403) {
    return "the stream box refused this server's credential";
  }
  return "the stream box failed while making the change";
}

/** The same refusal, as one of this server's own codes, so the panel can name it. */
function failureCodeFor(boxStatus: number): ProxyActionFailureCode {
  if (boxStatus === 400) return "refused";
  if (boxStatus === 404) return "unknown_row";
  if (boxStatus === 409) return "conflict";
  if (boxStatus === 401 || boxStatus === 403) return "refused_credential";
  return "box_error";
}

/**
 * What this server is missing, by name only.
 *
 * The write surface needs the address and a credential for the one box it is talking to;
 * without either one the action cannot be performed, and saying which one is missing is
 * the difference between a five minute fix and an hour of guessing.
 *
 * The three are in a chain of dependence and only the first missing one is named: without a
 * master secret there is nothing to derive a token from; with a secret but no enrolled box
 * there is no box to derive one for; with a box but no address there is nowhere to reach
 * it.
 */
export async function proxyActionConfigProblem(): Promise<string | null> {
  return boxConfigProblem();
}

/**
 * The action itself: the arguments are read and checked, and then the box is asked.
 *
 * This is the part a route that has already decided who is calling wants. The admin secret
 * is checked by `proxyActionResponse` above it; a route of the premium tier has its own
 * gate and calls this directly, so that the two tiers share one door to the box rather than
 * two doors and two sets of rules.
 */
export async function performProxyAction(
  request: ProxyActionRequest,
  deps: ProxyActionDeps = {}
): Promise<ProxyActionResponse> {
  const name = typeof request.action === "string" ? request.action.trim() : "";
  const spec: ActionSpec | undefined = (ACTIONS as Record<string, ActionSpec | undefined>)[name];
  if (!spec) {
    return {
      status: 400,
      body: {
        success: false,
        code: "unknown_action",
        error: "that action is not one this server performs",
        allowed: [...PROXY_ACTION_NAMES],
      },
    };
  }
  const action = name as ProxyActionName;

  // The arguments this action reads, and only those: a caller that sends a field the action
  // does not read has that field dropped here, before the request to the box is built.
  const args: ActionArgs = {};
  for (const arg of spec.args) {
    const raw = request[arg.name];
    const absent = raw === undefined || raw === null;
    if (absent && !arg.required) continue;
    const read = readArg(arg.name, raw, arg.required);
    if (!read.ok) {
      return {
        status: 400,
        body: {
          success: false,
          code: arg.name === "target" ? "invalid_target" : arg.name === "active" ? "invalid_active" : "invalid_argument",
          error: read.message,
        },
      };
    }
    (args as Record<string, ArgValue>)[arg.name] = read.value;
  }

  // A change with nothing in it is a mistake, not a no-op the box should have to notice.
  if (spec.method === "PATCH" && spec.body) {
    const body = spec.body(args);
    if (Object.keys(body).length === 0) {
      return {
        status: 400,
        body: {
          success: false,
          code: "invalid_argument",
          error: "that action needs at least one field to change",
        },
      };
    }
  }

  // A backup that names the primary stream is not a fallback — it is the same stream twice,
  // and the box refuses it. It is refused here too, so the panel says which field is wrong
  // instead of the box refusing a row the admin could not have built correctly.
  if (args.streamId && args.backupStreamIds?.includes(args.streamId)) {
    return {
      status: 400,
      body: {
        success: false,
        code: "invalid_argument",
        error: "a backup stream cannot be the same as the primary stream",
      },
    };
  }

  const baseUrl = (
    deps.baseUrl ?? (await resolveBoxAddress())?.baseUrl ?? ""
  ).trim().replace(/\/+$/, "");
  const token = (deps.token ?? (await currentBoxToken("admin")) ?? "").trim();
  if (!baseUrl || !token) {
    // The chain, in the order the things depend on each other. The credential comes first:
    // without one there is no box to write to, whatever the address says, and naming the
    // address would send the operator to edit a variable that is already set.
    const missing = !token
      ? boxSecret()
        ? "an enrolled stream box"
        : "PROXY_BOX_SECRET"
      : "PROXY_BASE_URL";
    return {
      status: 503,
      body: {
        success: false,
        code: "not_configured",
        error: `the stream box cannot be written to from this server (missing ${missing})`,
      },
    };
  }

  const body = spec.body ? spec.body(args) : undefined;
  const send = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await send(`${baseUrl}${spec.path(args)}`, {
      method: spec.method,
      headers: {
        // The box's write credential, in the header the box expects. It never appears in a
        // URL, a body, an answer or a log line.
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(deps.timeoutMs ?? ACTION_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return {
      status: 502,
      body: { success: false, code: "unreachable", error: "the stream box could not be reached" },
    };
  }

  const declared = Number(res.headers?.get?.("content-length") || "");
  const oversize = Number.isFinite(declared) && declared > MAX_ACTION_BYTES;
  const raw = oversize ? "" : await res.text();
  if (!oversize && raw.length > MAX_ACTION_BYTES) {
    // The body that actually arrived is bigger than the declared one, or there was no
    // declaration at all. Either way it is not an answer this module can read.
    return {
      status: 502,
      body: {
        success: false,
        code: "unreadable_answer",
        error: "the stream box answered with something too large to read",
      },
    };
  }
  let answer: Record<string, unknown> = {};
  try {
    answer = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // A tunnel that answers in HTML says more about the transport than its body would, and
    // the body could carry back the address that was asked for.
    answer = {};
  }

  const code = codeOf(answer);
  const detail = detailOf(action, answer);
  const status = siteStatusFor(action, res.status, answer);
  const changed = res.status >= 200 && res.status < 300;

  const result = {
    action,
    target: args.target ?? null,
    ok: changed,
    code,
    detail,
  };

  if (status === 200 && (changed || action === "probe_channel")) {
    return { status: 200, body: { success: true, result } };
  }

  return {
    status,
    body: {
      success: false,
      code: failureCodeFor(res.status),
      error: failurePhrase(res.status),
      result,
    },
  };
}

/**
 * The whole of the action endpoint: the auth decision, the action decision, and only then
 * the box.
 *
 * The order matters and is the point of this function. An unauthorized call is answered
 * without the box ever being asked, and an unknown action is answered without the box ever
 * being asked either — so neither an unauthorized caller nor a curious one can make this
 * server talk to the box on their behalf.
 */
export async function proxyActionResponse(
  presentedSecret: string | null | undefined,
  request: ProxyActionRequest,
  deps: ProxyActionDeps = {}
): Promise<ProxyActionResponse> {
  if (!isProxyAdminSecretValid(presentedSecret)) {
    return {
      status: 401,
      body: { success: false, code: "unauthorized", error: "Unauthorized: Invalid Admin Secret Key" },
    };
  }
  return performProxyAction(request, deps);
}
