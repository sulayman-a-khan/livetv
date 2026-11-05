import { NextResponse } from "next/server";
import { readUpdateManifest } from "@/lib/appRelease";

export const dynamic = "force-dynamic";

/**
 * The manifest is read by every device that opens the app, and it changes
 * only when a release is published, so it is cached at the edge for a minute.
 * A stale minute is harmless: a release that was just published reaches the
 * next device a minute later, and a release that was withdrawn reaches no
 * device at all, because the withdrawn document is the one that is published.
 */
const MANIFEST_CACHE = "public, s-maxage=60, stale-while-revalidate=300";

/**
 * GET /api/app/version
 * The update manifest, exactly as the app's repository publishes it.
 *
 * The document is the manifest itself and not an envelope around it: the app
 * reads the fields it knows and ignores the ones it does not, and a wrapper
 * would have to be unwrapped by every reader. A manifest that cannot be read
 * is answered as a failure and uncached, so the app falls back to the copy in
 * its own repository instead of being told there is no release.
 */
export async function GET() {
  const manifest = await readUpdateManifest();

  if (!manifest) {
    return NextResponse.json(
      { success: false, error: "The update manifest could not be read." },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  return new NextResponse(manifest, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": MANIFEST_CACHE,
    },
  });
}
