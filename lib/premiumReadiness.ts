/**
 * Is the stream box able to serve a premium stream *right now*?
 *
 * The question this module exists to answer honestly. A row being `active`, having a
 * `proxyChannelKey`, or having `PROXY_BASE_URL` set in the environment all mean that
 * somebody intended a stream; none of them means a viewer would get one. Readiness is
 * therefore taken from the box itself, on a request that costs it nothing:
 *
 * `GET /healthz` is the box's own liveness answer. It is unauthenticated, it reads
 * in-process state only, and it performs no upstream fetch — so asking it cannot open a
 * provider session, cannot consume a provider's connection limit, and cannot slow a
 * stream that is already playing for somebody else.
 *
 * What a caller gets back is a verdict of `ready`, `unavailable` or `unknown`, plus the
 * moment it was learned and a count of lanes the box says it can resolve. Never a host,
 * a path, a token or the box's own error text: this answer is put in a homepage payload,
 * so it is scrubbed at the source rather than at the boundary.
 *
 * The two failure modes are kept apart on purpose, because they deserve different trust:
 * `unavailable` is the box answering and saying it cannot serve, which is information;
 * `unknown` is the box not answering at all — a timeout, a tunnel error page, no
 * configured address — which is the absence of information, and is treated as not ready.
 * A viewer is never handed a link that depends on optimism.
 */

export type ReadinessState = "ready" | "unavailable" | "unknown";

export interface ReadinessVerdict {
  state: ReadinessState;
  /** This server's clock, at the moment the answer was learned. */
  checkedAt: number;
  /** How many channels the box says it can resolve. A count: never a name or address. */
  lanesOnBox: number;
}

/**
 * How the box is asked. Two seconds is enough for a loopback or tunnel answer on a route
 * that does no work, and short enough that a dead box cannot hold a homepage open.
 */
const PROBE_TIMEOUT_MS = 2_000;

/** Inside this window the last answer is used as-is, so a homepage read asks nothing. */
const FRESH_MS = 15_000;

/**
 * How long an answer from *before* a failed probe is still trusted. Beyond it a failed
 * probe means the state of the box is genuinely unknown, and the surface fails closed.
 */
const MAX_USEFUL_AGE_MS = 45_000;

