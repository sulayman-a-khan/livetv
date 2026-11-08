/**
 * The origin a viewer's browser actually uses.
 *
 * A Vercel deployment has two addresses: the `*.vercel.app` host the platform
 * names in `VERCEL_PROJECT_PRODUCTION_URL`, and the custom domain visitors
 * type. They are different origins, and a CDN's CORS answer is written for the
 * one the browser sent. `SITE_ORIGIN` names the public origin explicitly and
 * therefore wins; the Vercel host is the fallback so a deployment without a
 * custom domain still probes correctly.
 *
 * A value that is set but not a usable http(s) origin is refused rather than
 * replaced: sending a guessed Origin would measure a CORS answer no viewer
 * receives. With nothing configured (local development) the answer is null and
 * the caller keeps its CORS verdict unknown instead of guessing.
 */
export function resolveSiteOrigin(
  env: Record<string, string | undefined> = process.env
): string | null {
  const configured = (env.SITE_ORIGIN || "").trim();
  if (configured) return normaliseOrigin(configured);
  return (
    normaliseOrigin(env.VERCEL_PROJECT_PRODUCTION_URL) ??
    normaliseOrigin(env.VERCEL_URL)
  );
}

/**
 * A bare `origin` for an HTTP(S) address, or null.
 *
 * Hosts without a scheme are read as HTTPS — every deployment origin here is
 * secure. Paths, queries and fragments are dropped, host case is normalised by
 * the URL parser, and credentials are refused: an Origin header cannot carry
 * them.
 */
export function normaliseOrigin(value: string | null | undefined): string | null {
  const raw = (value || "").trim();
  if (!raw) return null;
  // The two non-origin CORS answers: `*` is a wildcard and `null` is what a
  // sandboxed document sends. Neither names this site.
  if (raw === "*" || raw.toLowerCase() === "null") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withScheme);
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}