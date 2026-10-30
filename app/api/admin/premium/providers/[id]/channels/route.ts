import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedAdmin } from "@/lib/adminAuth";
import { readProviderCatalogue } from "@/lib/proxyControl";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function unauthorized() {
  return NextResponse.json(
    { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
    { status: 401 }
  );
}

/**
 * What each way of failing is called, in the panel's own words.
 *
 * The reasons are different problems, so they are not merged: a box that is down, a box
 * that refuses this server's credential and an account whose panel did not answer all
 * need a different thing done about them.
 */
const REFUSAL_WORDS: Record<string, string> = {
  unreachable: "the stream box could not be reached",
  unauthorized: "the stream box refused this server's credential",
  unknown_provider: "the stream box holds no provider under that name",
  catalogue_unavailable: "the provider's own panel did not answer with its channel list",
  error: "the stream box answered with something this panel cannot use",
  not_configured: "this server has no stream box to ask",
};

/**
 * GET /api/admin/premium/providers/[id]/channels
 *
 * The channels one provider account carries, as the account itself names them.
 *
 * The account's credential lives in the box and nowhere else, so the account's own panel
 * is the only thing that can say which channels it holds. The box asks it and answers
 * with names and stream ids — so an admin picks a channel by its name instead of typing
 * a stream id nobody could see.
 *
 * Nothing here carries a credential: the answer is a list of names, categories and ids.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    if (!isAuthorizedAdmin(req)) return unauthorized();

    const catalogue = await readProviderCatalogue(params.id);

    if (catalogue.refusal) {
      const status =
        catalogue.refusal === "unauthorized"
          ? 401
          : catalogue.refusal === "unknown_provider"
            ? 404
            : catalogue.refusal === "not_configured"
              ? 503
              : 502;
      return NextResponse.json(
        {
          success: false,
          error: REFUSAL_WORDS[catalogue.refusal] ?? REFUSAL_WORDS.error,
          code: catalogue.refusal,
          providerId: catalogue.providerId,
        },
        { status }
      );
    }

    return NextResponse.json({
      success: true,
      providerId: catalogue.providerId,
      count: catalogue.channels.length,
      channels: catalogue.channels,
    });
  } catch (error: any) {
    // The panel's own text is not repeated: an exception raised from a body that holds a
    // credential can quote it.
    console.error("GET /api/admin/premium/providers/[id]/channels error:", error?.name);
    return NextResponse.json(
      { success: false, error: "Failed to read the provider's channel list" },
      { status: 500 }
    );
  }
}
