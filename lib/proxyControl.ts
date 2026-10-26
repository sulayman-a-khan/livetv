/**
 * The 24/7 proxy control tier's only door to the stream box.
 *
 * What this module is allowed to read, and why that is all it reads:
 *
 *   - The health route (`GET /healthz`) asks for no token, reads in-process state only,
 *     performs no upstream fetch, opens no provider session and cannot consume a
 *     provider's connection limit — so asking it cannot disturb a stream somebody is
 *     already watching.
 *   - The inspection routes (`GET /readonly/*`) are guarded by the box's own **read-only**
 *     token, a credential that can look at the vault and change nothing: it is refused by
 *     every write route on the box, and the box does not expose the vault's admin surface
 *     to it at all. The token lives in this server's environment and never in a response,
 *     a URL or a log line.
 *   - It projects every answer into a fixed shape. The box's body is never passed through, so
 *     a field the box grows tomorrow — or an error string that names a host — cannot reach
 *     a browser by accident.
 *
 * The site keeps `PROXY_BASE_URL` in its own environment and never in a request, so nothing
 * here builds a URL out of anything a caller supplied: the threat `lib/safeFetch.ts` guards
 * against is not present on this path.
 */
import { safeEquals } from "./adminAuth";

/**
 * How long the box has to answer. The health route does no work, so this is only ever the
 * time a cold tunnel or an unreachable host takes to say so.
 */
const HEALTH_TIMEOUT_MS = 5_000;

/**
 * The largest health answer that is read. The real body is a few hundred bytes; a cap keeps
 * a misconfigured base URL from turning a status page into a memory sink.
 */
const MAX_HEALTH_BYTES = 64 * 1024;

/**
 * The four states the panel distinguishes. "Reachable" and "usable" are deliberately
 * separate: the box answers `ok: true` even while its vault is broken, and a dashboard that
 * reads that as "healthy" would hide the one failure an operator has to act on.
 */
export type BoxState = "usable" | "degraded" | "unusable" | "unreachable";

export interface ProxyBoxSnapshot {
  state: BoxState;
  /** The box answered. Says nothing about whether it can serve. */
  reachable: boolean;
  /** The box answered and can serve: healthy process *and* a ready vault. */
  usable: boolean;
  /** This server's clock, when the answer was learned. */
  checkedAt: number;
  /**
   * When the box last answered: this read, if it succeeded, otherwise the one before it.
   * A serverless host forgets between requests, so this is what lets a panel say when the
   * box last worked instead of only that it is not working now.
   */
  lastSuccessAt: number | null;
  service: string | null;
  uptimeMs: number | null;
  counters: {
    sourcesConfigured: number;
    sessions: number;
    maxConcurrentUpstream: number;
    upstreamRuns: number;
  };
  vault: {
    driver: string | null;
    ready: boolean;
    stored: number;
    resolvable: number;
    unreadable: number;
    /**
     * True when the box reported a vault problem. The text itself never leaves the box: it
     * is the one field there that can name a host, so the panel is told there is a problem
     * and the operator is pointed at the box's own log.
     */
    hasError: boolean;
  };
  ownership: {
    /** `process-local` or `shared-filesystem`; null when the box did not say. */
    mode: "process-local" | "shared-filesystem" | null;
    held: number;
    refusals: number;
    /**
     * Always false. Nothing in this project enforces a connection cap across two machines,
     * and a panel that implied otherwise would be claiming enforcement it cannot show.
     */
    crossMachineEnforced: false;
  };
  capacity: {
    refusals: number;
    lanes: { channels: number; maxConnections: number }[];
    last: {
      channelKey: string | null;
      code: string | null;
      holders: number;
      maxConnections: number;
      at: number | null;
    } | null;
  };
  guard: {
    mode: "permissive" | "strict" | null;
    siteGateActive: boolean;
    listed: number;
    wildcard: number;
    absent: number;
    foreign: number;
    absentRefused: number;
  };
  surfaces: { admin: boolean; appApi: boolean };
}

