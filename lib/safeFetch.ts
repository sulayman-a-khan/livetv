/**
 * The half of the request-forgery guard that needs the network.
 *
 * `lib/ssrfGuard.ts` decides whether a URL *looks* safe: http(s) scheme, and a
 * host that is not a private/loopback/link-local literal. That is not enough
 * once a request is actually made, because:
 *
 *   - a public hostname can resolve to 127.0.0.1 or 169.254.169.254;
 *   - a safe URL can redirect to an unsafe one, and `fetch` follows redirects
 *     on its own — the guard would only ever see the first hop;
 *   - a playlist can point its variant and segment URLs anywhere at all, and
 *     the probe fetches those too.
 *
 * So every server-side request for an admin-supplied URL goes through
 * `safeFetch`: it resolves the hostname, refuses a destination inside this
 * machine's own network, and follows redirects by hand so that every hop is
 * checked the same way the first one was.
 *
 * The gap left over is a name that resolves differently between the check and
 * the connection (DNS rebinding). Closing it needs the connection pinned to the
 * address that was checked, which the global fetch() cannot do — that would
 * take a custom undici dispatcher. The window is milliseconds wide, and the
 * common shape of the attack — a public name pointing straight at the metadata
 * endpoint — is blocked outright.
 */

import { lookup } from "node:dns/promises";
import {
  checkPublicUrlSafety,
  checkRedirectTarget,
  isIpLiteral,
  isPrivateOrInternalAddress,
} from "./ssrfGuard";

/** A URL the server refuses to fetch: an internal destination, or a redirect into one. */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** A redirect chain longer than the guard is willing to walk. */
export class RedirectLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedirectLimitError";
  }
}

/** Looks up the addresses a hostname resolves to. */
export type HostResolver = (hostname: string) => Promise<string[]>;

/** The OS resolver — the same answers `fetch` itself will get. */
export const systemHostResolver: HostResolver = async (hostname) => {
  const entries = await lookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => entry.address);
};

export interface HostVerdict {
  ok: boolean;
  reason?: string;
  addresses?: string[];
}

/**
 * Judges the destination a hostname actually points at.
 *
 * A name that does not resolve here is let through: the request itself will
 * fail the same way, with the same retry behaviour the health checker has
 * always had, and turning that into a hard refusal here would change how
 * transient DNS trouble is reported.
 */
export async function checkHostResolvesPublic(
  hostname: string,
  resolver: HostResolver = systemHostResolver
): Promise<HostVerdict> {
  if (!hostname) return { ok: false, reason: "URL names no host" };
  if (isIpLiteral(hostname)) return { ok: true, addresses: [hostname] };

  let addresses: string[];
  try {
    addresses = await resolver(hostname);
  } catch {
    return { ok: true, addresses: [] };
  }

  const internal = addresses.filter((address) => isPrivateOrInternalAddress(address));
  if (internal.length > 0) {
    return {
      ok: false,
      reason: `The host ${hostname} resolves to a private, loopback or link-local address (${internal[0]}), which the server will not fetch`,
    };
  }

  return { ok: true, addresses };
}

/**
 * Checks one URL the way `safeFetch` checks every URL it is asked to fetch,
 * and returns the normalised form to request.
 */
export async function assertSafeToFetch(
  rawUrl: string,
  resolver: HostResolver = systemHostResolver
): Promise<string> {
  const literal = checkPublicUrlSafety(rawUrl);
  if (!literal.ok) {
    throw new UnsafeUrlError(literal.reason || "This URL is not safe for the server to fetch");
  }

  const parsed = new URL(literal.url as string);
  const host = await checkHostResolvesPublic(parsed.hostname, resolver);
  if (!host.ok) {
    throw new UnsafeUrlError(host.reason || "This URL is not safe for the server to fetch");
  }

  return literal.url as string;
}

export interface SafeFetchOptions {
  /** How many redirects to walk before giving up. */
  maxRedirects?: number;
  /** Overrides the resolver (tests). */
  resolver?: HostResolver;
  /** Overrides the transport (tests). */
  fetchImpl?: typeof fetch;
}

/** Enough for the CDNs and playlist hosts in use; a longer chain is a loop. */
export const DEFAULT_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Headers a redirect must not carry to another origin. `fetch` drops these
 * itself when it follows a cross-origin redirect; following the redirect by
 * hand has to drop them too, or a stored credential would travel to a host
 * the admin never named.
 */
const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * `fetch` with every hop checked.
 *
 * The redirect is followed by hand rather than by `fetch` itself, because the
 * guard has to see each hop: a checked first URL followed by an unchecked
 * redirect is exactly the bypass this closes. The final response is the one
 * the caller asked for, with `response.url` naming the URL it came from, so
 * callers that report a final URL keep reporting the same one.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {}
): Promise<Response> {
  const doFetch = options.fetchImpl || fetch;
  const resolver = options.resolver || systemHostResolver;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current = rawUrl;
  let method = (init.method || "GET").toUpperCase();
  let body = init.body ?? undefined;
  const headers = new Headers(init.headers);

  for (let hop = 0; ; hop += 1) {
    const target = await assertSafeToFetch(current, resolver);

    const response = await doFetch(target, {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
    });

    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;

    if (hop >= maxRedirects) {
      await response.body?.cancel().catch(() => {});
      throw new RedirectLimitError(`The URL redirected more than ${maxRedirects} times`);
    }

    const next = checkRedirectTarget(target, location);
    await response.body?.cancel().catch(() => {});
    if (!next.ok) {
      throw new UnsafeUrlError(next.reason || "The URL redirects to a host the server will not fetch");
    }

    // 301/302/303 turn a POST into a GET, exactly as a browser would; 307/308
    // keep the method and the body.
    const becomesGet =
      (response.status === 303 && method !== "GET" && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && method === "POST");
    if (becomesGet) {
      method = "GET";
      body = undefined;
    }

    // A redirect to another origin does not get the credentials of this one.
    if (new URL(target).origin !== new URL(next.url as string).origin) {
      for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) headers.delete(name);
    }

    current = next.url as string;
  }
}
