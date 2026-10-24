import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isAuthorizedAdmin } from "@/lib/adminAuth";
import { connectToDatabase } from "@/lib/db";
import { createFixture, listFixtures, premiumChannelExists } from "@/lib/premiumStore";
import { validateFixtureInput } from "@/lib/premiumFixtures";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
    { status: 401 }
  );
}

function fail(error: any, fallback: string) {
  const status = typeof error?.status === "number" ? error.status : 500;
  console.error("GET/POST /api/admin/fixtures error:", error);
  return NextResponse.json({ success: false, error: error?.message || fallback }, { status });
}

/**
 * GET /api/admin/fixtures
 * The whole board, unpublished matches included, soonest kickoff first.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isAuthorizedAdmin(req)) return unauthorized();
    const fixtures = await listFixtures();
    const conn = await connectToDatabase();
    return NextResponse.json({
      success: true,
      dbMode: conn ? "mongodb" : "local",
      count: fixtures.length,
      fixtures,
    });
  } catch (error: any) {
    return fail(error, "Failed to load fixtures");
  }
}

/**
 * POST /api/admin/fixtures
 * Enters one match by hand. A new fixture starts unpublished, so nothing reaches
 * a viewer until the admin switches this card on.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await authorizeAdminRequest(req);
    if (!auth.ok) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    const { value, errors } = validateFixtureInput(auth.body, true);
    if (errors.length > 0) {
      return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 400 });
    }

    if (value.premiumChannelId && !(await premiumChannelExists(value.premiumChannelId))) {
      return NextResponse.json(
        { success: false, error: "Linked channel is not in the premium list" },
        { status: 400 }
      );
    }

    const fixture = await createFixture({
      sport: value.sport!,
      teamA: value.teamA!,
      teamB: value.teamB!,
      teamALogo: value.teamALogo ?? "",
      teamBLogo: value.teamBLogo ?? "",
      competition: value.competition ?? "",
      startsAt: value.startsAt!,
      durationMinutes: value.durationMinutes ?? 120,
      premiumChannelId: value.premiumChannelId ?? null,
      visible: value.visible === true,
    });

    return NextResponse.json({ success: true, fixture });
  } catch (error: any) {
    return fail(error, "Failed to add fixture");
  }
}