export interface ProxyControlDeps {
  /** Defaults to `PROXY_BASE_URL`. Never taken from a request. */
  baseUrl?: string;
  /**
   * The box's read-only token. Defaults to `PROXY_READONLY_TOKEN`. Never taken from a
   * request, and never leaves this server.
   */
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

// --- reading the box's answer, and nothing else ---

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function flag(value: unknown): boolean {
  return value === true;
}

/** Only the box's own service name is accepted, and only in the shape it uses. */
function serviceName(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9-]{1,40}$/i.test(value) ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** A handle the box reports: the channel it refused, not a credential. */
function handle(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value) ? value : null;
}

/** A refusal code: short, machine-like, and never free text. */
function code(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9_]{1,40}$/i.test(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * The whole projection, with no network in it, so the rules can be argued with in a test.
 *
 * The states are decided here and nowhere else:
 *   - `unreachable` — nothing usable came back. No answer, a wrong status, or a body that
 *     is not the health answer. This is the absence of information.
 *   - `unusable` — the box answered and reported itself not ok.
 *   - `degraded` — the box answered and says it is ok, but its vault is not ready or
 *     reported a problem. The process is up; the service it exists for is not.
 *   - `usable` — the box answered, says it is ok, and its vault is ready.
 */
export function snapshotFromHealth(
  reply: { status: number; body: unknown },
  now: number,
  lastSuccessAt: number | null = null
): ProxyBoxSnapshot {
  const empty: ProxyBoxSnapshot = {
    state: "unreachable",
    reachable: false,
    usable: false,
    checkedAt: now,
    lastSuccessAt,
    service: null,
    uptimeMs: null,
    counters: { sourcesConfigured: 0, sessions: 0, maxConcurrentUpstream: 0, upstreamRuns: 0 },
    vault: { driver: null, ready: false, stored: 0, resolvable: 0, unreadable: 0, hasError: false },
    ownership: { mode: null, held: 0, refusals: 0, crossMachineEnforced: false },
    capacity: { refusals: 0, lanes: [], last: null },
    guard: {
      mode: null,
      siteGateActive: false,
      listed: 0,
      wildcard: 0,
      absent: 0,
      foreign: 0,
      absentRefused: 0,
    },
    surfaces: { admin: false, appApi: false },
  };

  if (reply.status !== 200) return empty;
  if (typeof reply.body !== "object" || reply.body === null || Array.isArray(reply.body)) {
    return empty;
  }

  const body = reply.body as Record<string, unknown>;
  const vault = record(body.vault);
  const ownership = record(body.ownership);
  const busy = record(body.providerBusy);
  const guard = record(body.guard);
  const last = record(busy.last);
  const lanes = Array.isArray(busy.lanes) ? busy.lanes : [];

  const vaultReady = vault.ready === true;
  const vaultHasError = vault.error !== null && vault.error !== undefined && vault.error !== "";

  const snapshot: ProxyBoxSnapshot = {
    state: "unusable",
    reachable: true,
    usable: false,
    checkedAt: now,
    lastSuccessAt,
    service: serviceName(body.service),
    uptimeMs: typeof body.uptimeMs === "number" && Number.isFinite(body.uptimeMs) ? body.uptimeMs : null,
    counters: {
      sourcesConfigured: num(body.sourcesConfigured),
      sessions: num(body.sessions),
      maxConcurrentUpstream: num(body.maxConcurrentUpstream),
      upstreamRuns: num(body.upstreamRuns),
    },
    vault: {
      driver: oneOf(vault.driver, ["memory", "mongo", "config"] as const),
      ready: vaultReady,
      stored: num(vault.stored),
      resolvable: num(vault.resolvable),
      unreadable: num(vault.unreadable),
      hasError: vaultHasError,
    },
    ownership: {
      mode: oneOf(ownership.mode, ["process-local", "shared-filesystem"] as const),
      held: num(ownership.held),
      refusals: num(ownership.refusals),
      crossMachineEnforced: false,
    },
    capacity: {
      refusals: num(busy.refusals),
      lanes: lanes.slice(0, 64).map((lane) => {
        const row = record(lane);
        return { channels: num(row.channels), maxConnections: num(row.maxConnections) };
      }),
      last:
        Object.keys(last).length > 0
          ? {
              channelKey: handle(last.channelKey),
              code: code(last.code),
              holders: num(last.holders),
              maxConnections: num(last.maxConnections),
              at: typeof last.at === "number" && Number.isFinite(last.at) ? last.at : null,
            }
          : null,
    },
    guard: {
      mode: oneOf(guard.mode, ["permissive", "strict"] as const),
      siteGateActive: flag(guard.siteGateActive),
      listed: num(guard.listed),
      wildcard: num(guard.wildcard),
      absent: num(guard.absent),
      foreign: num(guard.foreign),
      absentRefused: num(guard.absentRefused),
    },
    surfaces: { admin: flag(body.admin), appApi: flag(body.appApi) },
  };

  if (body.ok !== true) return snapshot;

  // The box says it is ok. That is not the same as saying it can serve: its vault has to be
  // ready as well, and a vault that reported an error is a service that cannot deliver.
  snapshot.state = vaultReady && !vaultHasError ? "usable" : "degraded";
  snapshot.usable = snapshot.state === "usable";
  return snapshot;
}

// --- the last successful answer, for a serverless host that forgets between requests ---

interface ControlSlot {
  lastSuccessAt: number | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __soluplay_proxy_control: ControlSlot | undefined;
}

function slot(): ControlSlot {
  globalThis.__soluplay_proxy_control ??= { lastSuccessAt: null };
  return globalThis.__soluplay_proxy_control;
}

/**
 * Ask the box once.
 *
 * Never throws: an unreachable box is a state, not an exception, and a route that treated a
 * question as an error would turn a dead box into a 500 page instead of a reading.
 */
export async function readProxyBoxSnapshot(
  deps: ProxyControlDeps = {}
): Promise<ProxyBoxSnapshot> {
  const clock = deps.now ?? Date.now;
  const now = clock();
  const baseUrl = (deps.baseUrl ?? process.env.PROXY_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    return snapshotFromHealth({ status: 0, body: null }, now, slot().lastSuccessAt);
  }

  const send = deps.fetchImpl ?? fetch;
  let reply: { status: number; body: unknown };
  try {
    const res = await send(`${baseUrl}/healthz`, {
      method: "GET",
      // No authorization header: `/healthz` asks for nothing, and a status page that
      // carried a token would be one more place for that token to end up in a log.
      signal: AbortSignal.timeout(deps.timeoutMs ?? HEALTH_TIMEOUT_MS),
      cache: "no-store",
    });

    const declared = Number(res.headers?.get?.("content-length") || "");
    if (Number.isFinite(declared) && declared > MAX_HEALTH_BYTES) {
      return snapshotFromHealth({ status: res.status, body: null }, clock(), slot().lastSuccessAt);
    }

    const text = await res.text();
    if (text.length > MAX_HEALTH_BYTES) {
      return snapshotFromHealth({ status: res.status, body: null }, clock(), slot().lastSuccessAt);
    }

    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // A tunnel that answers in HTML (an error page, an auth wall) says more about the
      // transport than its body would, and a body could carry back the URL that was asked.
      body = null;
    }
    reply = { status: res.status, body };
  } catch {
    // Timeout, refused connection, DNS failure — all the same thing to an operator: nobody
    // learned how the box is doing.
    return snapshotFromHealth({ status: 0, body: null }, clock(), slot().lastSuccessAt);
  }

  const at = clock();
  const snapshot = snapshotFromHealth(reply, at, slot().lastSuccessAt);
  if (snapshot.reachable) {
    // A read that reached the box is a successful read, whether the box says it is healthy
    // or not: that is a separate question the panel answers separately. So this read becomes
    // the latest success rather than merely being one.
    slot().lastSuccessAt = at;
    snapshot.lastSuccessAt = at;
  }
  return snapshot;
}

