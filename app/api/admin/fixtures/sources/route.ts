import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import { listDirectChannelOptions } from "@/lib/fixtureSources";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/fixtures/sources
 * Every channel a match may be linked to, in the one call the fixture editor makes when it opens.
 *
 * The direct catalogue is the only list here: a match links catalogue channels, so the premium
 * tier is not part of this workflow and its rows are not read.
 *
 * Read-only by construction: `lib/fixtureSources.ts` selects ids, names and logos and never a
 * link, a header or a probe result. A card stores a reference to what appears here, so nothing an
 * editor needs has to be a credential.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isAuthorizedAdmin(req)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const direct = await listDirectChannelOptions();

    return NextResponse.json({
      success: true,
      dbMode: "mongodb",
      direct,
    });
  } catch (error: any) {
    console.error("GET /api/admin/fixtures/sources error:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "Failed to load the channel list" },
      { status: typeof error?.status === "number" ? error.status : 500 }
    );
  }
}
