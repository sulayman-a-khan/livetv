import { NextRequest, NextResponse } from "next/server";
import { normaliseFavouriteKey, parseFavouriteIds } from "@/lib/favourites";
import { readFavouriteList, writeFavouriteList } from "@/lib/favouriteList";

export const dynamic = "force-dynamic";

/**
 * The list a viewer saved, on the site, under the key they carry.
 *
 * The app has no accounts and never will, so the key IS the list: the device
 * writes a key, shows it to the viewer, and the same key typed into another
 * device is the same list. There is nothing here to log into, nothing that
 * names the viewer, and no credential but the key itself — a list of channel
 * ids and the eight characters it travels under.
 *
 * Because the key is the only secret, the route is open to anyone who has the
 * key: that is the design, and it is why the key is eight characters from a
 * thirty-two letter alphabet with the characters that are read wrong over the
 * phone left out. A key that is guessed is not worth guessing — but a key that
 * is known is a list that can be replaced, so the list is worth nothing to
 * anyone but its owner.
 *
 * Nothing here is cached: the answer is one viewer's, not the public's.
 */

/** The largest body the route reads. A list is ids, and it is small. */
const MAX_BODY_BYTES = 64 * 1024;

/** The answer every refusal uses. */
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/app/favourites?key=…
 * The ids the site holds under that key.
 *
 * A key the site holds no record of is answered with a failure and not with an
 * empty list: there is no list there, and an empty list would be read as "this
 * viewer keeps no channels" and would take the list off the device that still
 * has it. The app reads a failure as "the site has nothing for me" and keeps
 * what it holds.
 *
 * A key the site holds a record of is answered with what is in it, and a list
 * that is empty because the viewer emptied it is an empty list.
 */
export async function GET(req: NextRequest) {
  const key = normaliseFavouriteKey(new URL(req.url).searchParams.get("key"));
  if (!key) {
    return NextResponse.json(
      { success: false, error: "That is not a key the app writes." },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const list = await readFavouriteList(key);
    if (!list) {
      return NextResponse.json(
        { success: false, error: "There is no saved list under that key." },
        { status: 404, headers: NO_STORE }
      );
    }
    return NextResponse.json(
      {
        success: true,
        ids: list.ids,
        updatedAt: list.updatedAt,
      },
      { status: 200, headers: NO_STORE }
    );
  } catch (error: any) {
    console.error("GET /api/app/favourites error:", error);
    // Failure is not emptiness: the app keeps the list on the device when the
    // site cannot be asked, and an empty list would take it away. What failed
    // is said and nothing about the database behind it is.
    return NextResponse.json(
      { success: false, error: "Failed to read the saved list" },
      { status: 503, headers: NO_STORE }
    );
  }
}

/**
 * POST /api/app/favourites
 * Puts the device's list on the site, under the device's key.
 *
 * The write is the whole truth: the app has no account and no way to merge
 * two copies, so the list that was written last is the list that is kept.
 */
export async function POST(req: NextRequest) {
  const body = await readBody(req);
  if (!body.ok) {
    return NextResponse.json(
      { success: false, error: body.error },
      { status: body.status, headers: NO_STORE }
    );
  }

  const key = normaliseFavouriteKey(body.value.key);
  if (!key) {
    return NextResponse.json(
      { success: false, error: "That is not a key the app writes." },
      { status: 400, headers: NO_STORE }
    );
  }

  const ids = parseFavouriteIds(body.value.ids);
  if (!ids.ok) {
    return NextResponse.json(
      { success: false, error: ids.error },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const list = await writeFavouriteList(key, ids.ids);
    return NextResponse.json(
      { success: true, ids: list.ids, updatedAt: list.updatedAt },
      { status: 200, headers: NO_STORE }
    );
  } catch (error: any) {
    console.error("POST /api/app/favourites error:", error);
    // A write that did not land is a failure and not an empty list: the app
    // keeps the list on the device and pushes it again later. What failed is
    // said and nothing about the database behind it is.
    return NextResponse.json(
      { success: false, error: "Failed to save the list" },
      { status: 503, headers: NO_STORE }
    );
  }
}

/** The request body, or the reason it was not read. */
type Body =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; error: string };

/**
 * The body, read under a cap.
 *
 * The declared length is checked first so an oversized payload is refused
 * before it is buffered, and the bytes that actually arrived are checked
 * afterwards, because a chunked request declares no length.
 */
async function readBody(req: NextRequest): Promise<Body> {
  const declared = Number(req.headers.get("content-length") || "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "Request body too large" };
  }

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "Request body too large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: "The body is not JSON." };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: "The body is not a list request." };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
}
