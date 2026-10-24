import { NextRequest, NextResponse } from "next/server";
import { projectFixtures } from "@/lib/fixtureBoard";
import { listFixtures, listPremiumChannels } from "@/lib/premiumStore";

export const dynamic = "force-dynamic";

/**
 * The board is read by every visitor, so it is cached at the edge for a minute.
 * A fixture is published or switched off well ahead of kickoff, so an hour of
 * staleness would be harmless anyway; an empty board is never cached, so a card
 * the admin just published appears on the next visit.
 */
const BOARD_CACHE = "public, s-maxage=60, stale-while-revalidate=300";

/**
 * GET /api/fixtures
 * The public projection of the match board: teams, competition, kickoff clock and
 * the premium channel a card names. Source URLs and upstream headers are not in
 * this response, and there is no way to ask for them through it.
 */
export async function GET(_req: NextRequest) {
  try {
    const [fixtures, channels] = await Promise.all([listFixtures(), listPremiumChannels()]);
    const publicFixtures = projectFixtures(fixtures, channels, new Date());
    return NextResponse.json(
      { success: true, count: publicFixtures.length, fixtures: publicFixtures },
      {
        status: 200,
        headers: {
          "Cache-Control": publicFixtures.length > 0 ? BOARD_CACHE : "no-store",
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