// --- the admin gate, and the response the panel is given ---

/**
 * The site admin secret, compared the same way `lib/adminAuth.ts` compares it.
 *
 * This is deliberately not a second secret: the proxy control tier is a third admin panel
 * behind the same gate as the other two, so it accepts the same key and nothing else. It
 * reads the header directly rather than the request object because the guard has to be
 * exercisable without a Next request in hand.
 *
 * There is no default. An unset `ADMIN_SECRET_KEY` leaves this panel locked in every
 * environment, which is the intended behaviour for a repository that deploys from a public
 * remote.
 */
export function isProxyAdminSecretValid(presented: string | null | undefined): boolean {
  const expected = (process.env.ADMIN_SECRET_KEY || "").trim();
  if (!expected) return false;
  const raw = (presented || "").trim();
  if (!raw) return false;
  return safeEquals(raw, expected);
}
/**
 * What the server is missing, by name only. `PROXY_BASE_URL` unset means the box is not
 * configured here — which is a different problem from the box being down, and the panel
 * says so instead of guessing.
 */
export function proxyControlConfigProblem(): string | null {
  const missing: string[] = [];
  if (!(process.env.PROXY_BASE_URL || "").trim()) missing.push("PROXY_BASE_URL");
  if (!(process.env.ADMIN_SECRET_KEY || "").trim()) missing.push("ADMIN_SECRET_KEY");
  return missing.length ? missing.join(", ") : null;
}

