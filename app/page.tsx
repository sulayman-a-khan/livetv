"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ChannelRail, { RailChannel } from "@/components/ChannelRail";
import { CATEGORIES, isChannelInCategory } from "@/lib/categories";
import { RefreshCw, Tv } from "lucide-react";

/** Friendly row headings for each category rail (overrides the raw category title). */
const RAIL_TITLES: Record<string, string> = {
  "sports-tv": "Sports Channels",
  "bangladeshi-tv": "Bangladeshi Channels",
  "indian-tv": "Indian Channels",
  "pakistani-tv": "Pakistani Channels",
  "news-tv": "News Channels",
  "global-tv": "Global Channels",
};

interface ApiChannel extends RailChannel {
  category?: string;
  subCategory?: string;
  country?: string;
}

export default function HomePage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [channels, setChannels] = useState<ApiChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch("/api/channels", { cache: "no-store" });
        const data = await res.json();
        if (active && data.success && Array.isArray(data.channels)) {
          setChannels(data.channels);
        }
      } catch (err) {
        console.error("Failed to load home channels", err);
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    router.push(`/category/sports-tv?search=${encodeURIComponent(searchQuery)}`);
  };

  /** One rail per category, in the CATEGORIES order (Sports → Bangla → India → Pakistan → News → Global). */
  const rails = useMemo(
    () =>
      CATEGORIES.map((category) => ({
        category,
        title: RAIL_TITLES[category.slug] || category.title,
        channels: channels.filter((ch) => isChannelInCategory(ch, category)),
      })).filter((rail) => rail.channels.length > 0),
    [channels]
  );

  return (
    <div className="min-h-screen bg-[#060b13] text-slate-100 flex flex-col">
      <Header
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        onSearchSubmit={handleSearchSubmit}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8 space-y-7 sm:space-y-10">
        {/* Top Hero Banner */}
        <section className="relative rounded-3xl overflow-hidden border border-slate-800/80 bg-gradient-to-r from-[#0a1222] via-[#0d172c] to-[#0f1d38] shadow-2xl">
          <div className="absolute top-0 right-1/4 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute bottom-0 left-10 w-72 h-72 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />

          <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[200px] sm:min-h-[280px]">
            <div className="hidden sm:flex lg:col-span-6 p-6 sm:p-10 flex-col justify-center z-10">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-bold mb-4 w-fit">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>Next-Gen Live TV Network</span>
              </div>

              <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-tight text-white leading-tight">
                Welcome to <br />
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-cyan-300 to-emerald-400">
                  SoluPlay
                </span>
              </h1>

              <p className="mt-3 text-slate-300 text-sm sm:text-base font-medium max-w-md">
                Tap any channel to start watching live, instantly.
              </p>

              <div className="w-16 h-1 bg-emerald-400 rounded-full mt-4 shadow-md shadow-emerald-500/50" />
            </div>

            <div className="lg:col-span-6 relative overflow-hidden flex items-center justify-center min-h-[200px] lg:min-h-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/hero_banner.png"
                alt="Live TV montage"
                className="absolute inset-0 w-full h-full object-cover object-center opacity-90 filter saturate-[1.1]"
              />
              <div className="absolute inset-0 bg-gradient-to-r from-[#0a1222] via-[#0a1222]/40 to-transparent lg:block hidden" />
              <div className="absolute inset-0 bg-gradient-to-t from-[#0a1222] via-transparent to-transparent lg:hidden" />
            </div>
          </div>
        </section>

        {/* Channel rails */}
        {loading ? (
          <div className="space-y-8" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-3">
                <div className="h-5 w-40 rounded bg-[#0d1628] animate-pulse" />
                <div className="flex gap-3 sm:gap-4 overflow-hidden">
                  {Array.from({ length: 8 }).map((_, j) => (
                    <div key={j} className="shrink-0 w-[78px] sm:w-[104px] flex flex-col items-center gap-2">
                      <div className="w-[62px] h-[62px] sm:w-[84px] sm:h-[84px] rounded-full bg-[#0d1628] animate-pulse" />
                      <div className="h-2.5 w-14 rounded bg-[#0d1628] animate-pulse" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <p className="flex items-center justify-center gap-2 text-xs font-bold text-slate-400 pt-2">
              <RefreshCw className="w-4 h-4 text-emerald-400 animate-spin" />
              Loading live channels...
            </p>
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
          <div className="space-y-7 sm:space-y-10 animate-fade-in">
            {rails.map((rail) => (
              <ChannelRail
                key={rail.category.slug}
                title={rail.title}
                accent={rail.category.badge}
                categorySlug={rail.category.slug}
                channels={rail.channels}
              />
            ))}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-[#070d18] py-4 text-center text-xs text-slate-400 mt-4">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>SoluPlay • 24/7 Automated Live HD Streams</span>
          <div className="flex items-center gap-4 text-slate-400">
            <Link href="/category/sports-tv" className="hover:text-white">Sports</Link>
            <Link href="/category/bangladeshi-tv" className="hover:text-white">Bangladesh</Link>
            <Link href="/category/indian-tv" className="hover:text-white">India</Link>
            <Link href="/category/pakistani-tv" className="hover:text-white">Pakistan</Link>
            <Link href="/admin-secret-gate" className="hover:text-emerald-400">Admin</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
