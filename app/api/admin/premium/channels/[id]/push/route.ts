import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminRequest, isAuthorizedAdmin } from "@/lib/adminAuth";
import { listPremiumChannels, setPremiumProxy } from "@/lib/premiumStore";
import { validatePremiumSourcePush } from "@/lib/premiumFixtures";
import { proxyKeyForRow, proxyConfigProblem, pushPremiumSource, retractPremiumSource } from "@/lib/premiumProxy";

export const dynamic = "force-dynamic";

function fail(error: any, fallback: string) {
  const status = typeof error?.status === "number" ? error.status : 500;
  // The message goes to the admin's own panel. It is never the source line: this route holds
  // that value only for as long as the request lasts, and an exception text from a transport
  // layer is exactly the kind of string that repeats a URL back.
  console.error("POST/DELETE /api/admin/premium/channels/[id]/push error:", error?.name || fallback);
  return NextResponse.json({ success: false, error: fallback }, { status });
}

/**
 * POST /api/admin/premium/channels/[id]/push
 *
 * Hand one source line to the stream box and remember only the handle it was filed under.
 *
 * The body is `{ sourceUrl, userAgent?, referer? }`. Nothing in it is stored in this database:
 * the proxy's vault is the source of truth, so the row gains `proxyChannelKey` and a timestamp
 * and the line itself is dropped as soon as the box has accepted it. That is the whole point of
 * the split — a copy here would be a second place for a premium credential to leak from, and
 * this repository is public.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const auth = await authorizeAdminRequest(req);
    if (!auth.ok) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    const problem = proxyConfigProblem();
    if (problem) return NextResponse.json({ success: false, error: problem }, { status: 503 });

    const { value, errors } = validatePremiumSourcePush(auth.body);
    if (errors.length > 0) {
      return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 400 });
    }

    const channel = (await listPremiumChannels()).find((row) => row._id === params.id);
    if (!channel) {
      return NextResponse.json({ success: false, error: "Premium channel not found" }, { status: 404 });
    }

    const channelKey = proxyKeyForRow(channel._id);
    const pushed = await pushPremiumSource({
      channelKey,
      name: channel.name,
      sourceUrl: value.sourceUrl,
      userAgent: value.userAgent,
      referer: value.referer,
    });
    if (!pushed.ok) {
      return NextResponse.json({ success: false, error: pushed.error }, { status: 502 });
    }

    const stored = await setPremiumProxy(channel._id, {
      proxyChannelKey: pushed.value.channelKey,
      proxyPushedAt: new Date(pushed.value.pushedAt),
    });
    if (!stored) {
      // The box has the source and this row cannot say so. Say exactly that, rather than
      // reporting a push that a later read would contradict.
      return NextResponse.json(
        {
          success: false,
          error: `the box accepted the source as ${pushed.value.channelKey}, but this row could not be updated`,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      channelKey: stored.proxyChannelKey,
      pushedAt: stored.proxyPushedAt,
    });
  } catch (error: any) {
    return fail(error, "Failed to push the source to the stream box");
  }
}

/**
 * DELETE /api/admin/premium/channels/[id]/push
 * Take the source off the box and clear the handle. The row itself stays: retiring a channel
 * is the admin's decision on the row, not a side effect of unlinking its stream.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    if (!isAuthorizedAdmin(req)) {
      return NextResponse.json(
        { success: false, error: "Unauthorized: Invalid Admin Secret Key" },
        { status: 401 }
      );
    }

    const channel = (await listPremiumChannels()).find((row) => row._id === params.id);
    if (!channel) {
      return NextResponse.json({ success: false, error: "Premium channel not found" }, { status: 404 });
    }
    if (!channel.proxyChannelKey) {
      return NextResponse.json({ success: true, channelKey: "", already: true });
    }

    const problem = proxyConfigProblem();
    if (problem) return NextResponse.json({ success: false, error: problem }, { status: 503 });

    const retracted = await retractPremiumSource(channel.proxyChannelKey);
    if (!retracted.ok) {
      return NextResponse.json({ success: false, error: retracted.error }, { status: 502 });
    }

    const stored = await setPremiumProxy(channel._id, { proxyChannelKey: "", proxyPushedAt: null });
    return NextResponse.json({ success: true, channelKey: stored?.proxyChannelKey ?? "" });
  } catch (error: any) {
    return fail(error, "Failed to remove the source from the stream box");
  }
}
