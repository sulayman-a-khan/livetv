import { NextRequest, NextResponse } from "next/server";
import { proxyInspectResponse } from "@/lib/proxyControl";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/proxy/inspect
 *
 * The 24/7 control panel's second data source: the stream box's read-only surface, which
 * reports the vault, the provider rows, the channel-to-provider mapping and the lanes.
 *
 * The box's read-only token is held in this server's environment and is used only here, in
 * the `Authorization` header of the upstream request. It never reaches the browser, never
 * appears in a URL, and is never asked for by anything a caller controls.
 *
 * The answer is built field by field from the box's reply, so the shape the panel receives
 * is this file's, not the box's: a field the box grows later cannot reach a browser by
 * accident, and the fields that could carry a credential are not copied at all.
 *
 * The admin secret is checked before the box is asked at all, so an unauthorized caller
 * cannot make this server talk to the box on their behalf.
 */
export async function GET(req: NextRequest) {
  const result = await proxyInspectResponse(req.headers.get("x-admin-secret"));
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "cache-control": "no-store" },
  });
}
