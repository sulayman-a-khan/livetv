import { NextRequest, NextResponse } from "next/server";
import { projectFixtures, referencedChannelIds } from "@/lib/fixtureBoard";
import { listDirectChannelsByIds } from "@/lib/fixtureSources";
import { listFixtures, listPremiumBoardChannels } from "@/lib/premiumStore";
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
 * The public projection of the match board: teams, competition, kickoff clock and the channels a
 * card can be watched on, each with the route that opens it or the reason it has none.
 *
 * Source URLs and upstream headers are not in this response, and there is no way to ask for them
 * through it: a choice is an id, a name, a category, a picture and this site's own address.
 *
 * A link whose channel has been deleted is in it as a count, not an id. The board has no name for
 * such a reference and will not print a raw one it cannot check, so the card says that one of its
 * channels is gone and keeps everything it does know — the teams, the competition and the clock.
 *
 * `securedReady` is the only thing it says about the stream box, and it is a boolean:
 * which box, at which address, with how many lanes, is not a visitor's business.
 */
export async function GET(_req: NextRequest) {
  try {
    // Asked alongside the reads rather than before them, so a box that is thinking takes no
    // time off the page: the worst case is the probe's own timeout, not a serial add-on.
    const [fixtures, readiness] = await Promise.all([
      listFixtures(),
      readPremiumReadiness(),
    ]);
    const securedReady = isPremiumReady(readiness);

    // Only the cards that can still appear ask anything of a channel list: a finished or
    // unpublished match has no choice to resolve, so its links cost no read.
    //
    // The two reads that remain are batches, keyed by the distinct ids those cards name — one per
    // tier per board read, whatever the number of cards or links, and neither list is scanned. A
    // card whose link has gone stale therefore costs the same as a card whose link is fine, which
    // is the point: staleness is common, and answering it per reference would be a request
    // amplifier wearing a helpful name.
    const resolvable = fixtures.filter(
      (fixture) => fixture.visible && fixture.phase !== "finished"
    );
    const directIds = referencedChannelIds(resolvable, "direct");
    const securedIds = referencedChannelIds(resolvable, "secured");

    const [securedChannels, directChannels] = await Promise.all([
      listPremiumBoardChannels(securedIds),
      listDirectChannelsByIds(directIds),
    ]);

    const publicFixtures = projectFixtures(
      fixtures,
      securedChannels.map((channel) => ({
        _id: channel._id,
        name: channel.name,
        category: channel.category,
        logoUrl: channel.logoUrl,
        active: channel.active,
        proxyChannelKey: channel.proxyChannelKey,
      })),
      directChannels,
      new Date(),
      securedReady
    );
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
