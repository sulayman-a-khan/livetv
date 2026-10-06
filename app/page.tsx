"use client";

import "@/lib/tvPolyfills";
import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import Header from "@/components/Header";
import AppDownloadBanner from "@/components/AppDownloadBanner";
import ChannelRail, { RailChannel } from "@/components/ChannelRail";
import LiveSportsArena from "@/components/LiveSportsArena";
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
  const [channels, setChannels] = useState<ApiChannel[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch("/api/channels", { cache: "no-store" });
        const data = await res.json();
        const list = Array.isArray(data)
          ? data
          : Array.isArray(data?.channels)
          ? data.channels
          : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.items)
          ? data.items
          : [];
        if (active) {
          setChannels(list);
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

  /** One rail per category, in the CATEGORIES order (Sports → Bangla → India → Pakistan → News → Global). */
  const rails = useMemo(() => {
    const catRails = CATEGORIES.map((category) => {
      return {
        category,
        title: RAIL_TITLES[category.slug] || category.title,
        channels: channels.filter((ch) => isChannelInCategory(ch, category)),
      };
    }).filter((rail) => rail.channels.length > 0);

    // Fallback: If channels exist but didn't match any specific category rail, show them in a general rail
    if (catRails.length === 0 && channels.length > 0) {
      return [
        {
          category: {
            slug: "all-channels",
            name: "All Channels",
            title: "Live Stream Channels",
            badge: "📺",
            flag: "📺",
            subtitle: "All Available Live Streams",
            description: "All live channels",
            image: "",
            filterType: "category" as const,
            filterValues: [],
          },
          title: "All Live Channels",
          channels,
        },
      ];
    }

    return catRails;
  }, [channels]);

  return (
    <div className="min-h-screen bg-[#060b13] text-slate-100 flex flex-col">
      <Header />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8 space-y-7 sm:space-y-10">
        {/* Live Sports Arena Feed */}
        <LiveSportsArena />

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
