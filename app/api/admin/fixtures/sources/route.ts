import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import { connectToDatabase } from "@/lib/db";
import { listDirectChannelOptions } from "@/lib/fixtureSources";
import { listPremiumChannels } from "@/lib/premiumStore";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/fixtures/sources
 * Every channel a match may be linked to, from both tiers, in the one call the fixture editor
 * makes when it opens.
 *
 * Read-only by construction: the direct half comes from `lib/fixtureSources.ts`, which selects
 * ids, names and logos and never a link, a header or a probe result, and the secured half is the
 * premium list without its legacy source line. A card stores a reference to what appears here, so
 * nothing an editor needs has to be a credential.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isAuthorizedAdmin(req)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const [direct, premium] = await Promise.all([listDirectChannelOptions(), listPremiumChannels()]);
    const conn = await connectToDatabase();

    return NextResponse.json({
      success: true,
      dbMode: conn ? "mongodb" : "local",
      direct,
      secured: premium.map((channel) => ({
        channelId: channel._id,
        sourceType: "secured" as const,
        name: channel.name,
        category: channel.category,
        logoUrl: channel.logoUrl,
      })),
    });
  } catch (error: any) {
    console.error("GET /api/admin/fixtures/sources error:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "Failed to load the channel list" },
      { status: typeof error?.status === "number" ? error.status : 500 }
    );
  }
}
