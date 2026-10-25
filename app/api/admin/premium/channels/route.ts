import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isAuthorizedAdmin } from "@/lib/adminAuth";
import { connectToDatabase } from "@/lib/db";
import { createPremiumChannel, listPremiumChannels } from "@/lib/premiumStore";
import { validatePremiumChannelInput } from "@/lib/premiumFixtures";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
    { status: 401 }
  );
}

function fail(error: any, fallback: string) {
  const status = typeof error?.status === "number" ? error.status : 500;
  console.error("GET/POST /api/admin/premium/channels error:", error);
  return NextResponse.json({ success: false, error: error?.message || fallback }, { status });
}

/**
 * GET /api/admin/premium/channels
 * The whole premium list for the admin panel only: every row, including the handle each one's
 * source sits under on the stream box and when it was pushed. Nothing written any more carries a
 * source line of its own — the box's vault holds that — and a viewer-facing route is a separate
 * projection again.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isAuthorizedAdmin(req)) return unauthorized();
    const channels = await listPremiumChannels();
    const conn = await connectToDatabase();
    return NextResponse.json({
      success: true,
      dbMode: conn ? "mongodb" : "local",
      count: channels.length,
      premiumChannels: channels,
    });
  } catch (error: any) {
    return fail(error, "Failed to load premium channels");
  }
}

/**
 * POST /api/admin/premium/channels
 * Add a channel to the rail. It carries no stream: the source line is pushed to the stream box
 * by `.../channels/[id]/push`, which keeps only the handle here. A channel created before that
 * push exists simply has nothing to play yet, and the board shows it as such.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await authorizeAdminRequest(req);
    if (!auth.ok) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    const { value, errors } = validatePremiumChannelInput(auth.body, true);
    if (errors.length > 0) {
      return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 400 });
    }

    const channel = await createPremiumChannel({
      name: value.name!,
      category: value.category ?? "Premium",
      logoUrl: value.logoUrl ?? "",
      active: value.active !== false,
      sortOrder: value.sortOrder ?? 99,
      note: value.note ?? "",
      proxyChannelKey: value.proxyChannelKey ?? "",
    });

    return NextResponse.json({ success: true, channel });
  } catch (error: any) {
    return fail(error, "Failed to add premium channel");
  }
}
