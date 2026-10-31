import { NextRequest, NextResponse } from "next/server";
import { redeemEnrollment } from "@/lib/boxRegistry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The largest body this route will read. An enrollment carries a box's name and a
 * one-time code, and nothing else.
 */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * POST /api/proxy/box/enroll
 *
 * Where a box trades its enrollment code for its own credentials.
 *
 * The code is issued by an admin on this site and handed to the operator once. The box
 * presents it here, and the site answers with the three tokens that box will use from now
 * on — derived for that box alone, so a box that leaks one does not give anyone access to
 * another box, and revoking a box is a change to one row rather than an edit on every
 * machine.
 *
 * The code is spent as it is redeemed: it is cleared from the row in the same breath, so a
 * code that was captured cannot be replayed. The site keeps only its hash, so a dump of
 * this site's database cannot be replayed as an enrollment either.
 *
 * The answer carries a credential, so it is never cached and never repeated to a second
 * caller: the code is refused the moment it has been used once.
 */
export async function POST(req: NextRequest) {
  const declared = Number(req.headers.get("content-length") || "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, error: "Request body too large" },
      { status: 413, headers: { "cache-control": "no-store" } }
    );
  }

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json(
      { success: false, error: "Request body too large" },
      { status: 413, headers: { "cache-control": "no-store" } }
    );
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }

  const result = await redeemEnrollment({
    boxId: typeof body.boxId === "string" ? body.boxId : "",
    code: typeof body.code === "string" ? body.code : "",
  });

  if (!result.ok) {
    const status = result.reason === "invalid" ? 400 : result.reason === "refused" ? 403 : 503;
    return NextResponse.json(
      { success: false, error: result.error },
      { status, headers: { "cache-control": "no-store" } }
    );
  }

  return NextResponse.json(
    {
      success: true,
      boxId: result.boxId,
      tokens: result.tokens,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
