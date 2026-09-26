"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import Header from "@/components/Header";
import ChannelRail, { RailChannel } from "@/components/ChannelRail";
import { CATEGORIES, isChannelInCategory } from "@/lib/categories";
import { RefreshCw, Tv, SearchX } from "lucide-react";

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
    // Search filters the rails live as you type — no navigation needed.
    e.preventDefault();
  };

  const trimmedQuery = searchQuery.trim().toLowerCase();

  /** One rail per category, in the CATEGORIES order (Sports → Bangla → India → Pakistan → News → Global). */
  const rails = useMemo(() => {
    const pool = trimmedQuery
      ? channels.filter((ch) => ch.name.toLowerCase().includes(trimmedQuery))
      : channels;
    return CATEGORIES.map((category) => ({
      category,
      title: RAIL_TITLES[category.slug] || category.title,
      channels: pool.filter((ch) => isChannelInCategory(ch, category)),
    })).filter((rail) => rail.channels.length > 0);
  }, [channels, trimmedQuery]);

  return (
    <div className="min-h-screen bg-[#060b13] text-slate-100 flex flex-col">
      <Header
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        onSearchSubmit={handleSearchSubmit}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8 space-y-7 sm:space-y-10">
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
            {trimmedQuery ? (
              <>
                <SearchX className="w-12 h-12 text-slate-600 mx-auto mb-3" />
                <h3 className="text-base font-bold text-white mb-1">No Channels Found</h3>
                <p className="text-xs text-slate-400">
                  Nothing matches &ldquo;{searchQuery.trim()}&rdquo;. Try a different name.
                </p>
              </>
            ) : (
              <>
                <Tv className="w-12 h-12 text-slate-600 mx-auto mb-3" />
                <h3 className="text-base font-bold text-white mb-1">No Channels Online</h3>
                <p className="text-xs text-slate-400">
                  There are no active streams right now. Please check back shortly.
                </p>
              </>
            )}
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
            <Link href="/admin-secret-gate" className="hover:text-emerald-400">Admin</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
