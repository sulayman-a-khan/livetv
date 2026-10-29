import { NextRequest, NextResponse } from "next/server";
import { isProxyAdminSecretValid, proxyControlConfigProblem } from "@/lib/proxyControl";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/proxy/session
 *
 * The proxy control panel asks here whether its key is valid, and whether this server has a
 * stream box configured at all. It exists so this admin surface never has to call a Direct
 * HLS route (`/api/admin/stats`) or the premium tier's route just to sign in: the three
 * panels share only the secret key and the auth helper, never an endpoint.
 *
 * It asks the box nothing. The answer is about this server's own configuration, so a signed
 * -in panel learns whether a box is configured without generating a single request upstream.
 */
export async function GET(req: NextRequest) {
  if (!isProxyAdminSecretValid(req.headers.get("x-admin-secret"))) {
    return NextResponse.json(
      { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
      { status: 401, headers: { "cache-control": "no-store" } }
    );
  }

  const problem = await proxyControlConfigProblem();
  return NextResponse.json(
    {
      success: true,
      // A boolean, not the address: the panel needs to know whether a box is configured
      // here, and the address itself never leaves the server.
      boxConfigured: !problem,
      missing: problem ? problem.split(", ") : [],
    },
    { headers: { "cache-control": "no-store" } }
  );
}
