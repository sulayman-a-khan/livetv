import type { NextRequest } from "next/server";
import { proxyConfigured, proxyJson, resignEntryUrl } from "@/lib/proxySign";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

/**
 * Re-mints one channel's entry URL.
 *
 * This is not the arena's `/token` preflight in disguise: nothing calls it before
 * playback. It exists for the one moment a long session outlives its signing window
 * and the proxy starts refusing a playlist URL the player has been polling.
 */
export async function GET(req: NextRequest) {
  if (!proxyConfigured()) {
    return proxyJson({ ok: false, code: "proxy_not_configured" }, { status: 503 });
  }
  const channelKey = req.nextUrl.searchParams.get("channelKey")?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(channelKey)) {
    return proxyJson({ ok: false, code: "invalid_channelKey" }, { status: 400 });
  }
  const result = await resignEntryUrl(channelKey);
  if (!result) return proxyJson({ ok: false, code: "unavailable" }, { status: 503 });
  return proxyJson({ ok: true, channelKey, ...result });
}
