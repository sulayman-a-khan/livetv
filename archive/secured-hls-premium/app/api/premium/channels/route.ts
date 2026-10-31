import { NextResponse } from "next/server";
import { listPremiumChannels } from "@/lib/premiumStore";
import { isPremiumReady, readPremiumReadiness } from "@/lib/premiumReadiness";

export const dynamic = "force-dynamic";

/**
 * GET /api/premium/channels
 *
 * The premium tier's public list: the channels the admin has switched on, with the picture and
 * the name a viewer needs to recognise one, and nothing else. There is no source line, no handle
 * and no note in this response — a tile opens `/premium/<id>`, and that page asks the box for a
 * signed playlist when the viewer presses play.
 *
 * A row with no handle on the box is left out: it could never open, so a tile for it would be a
 * dead end with a picture on it.
 *
 * And a box that cannot answer empties the list entirely. Every one of these channels plays
 * through that box, so a tile shown while it is down is a promise the page cannot keep — the
 * strip disappears instead, the way the match board keeps a card but drops its link.
 */
export async function GET() {
  try {
    const [rows, readiness] = await Promise.all([
      listPremiumChannels(),
      readPremiumReadiness(),
    ]);
    const ready = isPremiumReady(readiness);

    const channels = ready
      ? rows
          .filter((row) => row.active && row.proxyChannelKey)
          .map((row) => ({
            id: row._id,
            name: row.name,
            logoUrl: row.logoUrl,
            category: row.category,
          }))
      : [];

    return NextResponse.json(
      { success: true, count: channels.length, channels },
      {
        status: 200,
        // A box that is down empties the list, and an empty list must not be cached: the strip
        // has to come back the moment the box answers again.
        headers: { "Cache-Control": ready ? "public, s-maxage=15" : "no-store" },
      }
    );
  } catch (error: any) {
    console.error("GET /api/premium/channels error:", error);
    // A list that could not be read is not an empty list: the homepage shows no premium row
    // rather than a row that leads nowhere.
    return NextResponse.json(
      { success: false, error: error?.message || "Failed to load the premium channels" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
