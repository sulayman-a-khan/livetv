import { NextRequest, NextResponse } from "next/server";
import { GET as channelsRoute } from "@/app/api/channels/route";
import { GET as fixturesRoute } from "@/app/api/fixtures/route";

export const dynamic = "force-dynamic";

/**
 * The catalogue and the board in one answer.
 *
 * The app used to ask for the two separately on every launch, and every
 * launch was therefore two round trips and two chances to be half right: a
 * guide from one read and a board from another, taken minutes apart. This
 * route asks the same two routes on the server and hands the app one body,
 * so the guide and the board on the screen are the same pair of answers.
 *
 * The two existing routes are the ones that are read here, unchanged: the
 * app's bootstrap is a different way of asking, not a different catalogue.
 */
const BOOTSTRAP_CACHE = "public, s-maxage=30, stale-while-revalidate=120";

/** The two answers, as they come back from the routes they are read from. */
type CatalogueAnswer = { success?: boolean; count?: number; channels?: unknown[] };
type BoardAnswer = { success?: boolean; count?: number; fixtures?: unknown[] };

/**
 * GET /api/app/bootstrap
 * The guide, the board and the count of each, in one body.
 *
 * The shape is the one both readers already understand: `channels` is what
 * `/api/channels` publishes and `fixtures` is what `/api/fixtures` publishes,
 * so the same body can be read as a catalogue and as a board. A board that
 * could not be read is an empty board rather than a failed bootstrap — the
 * board is empty most of the time, and a guide without a board is still a
 * guide.
 */
export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin;

  try {
    const catalogueResponse = await channelsRoute(new NextRequest(`${origin}/api/channels`));
    if (!catalogueResponse.ok) {
      return NextResponse.json(
        { success: false, error: "The catalogue could not be read." },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
    const catalogue = (await catalogueResponse.json()) as CatalogueAnswer;
    const channels = Array.isArray(catalogue?.channels) ? catalogue.channels : [];

    const boardResponse = await fixturesRoute(new NextRequest(`${origin}/api/fixtures`));
    const board = boardResponse.ok
      ? ((await boardResponse.json()) as BoardAnswer)
      : { success: false, count: 0, fixtures: [] };
    const fixtures = Array.isArray(board?.fixtures) ? board.fixtures : [];
    // A board that could not be read is said so, so the app keeps the board it
    // saved earlier instead of treating this empty board as today's.
    const fixturesAvailable = boardResponse.ok && board?.success === true;

    return NextResponse.json(
      {
        success: true,
        count: channels.length,
        channels,
        fixtures,
        fixturesAvailable,
        updatedAt: new Date().toISOString(),
      },
      {
        status: 200,
        headers: {
          "Cache-Control": channels.length > 0 ? BOOTSTRAP_CACHE : "no-store",
        },
      }
    );
  } catch (error: any) {
    console.error("GET /api/app/bootstrap error:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "Failed to load the app bootstrap" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
