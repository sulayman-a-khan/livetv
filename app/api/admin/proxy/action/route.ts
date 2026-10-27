import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest } from "@/lib/adminAuth";
import { proxyActionResponse } from "@/lib/proxyActions";

export const dynamic = "force-dynamic";

/**
 * The ceiling this route asks the platform for.
 *
 * The slowest action is the probe: the box opens the upstream itself and allows twelve
 * seconds for it, and this server waits up to twenty before it gives up. A function that
 * was killed by the platform before the box answered would report a failure that never
 * happened, so the ceiling is declared rather than left to the default — the same way the
 * other long admin routes in this app declare theirs.
 */
export const maxDuration = 30;

/**
 * POST /api/admin/proxy/action
 *
 * The write half of the 24/7 control panel: one route that performs one of four named
 * actions on the stream box.
 *
 * The browser names the action and the row it means; it never names a path, a URL or a
 * credential. The request to the box is assembled on this server from a closed table
 * (`lib/proxyActions.ts`), the box's write token stays in this server's environment, and what
 * comes back is a projection rather than the box's own body — so a browser that has been
 * given the admin secret still holds no proxy credential and no upstream address.
 *
 * The admin secret is checked before the body is read and long before the box is asked, so
 * an unauthorized caller cannot make this server write on their behalf.
 */
export async function POST(req: NextRequest) {
  const auth = await authorizeAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json(
      { success: false, error: auth.error },
      { status: auth.status, headers: { "cache-control": "no-store" } }
    );
  }

  const body = (auth.body ?? {}) as Record<string, unknown>;
  // The secret may have travelled in the header or in the body; the action layer is given
  // whichever one the guard accepted, so it can make the same decision the guard made.
  const presented =
    req.headers.get("x-admin-secret") ?? (typeof body.secretKey === "string" ? body.secretKey : null);

  const result = await proxyActionResponse(presented, {
    action: body.action,
    target: body.target,
    active: body.active,
  });

  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "cache-control": "no-store" },
  });
}
