import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isAuthorizedAdmin } from "@/lib/adminAuth";
import { connectToDatabase } from "@/lib/db";
import {
  createPremiumChannel,
  deletePremiumChannel,
  listPremiumChannels,
  setPremiumProxy,
} from "@/lib/premiumStore";
import { boxLogoProblem, validatePremiumChannelInput } from "@/lib/premiumFixtures";
import { BOX_CHANNEL_FIELDS, boxShapeOf, syncChannelToBox } from "@/lib/premiumBoxSync";
import { proxyKeyForRow } from "@/lib/premiumProxy";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
    { status: 401 }
  );
}

function fail(error: any, fallback: string) {
  const status = typeof error?.status === "number" ? error.status : 500;
  console.error("GET/POST /api/admin/premium/channels error:", error);
  return NextResponse.json({ success: false, error: error?.message || fallback }, { status });
}

/**
 * GET /api/admin/premium/channels
 * The whole premium list for the admin panel only: every row, including the handle each one's
 * source sits under on the stream box and when it was pushed. Nothing written any more carries a
 * source line of its own — the box's vault holds that — and a viewer-facing route is a separate
 * projection again.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isAuthorizedAdmin(req)) return unauthorized();
    const channels = await listPremiumChannels();
    const conn = await connectToDatabase();
    return NextResponse.json({
      success: true,
      dbMode: conn ? "mongodb" : "local",
      count: channels.length,
      premiumChannels: channels,
    });
  } catch (error: any) {
    return fail(error, "Failed to load premium channels");
  }
}

/**
 * POST /api/admin/premium/channels
 * Add a channel to the rail.
 *
 * Two kinds of channel, and the difference is where the stream comes from:
 *
 *   - **A row with no provider** is a name and a place on the rail. Its stream, if it gets
 *     one, is pushed to the box by `.../channels/[id]/push`, which owns that lane. Nothing is
 *     written to the box here.
 *   - **A row with a provider** plays from an account on the box: a stream and the streams it
 *     falls back to. The row is written first and the box second, and a box that refuses the
 *     change takes the row with it — a row that claims a stream the box does not hold is a row
 *     that plays nothing and says otherwise.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await authorizeAdminRequest(req);
    if (!auth.ok) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    const { value, errors } = validatePremiumChannelInput(auth.body, true);
    if (errors.length > 0) {
      return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 400 });
    }

    const logoProblem = boxLogoProblem(value.logoUrl ?? "", value.providerId ?? "");
    if (logoProblem) {
      return NextResponse.json({ success: false, error: logoProblem }, { status: 400 });
    }

    const channel = await createPremiumChannel({
      name: value.name!,
      category: value.category ?? "Premium",
      logoUrl: value.logoUrl ?? "",
      active: value.active !== false,
      sortOrder: value.sortOrder ?? 99,
      note: value.note ?? "",
      proxyChannelKey: value.proxyChannelKey ?? "",
      providerId: value.providerId ?? "",
      streamId: value.streamId ?? "",
      backupStreamIds: value.backupStreamIds ?? [],
    });

    // A row with no provider has no stream yet, so there is nothing for the box to hold.
    if (!channel.providerId) {
      return NextResponse.json({ success: true, channel });
    }

    // The handle a provider-backed channel is filed under: the one the admin typed, or the one
    // the row's own id implies. The row keeps it either way, so the site and the box are never
    // looking at two different channels.
    const channelKey = channel.proxyChannelKey || proxyKeyForRow(channel._id);
    const withKey =
      (await setPremiumProxy(channel._id, {
        proxyChannelKey: channelKey,
        proxyPushedAt: new Date(),
      })) ?? channel;

    const outcome = await syncChannelToBox(boxShapeOf(withKey), BOX_CHANNEL_FIELDS);
    if (!outcome.ok) {
      // The row goes with the change it made. Keeping it would leave a channel on the rail
      // that names a provider and a stream the box has never heard of.
      await deletePremiumChannel(channel._id);
      return NextResponse.json(
        {
          success: false,
          error: `the channel was not added because the stream box refused it: ${outcome.error}`,
          code: outcome.code,
        },
        { status: outcome.status }
      );
    }

    return NextResponse.json({ success: true, channel: withKey });
  } catch (error: any) {
    return fail(error, "Failed to add premium channel");
  }
}
