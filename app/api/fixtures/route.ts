import { NextRequest, NextResponse } from "next/server";
import { projectFixtures, referencedChannelIds } from "@/lib/fixtureBoard";
import { listDirectChannelsByIds } from "@/lib/fixtureSources";
import { listFixtures } from "@/lib/fixtureStore";

export const dynamic = "force-dynamic";

/**
 * The board is read by every visitor, so it is cached at the edge for a short window.
 *
 * The board is Direct HLS only, so nothing about a stream box can change an answer in it
 * any more: what is in it is a card, the catalogue channel it names, and whether the
 * catalogue is still showing that channel. A card the admin publishes is a write, and a
 * write is not served from a cache the next visitor can see — an empty board is never
 * cached either, so a newly published match appears on the next read.
 */
const BOARD_CACHE = "public, s-maxage=15";

/**
 * GET /api/fixtures
 * The public projection of the match board: teams, competition, kickoff clock and the channels a
 * card can be watched on, each with the route that opens it or the reason it has none.
 *
 * Source URLs and upstream headers are not in this response, and there is no way to ask for them
 * through it: a choice is an id, a name, a category, a picture and this site's own address.
 *
 * A link whose channel has been deleted is in it as a count, not an id. The board has no name for
 * such a reference and will not print a raw one it cannot check, so the card says that one of its
 * channels is gone and keeps everything it does know — the teams, the competition and the clock.
 */
export async function GET(_req: NextRequest) {
  try {
    const fixtures = await listFixtures();

    // Only the cards that can still appear ask anything of a channel list: a finished or
    // unpublished match has no choice to resolve, so its links cost no read.
    //
    // The read that remains is a batch, keyed by the distinct ids those cards name — one per
    // board read, whatever the number of cards or links, and the list is not scanned. A card
    // whose link has gone stale therefore costs the same as a card whose link is fine, which
    // is the point: staleness is common, and answering it per reference would be a request
    // amplifier wearing a helpful name.
    const resolvable = fixtures.filter(
      (fixture) => fixture.visible && fixture.phase !== "finished"
    );
    const directIds = referencedChannelIds(resolvable, "direct");

    const directChannels = await listDirectChannelsByIds(directIds);

    // The board is Direct HLS only. The secured tier is archived, so it has no channels to
    // resolve and no readiness to measure: a reference to it resolves to nothing and is
    // counted as a link the board cannot open, rather than being offered as a choice.
    const publicFixtures = projectFixtures(
      fixtures,
      [],
      directChannels,
      new Date(),
      false
    );
    return NextResponse.json(
      {
        success: true,
        count: publicFixtures.length,
        fixtures: publicFixtures,
      },
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
