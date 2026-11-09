"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
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

/** What the browser found when it asked the link for its manifest. */
type LinkStatus = "checking" | "ready" | "invalid" | "blocked" | "timeout" | "http-error";

/**
 * The player a match card's own broadcast link opens.
 *
 * The link is one address, so the ladder is one mirror: there is nothing to fail over to and
 * nothing about the catalogue's ranking to apply.
 *
 * The manifest is asked for before the player is mounted, with the same cross-origin request
 * hls.js is about to make. If the origin refuses it — a token issued for another site's player
 * is the common case — the page says so, instead of tuning forever and then reporting a weak
 * signal for a link that was never going to deliver a frame.
 */
function DirectLinkPlayer() {
  const src = useSearchParams().get("src") || "";
  const href = playableHref(src);
  const [status, setStatus] = useState<LinkStatus>("checking");
  const [httpStatus, setHttpStatus] = useState(0);

  const streams = useMemo<FreeStreamMirror[]>(
    () =>
      href
        ? [{ _id: "fixture-direct", url: href, priority: 1, status: "active", latency: 0 }]
        : [],
    [href]
  );

  useEffect(() => {
    if (!href) {
      setStatus("invalid");
      return;
    }
    let live = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    setStatus("checking");
    fetch(href, { cache: "no-store", signal: controller.signal })
      .then((res) => {
        if (!live) return;
        setHttpStatus(res.status);
        setStatus(res.ok ? "ready" : "http-error");
      })
      .catch((err: any) => {
        if (!live) return;
        setStatus(err?.name === "AbortError" ? "timeout" : "blocked");
      })
      .finally(() => clearTimeout(timer));

    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [href]);

  const failure =
    status === "invalid"
      ? {
          title: "This match link cannot be played",
          detail: "The link is missing, or it is not an HTTPS address.",
        }
      : status === "blocked"
        ? {
            title: "This match link cannot be played here",
            detail:
              "Its host blocks playback from other websites (CORS), so it only works inside the site that issued it.",
          }
        : status === "timeout"
          ? {
              title: "The match link did not answer",
              detail: "The host may be down, or the link may have expired.",
            }
          : status === "http-error"
            ? {
                title: `The match link is unavailable (HTTP ${httpStatus})`,
                detail: "It may have expired, or the match may not have started yet.",
              }
            : null;

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
          {status === "ready" && streams.length === 1 ? (
            <DirectHlsPlayer channelName="Live match" streams={streams} />
          ) : (
            <div className="aspect-video w-full flex flex-col items-center justify-center gap-2 px-6 text-center">
              {failure ? (
                <>
                  <AlertCircle className="w-9 h-9 text-slate-500" />
                  <p className="text-sm font-black text-white">{failure.title}</p>
                  <p className="text-xs text-slate-400 max-w-sm">{failure.detail}</p>
                </>
              ) : (
                <>
                  {/* A load indicator inside the player's own frame, never a page-wide screen:
                      the frame is already where the picture will appear. */}
                  <span className="w-6 h-6 rounded-full border-2 border-slate-600 border-t-emerald-400 animate-spin" />
                  <p className="text-xs font-bold text-slate-400">Checking the match link…</p>
                </>
              )}
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
