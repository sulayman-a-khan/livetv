import { NextResponse } from "next/server";
import { listPremiumChannels } from "@/lib/premiumStore";

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
 */
export async function GET() {
  try {
    const rows = await listPremiumChannels();
    const channels = rows
      .filter((row) => row.active && row.proxyChannelKey)
      .map((row) => ({
        id: row._id,
        name: row.name,
        logoUrl: row.logoUrl,
        category: row.category,
      }));

    return NextResponse.json(
      { success: true, count: channels.length, channels },
      { status: 200, headers: { "Cache-Control": "public, s-maxage=15" } }
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
