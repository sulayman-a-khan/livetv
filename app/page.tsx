"use client";

import "@/lib/tvPolyfills";
import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import Header from "@/components/Header";
import AppDownloadBanner from "@/components/AppDownloadBanner";
import ChannelRail, { RailChannel } from "@/components/ChannelRail";
import { CATEGORIES, isChannelInCategory } from "@/lib/categories";
import { RefreshCw, Tv, WifiOff } from "lucide-react";

/** Friendly row headings for each category rail (overrides the raw category title). */
const RAIL_TITLES: Record<string, string> = {
  sports: "Sports Channels",
  bangla: "Bangla Channels",
  indian: "Indian Channels",
  pakistani: "Pakistani Channels",
  documentary: "Documentary Channels",
};

interface ApiChannel extends RailChannel {
  category?: string;
}

export default function HomePage() {
  const [channels, setChannels] = useState<ApiChannel[]>([]);
  const [loading, setLoading] = useState(true);
  /** The list could not be read at all — which is not the same as being empty. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;

    setLoading(true);
    setLoadFailed(false);

    /** One attempt, then a single retry — a dropped request is usually gone by then. */
    async function attempt(triesLeft: number) {
      try {
        // No cache busting: the route ships a short edge cache, so Vercel serves
        // the catalogue from the nearest pop instead of hitting Node each visit.
        const res = await fetch("/api/channels");
        const data = await res.json();
        // A degraded catalogue answers 503/500 with `success: false`. Treating
        // that as an empty list is what showed "No Channels Online" for a
        // database that was merely slow.
        if (!res.ok || data?.success === false) {
          throw new Error(`Catalogue request failed (${res.status})`);
        }
        if (!active) return;
        const list = Array.isArray(data)
          ? data
          : Array.isArray(data?.channels)
          ? data.channels
          : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.items)
          ? data.items
          : [];
        setChannels(list);
        setLoading(false);
      } catch (err) {
        if (!active) return;
        console.error("Failed to load home channels", err);
        if (triesLeft > 0) {
          retryTimer = window.setTimeout(() => attempt(triesLeft - 1), 700);
          return;
        }
        setLoadFailed(true);
        setLoading(false);
      }
    }
    attempt(1);
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [reloadNonce]);

  /** One rail per category, in the CATEGORIES order (Sports → Bangla → Indian → Pakistani → Documentary). */
  const rails = useMemo(() => {
    const catRails = CATEGORIES.map((category) => ({
      slug: category.slug,
      title: RAIL_TITLES[category.slug] || category.title,
      badge: category.badge,
      channels: channels.filter((ch) => isChannelInCategory(ch, category)),
    })).filter((rail) => rail.channels.length > 0);

    // Fallback: channels exist but matched no rail (only possible if a record
    // somehow carries a category outside the five) — show them all in one row.
    if (catRails.length === 0 && channels.length > 0) {
      return [{ slug: "all-channels", title: "All Live Channels", badge: "📺", channels }];
    }

    return catRails;
  }, [channels]);

  return (
    <div className="min-h-screen bg-[#060b13] text-slate-100 flex flex-col">
      <Header />

      {/* Promo banner — phones only, edge to edge under the navbar */}
      <div className="sm:hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/mobile-promo-banner.jpg"
          alt="খেলা ও টিভি দেখুন যখন তখন"
          className="block w-full h-auto"
        />
      </div>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8 space-y-7 sm:space-y-10">
        {/* Channel rails */}
        {loading ? (
          <div className="space-y-4 sm:space-y-10" aria-busy="true">
            {CATEGORIES.map((category) => (
              <div key={category.slug} className="space-y-1.5 sm:space-y-3">
                {/* Row header: the badge box + title/subtitle line boxes ChannelRail renders */}
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="shrink-0 w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-[#0d1628] animate-pulse" />
                  <div className="min-w-0">
                    <div className="h-7 flex items-center">
                      <div className="h-[18px] w-40 rounded bg-[#0d1628] animate-pulse" />
                    </div>
                    <div className="h-4 hidden sm:flex items-center">
                      <div className="h-3 w-24 rounded bg-[#0d1628] animate-pulse" />
                    </div>
                  </div>
                </div>
                <div className="-mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 overflow-hidden">
                  <div className="flex items-start gap-3 sm:gap-4 pt-0.5 sm:pt-1 pb-1 sm:pb-2">
                    {Array.from({ length: 12 }).map((_, j) => (
                      <div
                        key={j}
                        className="shrink-0 w-[78px] sm:w-[104px] flex flex-col items-center gap-2"
                      >
                        <div className="w-[62px] h-[62px] sm:w-[84px] sm:h-[84px] rounded-full bg-[#0d1628] animate-pulse" />
                        <div className="w-full h-4 flex items-center justify-center">
                          <div className="h-3 w-[70%] rounded bg-[#0d1628] animate-pulse" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : loadFailed ? (
          <div className="rounded-2xl border border-slate-800 bg-[#0a1222] p-16 text-center max-w-md mx-auto my-8">
            <WifiOff className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <h3 className="text-base font-bold text-white mb-1">Channel List Unavailable</h3>
            <p className="text-xs text-slate-400 mb-5">
              The channel list did not come through. Check your connection and try again.
            </p>
            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#00c978] text-slate-950 text-xs font-black hover:brightness-110 active:scale-[0.98] transition-all"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Try Again
            </button>
          </div>
        ) : rails.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-[#0a1222] p-16 text-center max-w-md mx-auto my-8">
            <Tv className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <h3 className="text-base font-bold text-white mb-1">No Channels Online</h3>
            <p className="text-xs text-slate-400">
              There are no active streams right now. Please check back shortly.
            </p>
          </div>
        ) : (
          <div className="space-y-4 sm:space-y-10 animate-fade-in">
            {rails.map((rail) => (
              <ChannelRail
                key={rail.slug}
                title={rail.title}
                accent={rail.badge}
                categorySlug={rail.slug}
                channels={rail.channels}
              />
            ))}
          </div>
        )}
      </main>

      <AppDownloadBanner />

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-[#070d18] py-4 text-center text-xs text-slate-400 mt-4">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>SoluPlay • 24/7 Automated Live HD Streams</span>
          <div className="flex items-center gap-4 text-slate-400">
            <Link href="/admin-secret-gate" className="hover:text-emerald-400">Admin</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