export interface ProxyControlResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The whole of the status endpoint: the auth decision, and only then the question.
 *
 * The order matters and is the point of this function: an unauthorized call is answered
 * without the box ever being asked, so the panel cannot be used to make the site talk to the
 * box on behalf of somebody who does not have the admin secret.
 */
export async function proxyStatusResponse(
  presentedSecret: string | null | undefined,
  deps: ProxyControlDeps = {}
): Promise<ProxyControlResponse> {
  if (!isProxyAdminSecretValid(presentedSecret)) {
    return {
      status: 401,
      body: { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
    };
  }

  const snapshot = await readProxyBoxSnapshot(deps);
  return { status: 200, body: { success: true, snapshot } };
}

/* ================================================================== *
 * Inspection: the box's read-only surface, read through the same door
 * ================================================================== */

/**
 * The four read-only routes the box publishes. Nothing else is asked for: the box's admin
 * and app surfaces are never read by this tier.
 */
const INSPECT_PATHS = ["status", "providers", "channels", "accounts"] as const;

/**
 * How long the box has to answer an inspection read. The same bound as the health read:
 * these routes read in-process state and never open a provider session.
 */
const INSPECT_TIMEOUT_MS = 5_000;

/**
 * The largest inspection answer that is read. A provider list and a channel list are the
 * biggest bodies here; a cap keeps a misconfigured base URL from turning a panel into a
 * memory sink.
 */
const MAX_INSPECT_BYTES = 256 * 1024;

/**
 * Why the inspection came back empty, in the terms an operator can act on. A dead tunnel,
 * a refused token and a missing read-only surface are three different problems, so the panel
 * must not merge them into one "unavailable".
 */
export type InspectRefusal =
  /** The box did not answer at all. */
  | "unreachable"
  /** The box answered and refused the read-only token. */
  | "unauthorized"
  /** The box answered, but it has no read-only surface mounted. */
  | "not_found"
  /** This server has no read-only token or no address, so nothing was asked. */
  | "not_configured"
  /** The box answered with something this tier cannot use. */
  | "error";

export interface ProxyProviderView {
  providerId: string;
  label: string;
  active: boolean;
  kind: string | null;
  /** The box's own masked host. The credential behind it never leaves the box. */
  server: string;
  usernameHint: string;
  maxConnections: number;
  ownHeaders: boolean;
  channels: string[];
  /** A code, never the box's own text: `undecryptable` or `unreadable`. */
  problem: string | null;
}

export interface ProxyChannelView {
  channelKey: string;
  displayName: string;
  category: string;
  active: boolean;
  providerId: string;
  kind: string | null;
  backupCount: number;
  state: "serving" | "inactive" | "unusable" | null;
  problem: string | null;
}

export interface ProxyAccountView {
  providerId: string;
  label: string;
  channels: string[];
  usernameHint: string;
  server: string;
  maxConnections: number;
  inFlight: number;
  queued: number;
  runs: number;
  failures: number;
  maxInFlight: number;
}

export interface ProxyLaneView {
  /** The provider the lane belongs to. Never the lane key: that is a credential hash. */
  providerId: string;
  holders: string[];
  maxConnections: number;
}

export interface ProxyInspectSnapshot {
  /** The box answered at all. Says nothing about whether it accepted the token. */
  reachable: boolean;
  /** The box's read-only surface accepted the token and answered with its data. */
  authorized: boolean;
  /** Why the inspection is empty, when it is. */
  refusal: InspectRefusal | null;
  checkedAt: number;
  vault: {
    driver: string | null;
    ready: boolean;
    lastRefreshAt: number | null;
    lastRefreshMs: number | null;
    providers: number;
    stored: number;
    resolvable: number;
    unreadable: number;
    /** Only the presence of a fault travels: the text can name a database host. */
    hasError: boolean;
  };
  ownership: {
    mode: "process-local" | "shared-filesystem" | null;
    held: number;
    refusals: number;
  };
  capacity: {
    providerBusy: number;
    maxConcurrentUpstream: number;
    sourcesConfigured: number;
    upstreamRuns: number;
    last: {
      channelKey: string | null;
      code: string | null;
      holders: number;
      maxConnections: number;
      at: number | null;
    } | null;
  };
  providers: ProxyProviderView[];
  channels: ProxyChannelView[];
  accounts: ProxyAccountView[];
  lanes: ProxyLaneView[];
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Free text: trimmed, stripped of control characters, and length-capped. */
function str(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  return value.replace(CONTROL_CHARS, "").trim().slice(0, max);
}

/** A provider id or a channel key: the shape the box itself uses for one. */
function id(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9_-]{1,64}$/i.test(raw) ? raw : null;
}

/** A list of ids, capped, with anything that is not one dropped. */
function idList(value: unknown, max = 200): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const key = id(item);
    if (key) out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * A server address reduced to what an operator can recognise: the scheme and the host.
 *
 * The box already masks its own addresses, so this is the second pass rather than the only
 * one — and the second pass is the one that does not depend on the box being the version
 * that masks correctly. Userinfo, path and query go: an address is the one place on a
 * provider row where a credential can hide.
 */
function safeServer(value: unknown): string {
  const raw = str(value, 300);
  if (!raw) return "";
  const withoutUserinfo = raw.replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)[^/@]*@/i, "$1");
  const withoutQuery = withoutUserinfo.split(/[?#]/)[0] ?? "";
  const scheme = withoutQuery.match(/^(?:[a-z][a-z0-9+.-]*:)?\/\//i)?.[0] ?? "";
  const authority = (withoutQuery.slice(scheme.length).split("/")[0] ?? "").slice(0, 200);
  return `${scheme}${authority}`.slice(0, 200);
}

/**
 * A username reduced to its first two characters. The box sends it that way already; if it
 * ever sent the whole name, this is what keeps the whole name off the page.
 */
function safeHint(value: unknown): string {
  const raw = str(value, 32);
  if (!raw) return "";
  return raw.length > 2 ? `${raw.slice(0, 2)}***` : "***";
}

function kind(value: unknown): string | null {
  return oneOf(value, ["xtream", "hls"] as const);
}

function providerProblem(value: unknown): string | null {
  return oneOf(value, ["undecryptable", "unreadable"] as const);
}

function channelProblem(value: unknown): string | null {
  return oneOf(value, ["provider_disabled", "provider_unusable", "row_unusable", "unusable"] as const);
}

function channelState(value: unknown): "serving" | "inactive" | "unusable" | null {
  return oneOf(value, ["serving", "inactive", "unusable"] as const);
}

function emptyInspection(now: number): ProxyInspectSnapshot {
  return {
    reachable: false,
    authorized: false,
    refusal: "not_configured",
    checkedAt: now,
    vault: {
      driver: null,
      ready: false,
      lastRefreshAt: null,
      lastRefreshMs: null,
      providers: 0,
      stored: 0,
      resolvable: 0,
      unreadable: 0,
      hasError: false,
    },
    ownership: { mode: null, held: 0, refusals: 0 },
    capacity: {
      providerBusy: 0,
      maxConcurrentUpstream: 0,
      sourcesConfigured: 0,
      upstreamRuns: 0,
      last: null,
    },
    providers: [],
    channels: [],
    accounts: [],
    lanes: [],
  };
}

function providerViews(body: unknown): ProxyProviderView[] {
  const list = record(body).providers;
  if (!Array.isArray(list)) return [];
  const out: ProxyProviderView[] = [];
  for (const item of list.slice(0, 200)) {
    const row = record(item);
    const providerId = id(row.providerId);
    if (!providerId) continue;
    out.push({
      providerId,
      label: str(row.label, 80) ?? "",
      active: flag(row.active),
      kind: kind(row.kind),
      server: safeServer(row.server),
      usernameHint: safeHint(row.usernameHint),
      maxConnections: num(row.maxConnections),
      ownHeaders: flag(row.ownHeaders),
      channels: idList(row.channels),
      problem: providerProblem(row.problem),
    });
  }
  return out;
}

function channelViews(body: unknown): ProxyChannelView[] {
  const list = record(body).channels;
  if (!Array.isArray(list)) return [];
  const out: ProxyChannelView[] = [];
  for (const item of list.slice(0, 500)) {
    const row = record(item);
    const channelKey = id(row.channelKey);
    if (!channelKey) continue;
    out.push({
      channelKey,
      displayName: str(row.displayName, 120) ?? "",
      category: str(row.category, 60) ?? "",
      active: flag(row.active),
      providerId: id(row.providerId) ?? "",
      kind: kind(row.kind),
      backupCount: num(row.backupCount),
      state: channelState(row.state),
      problem: channelProblem(row.problem),
    });
  }
  return out;
}

function accountViews(body: unknown): ProxyAccountView[] {
  const list = record(body).accounts;
  if (!Array.isArray(list)) return [];
  const out: ProxyAccountView[] = [];
  for (const item of list.slice(0, 200)) {
    const row = record(item);
    const providerId = id(row.providerId);
    if (!providerId) continue;
    out.push({
      providerId,
      label: str(row.label, 80) ?? "",
      channels: idList(row.channels),
      usernameHint: safeHint(row.usernameHint),
      server: safeServer(row.server),
      maxConnections: num(row.maxConnections),
      inFlight: num(row.inFlight),
      queued: num(row.queued),
      runs: num(row.runs),
      failures: num(row.failures),
      maxInFlight: num(row.maxInFlight),
    });
  }
  return out;
}

function laneViews(body: unknown): ProxyLaneView[] {
  const list = record(body).lanes;
  if (!Array.isArray(list)) return [];
  const out: ProxyLaneView[] = [];
  for (const item of list.slice(0, 200)) {
    const row = record(item);
    const providerId = id(row.providerId);
    if (!providerId) continue;
    out.push({
      providerId,
      holders: idList(row.holders),
      maxConnections: num(row.maxConnections),
    });
  }
  return out;
}

/**
 * Read the box's read-only surface.
 *
 * Never throws: a box that is down, a box that refuses the token and a box with no
 * read-only surface are three readings, not three exceptions. Each answer is projected
 * field by field, so nothing the box says beyond the allow-list can reach a browser — and
 * the fields that could carry a credential (a lane key, a stream id, a raw vault error)
 * are not in the allow-list in the first place.
 */
export async function readProxyInspection(
  deps: ProxyControlDeps = {}
): Promise<ProxyInspectSnapshot> {
  const clock = deps.now ?? Date.now;
  const baseUrl = (deps.baseUrl ?? process.env.PROXY_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = (deps.token ?? process.env.PROXY_READONLY_TOKEN ?? "").trim();
  if (!baseUrl || !token) {
    // Nothing is asked: a server with no read-only token has no reason to talk to the box,
    // and a server with no address has nowhere to talk to.
    return emptyInspection(clock());
  }

  const send = deps.fetchImpl ?? fetch;
  const answers = await Promise.all(
    INSPECT_PATHS.map(async (path) => {
      try {
        const res = await send(`${baseUrl}/readonly/${path}`, {
          method: "GET",
          // The read-only token, in the header the box expects. It never appears in a URL,
          // a query string or an answer.
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(deps.timeoutMs ?? INSPECT_TIMEOUT_MS),
          cache: "no-store",
        });

        const declared = Number(res.headers?.get?.("content-length") || "");
        if (Number.isFinite(declared) && declared > MAX_INSPECT_BYTES) {
          return { path, status: res.status, body: null as unknown };
        }
        const raw = await res.text();
        let body: unknown = null;
        try {
          body = raw.length > MAX_INSPECT_BYTES ? null : JSON.parse(raw);
        } catch {
          body = null;
        }
        return { path, status: res.status, body };
      } catch {
        // Timeout, refused connection, DNS failure — all the same thing to an operator.
        return { path, status: 0, body: null as unknown };
      }
    })
  );

  const statuses = answers.map((answer) => answer.status);
  const refusal: InspectRefusal | null = statuses.every((status) => status === 200)
    ? null
    : statuses.some((status) => status === 401 || status === 403)
      ? // A refusal is definite evidence about the credential, so it outranks a timeout on
        // another route: the operator is told the key is wrong, not that the box is down.
        "unauthorized"
      : statuses.some((status) => status === 0)
        ? "unreachable"
        : statuses.some((status) => status === 404)
          ? "not_found"
          : "error";

  const now = clock();
  const byPath = new Map<string, (typeof answers)[number]>(
    answers.map((answer) => [answer.path, answer])
  );
  const bodyOf = (path: string): unknown => {
    const answer = byPath.get(path);
    return answer && answer.status === 200 ? answer.body : null;
  };

  const statusBody = record(bodyOf("status"));
  const vault = record(statusBody.vault);
  const ownership = record(statusBody.ownership);
  const capacity = record(statusBody.capacity);
  const last = record(capacity.lastProviderBusy);

  const snapshot: ProxyInspectSnapshot = {
    // The box answered even when it refused: reachability is a fact about the transport,
    // not about the credential.
    reachable: refusal !== "unreachable",
    authorized: refusal === null,
    refusal,
    checkedAt: now,
    vault: {
      driver: oneOf(vault.driver, ["memory", "mongo", "none"] as const),
      ready: flag(vault.ready),
      lastRefreshAt:
        typeof vault.lastRefreshAt === "number" && Number.isFinite(vault.lastRefreshAt)
          ? vault.lastRefreshAt
          : null,
      lastRefreshMs:
        typeof vault.lastRefreshMs === "number" && Number.isFinite(vault.lastRefreshMs)
          ? vault.lastRefreshMs
          : null,
      providers: num(vault.providers),
      stored: num(vault.stored),
      resolvable: num(vault.resolvable),
      unreadable: num(vault.unreadable),
      hasError: flag(vault.hasError),
    },
    ownership: {
      mode: oneOf(ownership.mode, ["process-local", "shared-filesystem"] as const),
      held: num(ownership.held),
      refusals: num(ownership.refusals),
    },
    capacity: {
      providerBusy: num(capacity.providerBusy),
      maxConcurrentUpstream: num(capacity.maxConcurrentUpstream),
      sourcesConfigured: num(capacity.sourcesConfigured),
      upstreamRuns: num(capacity.upstreamRuns),
      last:
        Object.keys(last).length > 0
          ? {
              channelKey: handle(last.channelKey),
              code: code(last.code),
              holders: num(last.holders),
              maxConnections: num(last.maxConnections),
              at: typeof last.at === "number" && Number.isFinite(last.at) ? last.at : null,
            }
          : null,
    },
    providers: providerViews(bodyOf("providers")),
    channels: channelViews(bodyOf("channels")),
    accounts: accountViews(bodyOf("accounts")),
    lanes: laneViews(bodyOf("accounts")),
  };

  return snapshot;
}

/**
 * What the inspection is missing, by name only. The read-only token is a different secret
 * from the box's admin token, so a deployment can have a working health panel and no
 * inspection at all — and the panel has to be able to say which of the two it is.
 */
export function proxyInspectionConfigProblem(): string | null {
  const missing: string[] = [];
  if (!(process.env.PROXY_BASE_URL || "").trim()) missing.push("PROXY_BASE_URL");
  if (!(process.env.PROXY_READONLY_TOKEN || "").trim()) missing.push("PROXY_READONLY_TOKEN");
  return missing.length ? missing.join(", ") : null;
}

/**
 * The whole of the inspection endpoint: the auth decision, and only then the question.
 *
 * The order matters and is the point of this function: an unauthorized call is answered
 * without the box ever being asked, so the panel cannot be used to make the site talk to
 * the box on behalf of somebody who does not have the admin secret.
 */
export async function proxyInspectResponse(
  presentedSecret: string | null | undefined,
  deps: ProxyControlDeps = {}
): Promise<ProxyControlResponse> {
  if (!isProxyAdminSecretValid(presentedSecret)) {
    return {
      status: 401,
      body: { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
    };
  }

  const inspection = await readProxyInspection(deps);
  return { status: 200, body: { success: true, inspection } };
}
