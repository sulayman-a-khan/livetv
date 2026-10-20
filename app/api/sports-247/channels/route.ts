import { proxyConfigured, proxyJson, buildProxyCards } from "@/lib/proxySign";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

/**
 * The 24/7 Live Sports listing, already carrying a playable signed URL per channel.
 *
 * Minting happens here rather than in the player on purpose: a card that arrives
 * with its entry URL starts on the first tap, with no token round trip in front of
 * the first frame. The browser never learns the app token and never signs anything.
 *
 * Read-only and public, like the channel catalogue. What it exposes is a list of
 * names and short-lived play capabilities — never a credential.
 */
export async function GET() {
  if (!proxyConfigured()) {
    return proxyJson({ ok: false, code: "proxy_not_configured", channels: [] }, { status: 503 });
  }
  const { cards, source, tokenTtlMs } = await buildProxyCards();
  return proxyJson({
    ok: true,
    source,
    tokenTtlMs,
    count: cards.length,
    channels: cards,
  });
}
