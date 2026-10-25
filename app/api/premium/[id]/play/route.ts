import { NextRequest, NextResponse } from "next/server";
import { getPublicPremiumChannel } from "@/lib/premiumStore";
import { signPremiumEntry } from "@/lib/premiumProxy";
import { isPremiumReady, readPremiumReadiness } from "@/lib/premiumReadiness";

export const dynamic = "force-dynamic";

/**
 * GET /api/premium/[id]/play
 *
 * Ask the stream box for a short-lived entry URL for one premium channel.
 *
 * This exists so the signing secret never appears in a browser: the player calls here, and what
 * it receives is a URL that is already signed and already expiring. The row's own history — the
 * source line an admin pushed, or the legacy `sourceUrl` column on rows entered before the box
 * existed — is not in this response, because the projection this route reads has no such field
 * to reach for.
 *
 * No caching, on purpose: a signed URL is good for one viewer for one short window, and an edge
 * copy of it would hand that window to whoever arrives next.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const channel = await getPublicPremiumChannel(params.id);
    if (!channel) {
      return NextResponse.json({ success: false, error: "Channel not found" }, { status: 404 });
    }
    if (!channel.active) {
      return NextResponse.json({ success: false, error: "This channel is off air" }, { status: 410 });
    }
    if (!channel.proxyChannelKey) {
      return NextResponse.json(
        { success: false, error: "This channel has no stream on the box yet" },
        { status: 409 }
      );
    }

    // The row says a source was pushed; only the box says whether it can serve it. Asking is
    // free for the box — its liveness answer reads process state and opens no upstream
    // session — and an answer this route does not have is treated as a no, because a signed
    // URL handed out during an outage is a spinner on a viewer's screen and a wasted tap.
    if (!isPremiumReady(await readPremiumReadiness())) {
      return NextResponse.json(
        { success: false, error: "This stream is off air right now" },
        { status: 503, headers: { "cache-control": "no-store" } }
      );
    }

    const signed = await signPremiumEntry(channel.proxyChannelKey);
    if (!signed.ok) {
      return NextResponse.json({ success: false, error: signed.error }, { status: 502 });
    }

    return NextResponse.json(
      {
        success: true,
        name: channel.name,
        entryUrl: signed.value.entryUrl,
        expiresAt: signed.value.expiresAt,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error: any) {
    console.error("GET /api/premium/[id]/play error:", error?.name || "failed to sign");
    return NextResponse.json({ success: false, error: "Could not reach the stream box" }, { status: 502 });
  }
}
