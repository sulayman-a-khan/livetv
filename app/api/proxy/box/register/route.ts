import { NextRequest, NextResponse } from "next/server";
import { isBoxRegisterTokenValid, registerBox } from "@/lib/boxRegistry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The largest body this route will read, in bytes. A registration carries an address and a
 * name, and nothing else.
 */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * POST /api/proxy/box/register
 *
 * Where a stream box says where it is.
 *
 * A portable box's address is not knowable in advance: a quick tunnel's hostname is minted
 * when the box starts, so the site has to be told. This route is that telling — the box
 * POSTs its origin and its own name, the site checks the address, proves the address is its
 * own box, and keeps it.
 *
 * The proof has two steps, and the second is what makes the first mean something. The site
 * reads the box's unauthenticated health route and insists on the box's own name in the
 * answer; then it reads the box's catalogue with the site's own app token, which only the box
 * holding that token can answer. A name in a JSON body costs an impostor nothing to copy, so
 * without the second step a host that merely claimed to be a box would be handed the site's
 * box credentials.
 *
 * The credential is `BOX_REGISTER_TOKEN`, presented as `Authorization: Bearer …`, and it is
 * the site's own: the box holds it, the browser never sees it, and the site compares it in
 * constant time. There is no default, so a site with no token configured refuses every
 * registration — an address that nobody can register is an address the site never sends a
 * credential to.
 *
 * The order of the work is the point of the route. The credential is decided before the
 * body is read; the address is checked before anything is fetched; and the box is proved
 * before anything is stored. So an unauthorized caller is answered without the site touching
 * the network, and an address that is not a box is never kept.
 *
 * The answer never repeats the address back. The box sent it and already knows it, and an
 * address is the one thing in this exchange worth not repeating.
 */
export async function POST(req: NextRequest) {
  const presented = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!isBoxRegisterTokenValid(presented)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } }
    );
  }

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

  const result = await registerBox({
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
    boxId: typeof body.boxId === "string" ? body.boxId : "",
  });

  if (!result.ok) {
    const status = result.reason === "invalid" ? 400 : result.reason === "unverified" ? 502 : 503;
    return NextResponse.json(
      { success: false, error: result.error },
      { status, headers: { "cache-control": "no-store" } }
    );
  }

  return NextResponse.json(
    {
      success: true,
      box: { id: result.box.boxId, registeredAt: result.box.registeredAt },
    },
    { headers: { "cache-control": "no-store" } }
  );
}
