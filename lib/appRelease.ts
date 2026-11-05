/**
 * The release manifest the app is updated from.
 *
 * One document, published in the app's own repository: it names the build, the
 * file it is in and the fingerprint of that file. The site serves a copy of it
 * so the app has an address for the manifest that is not GitHub, and the
 * repository stays the one place a release is turned on and turned off — the
 * switch is the `versionCode` in the document, and pointing it back at the
 * previous build stops every device from being offered the newer one.
 *
 * The copy the site hands out is the document as published, byte for byte: the
 * app reads fields this site does not model yet, and a document that has been
 * re-serialised here would be a document this site had decided the shape of.
 */

/** Where the manifest is published. */
const DEFAULT_MANIFEST_URL =
  "https://raw.githubusercontent.com/johncarry301/soluplay-app/main/latest.json";

export const MANIFEST_URL = process.env.APP_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL;

/**
 * The last manifest that was read.
 *
 * A fetch that fails must not lose the release: the app would be told there is
 * no update, and a build that was published would be forgotten until the next
 * successful read. The copy is kept in memory for the life of the instance.
 */
export interface ManifestCache {
  current: string | null;
}

/** The cache this instance keeps. */
export const manifestCache: ManifestCache = { current: null };

export type ManifestFetch = typeof fetch;

/**
 * True when a body is a manifest that names a build.
 *
 * A document with no build number in it is not a manifest, whatever else it
 * may be: serving it would tell every device that there is a build to take
 * without saying which one.
 */
export function isUsableManifest(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const versionCode = (parsed as { versionCode?: unknown }).versionCode;
  return typeof versionCode === "number" && Number.isFinite(versionCode) && versionCode > 0;
}

/**
 * The manifest as published, or the last one that was read.
 *
 * Null means there is nothing to say: no release has been published, or the
 * address that publishes them cannot be reached and this instance has never
 * read one. The caller answers that as a failure, and the app falls back to
 * the copy in the app's own repository.
 */
export async function readUpdateManifest(
  fetchImpl: ManifestFetch = fetch,
  cache: ManifestCache = manifestCache
): Promise<string | null> {
  try {
    const response = await fetchImpl(MANIFEST_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`the manifest address answered ${response.status}`);
    }

    const body = await response.text();
    if (!isUsableManifest(body)) {
      throw new Error("the document at that address is not a manifest");
    }

    cache.current = body;
    return body;
  } catch (error) {
    console.warn("The update manifest could not be read:", error);
    return cache.current;
  }
}
