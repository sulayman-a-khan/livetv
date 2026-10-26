import { NextRequest, NextResponse } from "next/server";
import { proxyStatusResponse } from "@/lib/proxyControl";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/proxy/status
 *
 * The 24/7 control panel's only data source. It asks the stream box for its health answer
 * and hands the panel a fixed projection of it: reachability, whether the service is
 * actually usable, the ownership mode, the counters and the last successful snapshot time.
 *
 * Two things it deliberately does not do. It does not forward the box's body — the shape
 * the panel receives is built field by field here, so a field the box grows later cannot
 * reach a browser by accident. And it does not carry a proxy credential: the health route
 * asks for no token, so this endpoint holds nothing that could be leaked from it.
 *
 * The admin secret is checked before the box is asked at all, so an unauthorized caller
 * cannot make this server talk to the box on their behalf.
 */
export async function GET(req: NextRequest) {
  const result = await proxyStatusResponse(req.headers.get("x-admin-secret"));
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "cache-control": "no-store" },
  });
}
