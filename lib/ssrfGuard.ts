/**
 * Server-side request-forgery guard for admin-supplied URLs.
 *
 * Three places fetch a URL that an admin typed in or stored: the M3U ingest
 * (`m3uUrl`), the playlist-source sync, and the stream probe. All are gated
 * behind the admin secret, but this project deploys from a public repository
 * with a single shared key, so a leaked key would otherwise let the server be
 * pointed at its own network — the cloud metadata endpoint (169.254.169.254),
 * localhost services, or internal hosts — and read whatever answers back.
 *
 * This module is the pure half of that guard: it classifies a host (an IP
 * literal or a DNS name) and validates a URL's scheme and literal host without
 * touching the network. `lib/safeFetch.ts` is the half that needs I/O — it
 * resolves the hostname, refuses a destination inside the server's own network
 * and re-checks every redirect hop on the way.
 *
 * A DNS name is judged by resolving it, not by guessing from its spelling, so
 * the range tests below apply to IP literals only: applied to a hostname they
 * would reject innocent public origins whose name merely starts with "fc".
 */

export interface UrlSafetyVerdict {
  ok: boolean;
  /** The trimmed absolute URL when `ok`, for callers that want the parsed form. */
  url?: string;
  /** Human-readable reason when `ok === false`. Safe to show an admin. */
  reason?: string;
}

/**
 * True when the host is an IP literal — an IPv4 dotted quad or an IPv6 address,
 * with or without the brackets `new URL(...).hostname` puts around the latter
 * and with any zone index (`%eth0`) dropped.
 */
export function isIpLiteral(rawHost: string): boolean {
  let host = (rawHost || "").trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);

  const quads = host.split(".");
  if (quads.length === 4 && quads.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return true;
  }
  return host.includes(":") && /^[0-9a-f:.]+$/.test(host);
}

/**
 * True for an address inside this machine's own network: loopback, the private
 * ranges, link-local (which is where the cloud metadata endpoint lives), the
 * carrier-grade NAT range, the addresses that are never routable at all
 * (multicast, reserved, documentation, NAT64) and the IPv6 equivalents.
 * A public address returns false.
 *
 * This is the same classification `isPrivateOrInternalHost` applies to a host
 * literal, kept separate so it can also judge an address that came back from a
 * DNS lookup.
 */
export function isPrivateOrInternalAddress(rawAddress: string): boolean {
  let addr = (rawAddress || "").trim().toLowerCase();
  if (!addr) return false;
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);

  // IPv4 dotted quad.
  const quads = addr.split(".");
  if (quads.length === 4 && quads.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const [a, b, c] = quads.map(Number);
    return (
      a === 127 || // loopback
      a === 10 || // private
      a === 0 || // "this" network
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      a === 169 || // link-local, incl. the 169.254.169.254 metadata endpoint
      (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
      (a === 192 && b === 0 && c === 2) || // documentation
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      (a === 198 && b === 51 && c === 100) || // documentation
      (a === 203 && b === 0 && c === 113) || // documentation
      (a >= 224 && a <= 239) || // multicast
      a >= 240 // reserved, incl. the broadcast address
    );
  }

  // Not an IPv6 literal either — some other kind of name.
  if (!addr.includes(":") || !/^[0-9a-f:.]+$/.test(addr)) return false;

  // IPv6 loopback / unspecified.
  if (addr === "::" || addr === "::1") return true;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d). Node normalises
  // `::ffff:127.0.0.1` to `::ffff:7f00:1`, so match the prefix rather than the
  // dotted form and treat the whole range as internal: no legitimate public origin
  // is ever addressed as an IPv4-mapped IPv6 literal in this catalogue, and
  // fetch() would dial the embedded IPv4.
  if (addr.startsWith("::")) return true;

  // IPv6 unique-local (fc00::/7 → fc.., fd..) and link-local (fe80::/10 → fe8..–feb..).
  if (/^f[cd]/.test(addr)) return true;
  if (/^fe[89ab]/.test(addr)) return true;

  // The ranges that are never a legitimate destination: multicast (ff00::/8), the
  // documentation range (2001:db8::/32) and the NAT64 prefixes (64:ff9b::/96 and
  // 64:ff9b:1::/48), which reach an IPv4 address the guard cannot see.
  if (/^ff/.test(addr)) return true;
  if (addr.startsWith("2001:db8")) return true;
  if (addr.startsWith("64:ff9b")) return true;

  return false;
}

/**
 * True for a host literal that names this machine, a private network, or the
 * link-local/metadata range. Handles IPv4, IPv6 (including bracketed and
 * IPv4-mapped forms) and the `localhost` name. Public hostnames — and public
 * IP literals — return false; whether a public name resolves to an internal
 * address is decided by resolving it, which `lib/safeFetch.ts` does.
 */
export function isPrivateOrInternalHost(rawHost: string): boolean {
  let host = (rawHost || "").trim().toLowerCase();
  if (!host) return false;

  // IPv6 arrives bracketed from `new URL(...).hostname` — strip the brackets.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  if (host === "localhost" || host.endsWith(".localhost")) return true;

  if (!isIpLiteral(host)) return false;
  return isPrivateOrInternalAddress(host);
}

/**
 * Validates a URL the server is about to fetch. Returns `{ ok: true, url }` for
 * a public http(s) URL, or `{ ok: false, reason }` for anything disallowed. It
 * never throws and never performs I/O — it is a pure check on the URL text.
 */
export function checkPublicUrlSafety(rawUrl: string): UrlSafetyVerdict {
  // Coerce defensively: a malformed request body could hand us a non-string,
  // and a guard that throws on bad input is a guard that can be skipped.
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) return { ok: false, reason: "URL is empty" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "URL is not a valid absolute URL" };
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return {
      ok: false,
      reason: `URL uses a disallowed scheme (${parsed.protocol}); only http and https may be fetched`,
    };
  }

  if (isPrivateOrInternalHost(parsed.hostname)) {
    return {
      ok: false,
      reason: "URL points at a private, loopback or link-local host, which the server will not fetch",
    };
  }

  return { ok: true, url: parsed.toString() };
}

/**
 * Validates one redirect hop: the `Location` header resolved against the URL
 * that produced it, checked for scheme and literal host exactly like a
 * first-hop URL. Pure — it resolves no name and performs no I/O; the resolved
 * hostname is judged by `lib/safeFetch.ts`.
 */
export function checkRedirectTarget(currentUrl: string, location: string): UrlSafetyVerdict {
  let resolved: string;
  try {
    resolved = new URL(location, currentUrl).toString();
  } catch {
    return { ok: false, reason: "Redirect target is not a valid URL" };
  }

  const verdict = checkPublicUrlSafety(resolved);
  if (!verdict.ok) return verdict;
  return { ok: true, url: verdict.url };
}
