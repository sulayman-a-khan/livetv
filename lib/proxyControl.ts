/**
 * The 24/7 proxy control tier's only door to the stream box.
 *
 * What this module is allowed to read, and why that is all it reads:
 *
 *   - The one upstream route it touches is `GET /healthz`. That route asks for no token,
 *     reads in-process state only, performs no upstream fetch, opens no provider session
 *     and cannot consume a provider's connection limit — so asking it cannot disturb a
 *     stream somebody is already watching.
 *   - It carries **no credential of any kind**. The box's `/admin/*` surface is guarded by
 *     a single bearer token that also authorises writes, and the proxy offers no
 *     read-only token to hand out, so this tier does not read `/admin/*` at all. A status
 *     page is not worth putting a vault-admin credential on the site for.
 *   - It projects the answer into a fixed shape. The box's body is never passed through, so
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
