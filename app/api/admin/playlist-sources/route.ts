import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import { createSource, getSourcesPayload, validateSourceInput } from "@/lib/playlistSources";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
    { status: 401 }
  );
}

function fail(error: any, fallback: string) {
  const status = typeof error?.status === "number" ? error.status : 500;
  console.error(`GET/POST /api/admin/playlist-sources error:`, error);
  return NextResponse.json({ success: false, error: error?.message || fallback }, { status });
}

/**
 * GET /api/admin/playlist-sources
 * The source list plus the monitor's own state, for the admin dashboard section.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isAuthorizedAdmin(req)) return unauthorized();
    const payload = await getSourcesPayload();
    return NextResponse.json({ success: true, dbMode: "mongodb", ...payload });
  } catch (error: any) {
    return fail(error, "Failed to load playlist sources");
  }
}

/**
 * POST /api/admin/playlist-sources
 * Adds a playlist source. Daily monitoring is on by default and can be switched
 * off per source; a source never becomes a global provider for other channels.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    if (!isAuthorizedAdmin(req, body.secretKey)) return unauthorized();

    const { value, errors } = validateSourceInput(body, true);
    if (errors.length > 0) {
      return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 400 });
    }

    const source = await createSource({
      name: value.name!,
      url: value.url!,
      sourceType: value.sourceType || "m3u",
      active: value.active !== false,
      monitored: value.monitored !== false,
    });

    return NextResponse.json({ success: true, source });
  } catch (error: any) {
    return fail(error, "Failed to add playlist source");
  }
}
