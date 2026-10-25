import { NextRequest, NextResponse } from "next/server";
import { projectFixtures } from "@/lib/fixtureBoard";
import { listFixtures, listPremiumChannels } from "@/lib/premiumStore";
import { isPremiumReady, readPremiumReadiness } from "@/lib/premiumReadiness";

export const dynamic = "force-dynamic";

/**
 * The board is read by every visitor, so it is cached at the edge — but only for as long as
 * the readiness verdict inside it is trustworthy. The answer this response carries about the
 * stream box is good for fifteen seconds (`FRESH_MS` in `lib/premiumReadiness.ts`), so the
 * response is too: a card must not stay linked into an outage because a CDN liked it. An
 * uncached board is what a not-ready verdict gets, so the moment the box is back the next
 * read knows about it, and an empty board is never cached either.
 */
const READY_CACHE = "public, s-maxage=15";

/**
 * GET /api/fixtures
 * The public projection of the match board: teams, competition, kickoff clock and
 * the premium channel a card names. Source URLs and upstream headers are not in
 * this response, and there is no way to ask for them through it.
 *
 * `securedReady` is the only thing it says about the stream box, and it is a boolean:
 * which box, at which address, with how many lanes, is not a visitor's business.
 */
export async function GET(_req: NextRequest) {
  try {
    // Asked alongside the reads rather than before them, so a box that is thinking takes no
    // time off the page: the worst case is the probe's own timeout, not a serial add-on.
    const [fixtures, channels, readiness] = await Promise.all([
      listFixtures(),
      listPremiumChannels(),
      readPremiumReadiness(),
    ]);
    const securedReady = isPremiumReady(readiness);
    const publicFixtures = projectFixtures(fixtures, channels, new Date(), securedReady);
    return NextResponse.json(
      {
        success: true,
        count: publicFixtures.length,
        securedReady,
        fixtures: publicFixtures,
      },
      {
        status: 200,
        headers: {
          "Cache-Control":
            securedReady && publicFixtures.length > 0 ? READY_CACHE : "no-store",
        },
      }
    );
  } catch (error: any) {
    console.error("GET /api/fixtures error:", error);
    // Failure is not emptiness: the homepage keeps its promo banner only when it
    // knows the board was read, so this answers as an error and stays uncached.
    return NextResponse.json(
      { success: false, error: error?.message || "Failed to load the match board" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
