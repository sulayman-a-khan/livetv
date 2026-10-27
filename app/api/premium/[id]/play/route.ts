import { NextRequest, NextResponse } from "next/server";
import { getPublicPremiumChannel } from "@/lib/premiumStore";
import { signPremiumEntry } from "@/lib/premiumProxy";
import { isPremiumReady, readPremiumReadiness } from "@/lib/premiumReadiness";
import type { PremiumPlayFailure } from "@/lib/premiumPlayFailure";

export const dynamic = "force-dynamic";

/**
 * A refusal, in the shape the log and the viewer can both read.
 *
 * The body carries a code the client can match and an English reason for the log; the Bengali
 * a viewer reads is derived from the code on their side (`lib/premiumPlayFailure.ts`). A
 * refusal without a code would reach the screen as English, because there would be nothing to
 * translate — so the code is not optional, and the parameter type says so.
 */
function refuse(
  code: PremiumPlayFailure,
  status: number,
  error: string,
  headers?: Record<string, string>
): NextResponse {
  return NextResponse.json({ success: false, code, error }, { status, headers });
}

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
 *
 * A refusal is answered in two vocabularies: a code and an English reason for the log. The
 * Bengali a viewer reads is derived from the code on their side, because this tier's own
 * routes never answer in Bengali and a screen that mixes the two languages reads as broken.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const channel = await getPublicPremiumChannel(params.id);
    if (!channel) {
      return refuse("not_found", 404, "Channel not found");
    }
    if (!channel.active) {
      return refuse("off_air", 410, "This channel is off air");
    }
    if (!channel.proxyChannelKey) {
      return refuse("not_pushed", 409, "This channel has no stream on the box yet");
    }

    // The row says a source was pushed; only the box says whether it can serve it. Asking is
    // free for the box — its liveness answer reads process state and opens no upstream
    // session — and an answer this route does not have is treated as a no, because a signed
    // URL handed out during an outage is a spinner on a viewer's screen and a wasted tap.
    if (!isPremiumReady(await readPremiumReadiness())) {
      return refuse("box_unavailable", 503, "This stream is off air right now", {
        "cache-control": "no-store",
      });
    }

    const signed = await signPremiumEntry(channel.proxyChannelKey);
    if (!signed.ok) {
      return refuse("sign_failed", 502, signed.error);
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
    return refuse("box_unreachable", 502, "Could not reach the stream box");
  }
}
