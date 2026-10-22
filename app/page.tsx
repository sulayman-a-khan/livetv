"use client";

import "@/lib/tvPolyfills";
import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import Header from "@/components/Header";
import AppDownloadBanner from "@/components/AppDownloadBanner";
import { CATEGORIES, getCategoryBySlug, isChannelInCategory } from "@/lib/categories";
import { getChannelLogo } from "@/lib/utils";
import { RefreshCw, Tv, WifiOff } from "lucide-react";

interface ApiChannel {
  _id: string;
  name: string;
  logo: string;
  category?: string;
}

/** The pill row: "All" first, then the five categories in CATEGORIES order. */
const FILTER_SLUGS = ["all", ...CATEGORIES.map((category) => category.slug)];

export default function HomePage() {
  const [channels, setChannels] = useState<ApiChannel[]>([]);
  const [loading, setLoading] = useState(true);
  /** The list could not be read at all — which is not the same as being empty. */
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  /** Which pill is on; `all` is every live channel. */
  const [activeSlug, setActiveSlug] = useState("all");

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

  const activeCategory = activeSlug === "all" ? null : getCategoryBySlug(activeSlug);

  /**
   * The API already sorts pinned first, then priorityOrder, then name, so the
   * grid keeps that order and only filters — the same rule the watch page
   * sidebar follows, which is what makes the two lists agree.
   */
  const visible = useMemo(() => {
    if (!activeCategory) return channels;
    return channels.filter((ch) => isChannelInCategory(ch, activeCategory));
  }, [channels, activeCategory]);

  const heading = activeCategory ? `${activeCategory.title} Channels` : "All Channels";

  return (
    <div className="min-h-screen bg-[#060b13] text-slate-100 flex flex-col">
      <Header />

      {/* Promo banner — phones only, inside the same container as the card below */}
      <div className="sm:hidden max-w-7xl w-full mx-auto px-4 pt-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/mobile-promo-banner.jpg"
          alt="খেলা ও টিভি দেখুন যখন তখন"
          className="block w-full h-auto"
        />
      </div>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8">
        <section className="rounded-2xl border border-slate-800/80 bg-[#0a1222] overflow-hidden animate-fade-in">
          {/* Panel header: desktop only, so phones go straight into the pills */}
          <div className="p-3.5 border-b border-slate-800/80 hidden sm:flex items-center justify-between gap-3 bg-[#0d1628]">
            <h2 className="text-sm font-black text-white tracking-tight truncate">{heading}</h2>
            {!loadFailed && (
              <span className="text-[10px] font-bold text-emerald-400 bg-[#070d18] border border-emerald-500/30 px-2.5 py-0.5 rounded-full shrink-0">
                {loading ? "…" : `${visible.length} Live`}
              </span>
            )}
          </div>

          {/* Category pills — spread edge-to-edge on phones, filtering in place */}
          <div className="px-2 py-1.5 border-b border-slate-800/60 bg-[#080e1b] flex items-center gap-1.5 justify-between sm:gap-2.5 sm:justify-start overflow-x-auto scrollbar-none shrink-0">
            {FILTER_SLUGS.map((slug) => {
              const isActive = activeSlug === slug;
              const label = slug === "all" ? "All" : getCategoryBySlug(slug)?.name || slug;
              return (
                <button
                  key={slug}
                  type="button"
                  onClick={() => setActiveSlug(slug)}
                  className={`px-1.5 py-1 rounded-lg text-[10px] font-bold whitespace-nowrap transition-all shrink-0 cursor-pointer ${
                    isActive
                      ? "bg-[#00c978] text-slate-950 shadow-sm"
                      : "bg-[#0d1628] text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-800"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {loading ? (
            // The same card, header row, pill row and tile grid as the loaded
            // list, so nothing jumps when the channels arrive.
            <div className="grid grid-cols-4 gap-1.5 p-2 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
              {Array.from({ length: 24 }).map((_, i) => (
                <div key={i} className="w-full min-w-0 flex flex-col items-center gap-1 p-1.5">
                  <div className="w-14 h-14 rounded-full bg-[#0d1628] animate-pulse" />
                  <div className="h-3 w-[80%] rounded bg-[#0d1628] animate-pulse" />
                </div>
              ))}
            </div>
          ) : loadFailed ? (
            <div className="p-16 text-center max-w-md mx-auto">
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
          ) : visible.length === 0 ? (
            <div className="p-16 text-center max-w-md mx-auto">
              <Tv className="w-12 h-12 text-slate-600 mx-auto mb-3" />
              <h3 className="text-base font-bold text-white mb-1">
                {activeCategory ? `No ${activeCategory.name} Channels` : "No Channels Online"}
              </h3>
              <p className="text-xs text-slate-400">
                {activeCategory
                  ? "Nothing is live under this category right now. Pick All to see every channel."
                  : "There are no active streams right now. Please check back shortly."}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-1.5 p-2 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
              {visible.map((channel) => (
                <Link
                  key={channel._id}
                  href={`/watch/${channel._id}?category=${activeSlug}`}
                  className="group w-full min-w-0 flex flex-col items-center gap-1 p-1.5 rounded-xl border border-transparent hover:bg-slate-800/50 transition-all text-center"
                >
                  <div className="relative shrink-0">
                    <div className="w-14 h-14 rounded-full bg-white/95 border border-slate-700 p-1.5 flex items-center justify-center overflow-hidden group-hover:border-slate-500">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={getChannelLogo(channel.name, channel.logo)}
                        alt={channel.name}
                        loading="lazy"
                        className="max-w-full max-h-full object-contain"
                        onError={(e) => {
                          const target = e.target as HTMLImageElement;
                          if (!target.dataset.fallback) {
                            target.dataset.fallback = "true";
                            const initials = channel.name.substring(0, 2).toUpperCase();
                            target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(
                              initials
                            )}&background=0284c7&color=ffffff&size=200&bold=true`;
                          }
                        }}
                      />
                    </div>
                    <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-[#0a1222] animate-pulse" />
                  </div>

                  <h3 className="w-full min-w-0 text-[9px] leading-tight truncate font-bold text-slate-200 group-hover:text-white">
                    {channel.name}
                  </h3>
                </Link>
              ))}
            </div>
          )}
        </section>
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
