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
 * The whole premium list, source URLs included, for the admin panel only. A
 * viewer-facing route is a separate projection that omits them.
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
 * Adds one channel from whatever URL the admin supplies. The app places no
 * condition on the shape of that URL beyond it being http(s).
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
      sourceUrl: value.sourceUrl!,
      headers: value.headers ?? { userAgent: "", referer: "" },
      active: value.active !== false,
      sortOrder: value.sortOrder ?? 99,
      note: value.note ?? "",
    });

    return NextResponse.json({ success: true, channel });
  } catch (error: any) {
    return fail(error, "Failed to add premium channel");
  }
}