export interface ReadinessProbeDeps {
  /** Defaults to `PROXY_BASE_URL`, so a route never has to pass the operator's address. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The whole decision, with no network in it, so it can be argued with in a test.
 *
 * Ready requires all of: the box answering 200 with its own health body, its registry
 * reporting no "not yet ready" flag, its signing API being mounted (a channel that cannot
 * be signed cannot be watched, whatever the vault says), and at least one resolvable lane
 * — which is the "with eligible channels" half of the requirement, measured on the box.
 */
export function verdictFromHealth(
  reply: { status: number; body: unknown },
  now: number
): ReadinessVerdict {
  if (reply.status !== 200 || typeof reply.body !== "object" || reply.body === null) {
    // A tunnel error page or an unexpected status says something about the transport, not
    // about the box's opinion of itself: that is a missing answer, not a negative one.
    return { state: "unknown", checkedAt: now, lanesOnBox: 0 };
  }

  const body = reply.body as Record<string, unknown>;
  if (body.ok !== true) return { state: "unknown", checkedAt: now, lanesOnBox: 0 };

  const vault = typeof body.vault === "object" && body.vault !== null
    ? (body.vault as Record<string, unknown>)
    : {};
  const lanesOnBox = numberOr(vault.resolvable, 0);

  // A vault that has not completed its first refresh, or that reports nothing it can open,
  // is the box telling us it cannot serve. So is a box with no signing API mounted.
  if (vault.ready === false || body.appApi === false || lanesOnBox <= 0) {
    return { state: "unavailable", checkedAt: now, lanesOnBox: Math.max(0, lanesOnBox) };
  }

  return { state: "ready", checkedAt: now, lanesOnBox };
}

/**
 * Ask the box once. Never throws: an unreachable box is the `unknown` verdict, which is
 * what every caller needs anyway, and a route that treats a question as an error would
 * turn a database-style outage into a 500 page.
 */
export async function probePremiumReadiness(
  deps: ReadinessProbeDeps = {}
): Promise<ReadinessVerdict> {
  const clock = deps.now ?? Date.now;
  const now = clock();
  const baseUrl = (deps.baseUrl ?? process.env.PROXY_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) return { state: "unknown", checkedAt: now, lanesOnBox: 0 };

  const send = deps.fetchImpl ?? fetch;
  try {
    const res = await send(`${baseUrl}/healthz`, {
      method: "GET",
      // No authorization header: `/healthz` asks for nothing, and a readiness probe that
      // carried a token would be one more place for that token to end up in a log.
      signal: AbortSignal.timeout(deps.timeoutMs ?? PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return verdictFromHealth({ status: res.status, body }, clock());
  } catch {
    // Timeout, refused connection, DNS failure — all the same thing to a viewer: nobody
    // learned whether the box can serve, so nothing may be promised.
    return { state: "unknown", checkedAt: clock(), lanesOnBox: 0 };
  }
}

interface ReadinessSlot {
  verdict: ReadinessVerdict | null;
  /** When the last probe finished, successful or not — what bounds the asking. */
  lastProbeAt: number;
  inflight: Promise<ReadinessVerdict> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __soluplay_premium_readiness: ReadinessSlot | undefined;
}

function slot(): ReadinessSlot {
  globalThis.__soluplay_premium_readiness ??= { verdict: null, lastProbeAt: 0, inflight: null };
  return globalThis.__soluplay_premium_readiness;
}

/**
 * A change in state is the one thing worth a log line: a box that is steadily down should
 * not repeat itself on every request, and an operator reading a log wants the transition.
 * Counts only, never the address that was asked or the box's own error text.
 */
function noteTransition(previous: ReadinessVerdict | null, next: ReadinessVerdict): void {
  if (previous && previous.state === next.state) return;
  console.warn(
    `[premiumReadiness] ${previous ? previous.state : "unasked"} -> ${next.state}, ${next.lanesOnBox} lane(s) resolvable on the box`
  );
}

/**
 * The verdict a page should act on.
 *
 * Fresh answers are reused for `FRESH_MS`, and concurrent readers share one probe, so the
 * box is asked at most once per window per process no matter how many viewers arrive. When
 * a probe cannot be trusted, the answer the box last *actually gave* is still used until it
 * reaches `MAX_USEFUL_AGE_MS` — a tunnel blip should not put a working rail off air — and
 * past that age a surface that has not heard from the box recently is treated as not ready.
 * An answer of `unavailable` is a real reading and replaces the old one immediately, so a
 * box that says it is down is hidden at once and restored only when it says otherwise.
 */
export async function readPremiumReadiness(
  deps: ReadinessProbeDeps = {}
): Promise<ReadinessVerdict> {
  const state = slot();
  const now = (deps.now ?? Date.now)();
  const current = state.verdict;
  const trusted = current && current.state !== "unknown" ? current : null;

  if (current && now - state.lastProbeAt < FRESH_MS) return current;

  if (!state.inflight) {
    state.inflight = probePremiumReadiness(deps).then((verdict) => {
      state.lastProbeAt = verdict.checkedAt;
      const tooOldToKeep = !trusted || now - trusted.checkedAt >= MAX_USEFUL_AGE_MS;
      if (verdict.state !== "unknown" || tooOldToKeep) {
        noteTransition(state.verdict, verdict);
        state.verdict = verdict;
      }
      state.inflight = null;
      return verdict;
    });
  }
  const fresh = await state.inflight;

  if (fresh.state !== "unknown") return fresh;
  if (trusted && now - trusted.checkedAt < MAX_USEFUL_AGE_MS) return trusted;
  return fresh;
}

/** The one question every gated surface asks. Anything that is not a yes is a no. */
export function isPremiumReady(verdict: ReadinessVerdict): boolean {
  return verdict.state === "ready";
}
