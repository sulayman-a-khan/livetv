"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { DirectHlsPlayer } from "@/components/players";
import type { FreeStreamMirror } from "@/lib/freeChannelService";

/**
 * The address the card handed us, checked once more before it reaches a player.
 *
 * It was validated on the way into the fixture, but the address is in a query string that
 * anyone can type, so the page applies the same rule: HTTPS, a real host, and no credentials.
 * Anything else renders as a refusal rather than a player with nothing to tune.
 */
function playableHref(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The player a match card's own broadcast link opens.
 *
 * The link is one address, so the ladder is one mirror: there is nothing to fail over to and
 * nothing about the catalogue's ranking to apply. Every other promise of the player — first-frame
 * proof, stall recovery, the tuning overlays — is unchanged, because this is the same component
 * the watch page uses.
 */
function DirectLinkPlayer() {
  const src = useSearchParams().get("src") || "";
  const href = playableHref(src);
  const streams = useMemo<FreeStreamMirror[]>(
    () =>
      href
        ? [{ _id: "fixture-direct", url: href, priority: 1, status: "active", latency: 0 }]
        : [],
    [href]
  );

  return (
    <main className="min-h-[100dvh] bg-[#05080f] text-white">
      <div className="mx-auto w-full max-w-5xl px-3 py-4 sm:px-6 sm:py-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-white transition-colors"
        >
          <span className="w-7 h-7 rounded-lg bg-[#0d1628] border border-slate-800 flex items-center justify-center">
            <ArrowLeft className="w-4 h-4" />
          </span>
          Back to Home
        </Link>

        <div className="mt-3 overflow-hidden rounded-xl border border-slate-800 bg-black">
          {streams.length === 1 ? (
            <DirectHlsPlayer channelName="Live match" streams={streams} />
          ) : (
            <div className="aspect-video w-full flex flex-col items-center justify-center gap-2 px-6 text-center">
              <AlertCircle className="w-9 h-9 text-slate-500" />
              <p className="text-sm font-black text-white">This match link cannot be played</p>
              <p className="text-xs text-slate-400">
                The link is missing, or it is not an HTTPS address.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default function DirectLinkPage() {
  return (
    <Suspense fallback={<main className="min-h-[100dvh] bg-[#05080f]" aria-busy="true" />}>
      <DirectLinkPlayer />
    </Suspense>
  );
}
