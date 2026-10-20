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
 * This is a hostname-literal + scheme guard, not a DNS-resolving one: it blocks
 * the obvious private/loopback/link-local/metadata literals and any non-http(s)
 * scheme, and deliberately allows every public hostname (the catalogue is all
 * public http/https origins). A public-looking hostname that resolves to an
 * internal address (DNS rebinding) is out of scope here by design — closing that
 * needs a resolve-and-recheck pass, which was declined to keep the fetch path
 * simple. Callers decide how to surface a rejection (probe returns a verdict,
 * ingest/sync report a source error).
 */

export interface UrlSafetyVerdict {
  ok: boolean;
  /** The trimmed absolute URL when `ok`, for callers that want the parsed form. */
  url?: string;
  /** Human-readable reason when `ok === false`. Safe to show an admin. */
  reason?: string;
}

/**
 * True for a host literal that names this machine, a private network, or the
 * link-local/metadata range. Handles IPv4, IPv6 (including bracketed and
 * IPv4-mapped forms) and the `localhost` name. Public hostnames return false.
 */
export function isPrivateOrInternalHost(rawHost: string): boolean {
  let host = (rawHost || "").trim().toLowerCase();

  // IPv6 arrives bracketed from `new URL(...).hostname` — strip the brackets.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // IPv6 loopback / unspecified.
  if (host === "::" || host === "::1") return true;

  // IPv4-mapped IPv6. Node normalises `::ffff:127.0.0.1` to `::ffff:7f00:1`, so
  // match the prefix rather than the dotted form and treat the whole range as
  // internal: no legitimate public origin is ever addressed as an IPv4-mapped
  // IPv6 literal in this catalogue, and fetch() would dial the embedded IPv4.
  if (host.startsWith("::ffff:")) return true;

  // IPv6 unique-local (fc00::/7 → fc../fd..) and link-local (fe80::/10 → fe8..feb..).
  if (/^f[cd]/.test(host)) return true;
  if (/^fe[89ab]/.test(host)) return true;

  // IPv4 dotted quad.
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    return (
      a === 127 || // loopback
      a === 10 || // private
      a === 0 || // "this" network
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      a === 169 // link-local, incl. the 169.254.169.254 metadata endpoint
    );
  }

  return false;
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
