"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Header from "@/components/Header";
import {
  getCategoryBySlug,
  isChannelInCategory,
  CATEGORIES,
  GENRE_FILTERS,
  GenreFilter,
  matchesGenreFilter,
} from "@/lib/categories";
import { getChannelLogo } from "@/lib/utils";
import { ArrowLeft, RefreshCw, AlertCircle, Tv, Play, Radio, Search } from "lucide-react";

interface ChannelItem {
  _id: string;
  name: string;
  logo: string;
  category: string;
  subCategory?: string;
  country: string;
  activeStreamCount: number;
}

export default function CategoryPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const slug = (params?.slug as string) || "";
  const categoryConfig = getCategoryBySlug(slug);

  const [categoryChannels, setCategoryChannels] = useState<ChannelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState(searchParams.get("search") || "");
  const [activeGenre, setActiveGenre] = useState<GenreFilter>("all");

  useEffect(() => {
    async function loadCategoryChannels() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/channels");
        const data = await res.json();
        if (data.success && Array.isArray(data.channels)) {
          if (categoryConfig) {
            const filtered = data.channels.filter((ch: ChannelItem) =>
              isChannelInCategory(ch, categoryConfig)
            );
            setCategoryChannels(filtered);
          } else {
            setCategoryChannels(data.channels);
          }
        } else {
          setError("Failed to load channel directory");
        }
      } catch (err: any) {
        setError(err.message || "Network error loading channels");
      } finally {
        setLoading(false);
      }
    }

    loadCategoryChannels();
  }, [slug, categoryConfig]);

  // Dynamic counts for each genre pill
  const genreCounts = useMemo(() => {
    const counts: Record<GenreFilter, number> = {
      all: categoryChannels.length,
      news: 0,
      entertainment: 0,
      sports: 0,
    };

    for (const ch of categoryChannels) {
      if (matchesGenreFilter(ch, "news")) counts.news++;
      if (matchesGenreFilter(ch, "entertainment")) counts.entertainment++;
      if (matchesGenreFilter(ch, "sports")) counts.sports++;
    }

    return counts;
  }, [categoryChannels]);

  // Filter channels by active genre and search query
  const displayedChannels = useMemo(() => {
    let result = categoryChannels;

    // Filter by genre
    if (activeGenre !== "all") {
      result = result.filter((c) => matchesGenreFilter(c, activeGenre));
    }

    // Filter by search query if present
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.category && c.category.toLowerCase().includes(q)) ||
          (c.subCategory && c.subCategory.toLowerCase().includes(q))
      );
    }

    return result;
  }, [categoryChannels, activeGenre, searchQuery]);

  if (!categoryConfig) {
    return (
      <div className="min-h-screen bg-[#060b13] text-slate-100 flex flex-col">
        <Header />
        <main className="flex-1 max-w-7xl mx-auto px-4 py-16 text-center">
          <div className="max-w-md mx-auto p-8 rounded-3xl bg-[#0d1628] border border-slate-800">
            <AlertCircle className="w-12 h-12 text-amber-400 mx-auto mb-4" />
            <h1 className="text-xl font-black text-white mb-2">Category Not Found</h1>
            <p className="text-xs text-slate-400 mb-6">
              The category you requested does not exist. Please return to the homepage.
            </p>
            <Link
              href="/"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#00c978] hover:bg-[#00db84] text-slate-950 font-bold text-xs shadow-lg transition-all"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back to Home</span>
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#060b13] text-slate-100 flex flex-col">
      <Header
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Top Back to Home Button */}
        <div>
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-white transition-colors group"
          >
            <div className="w-7 h-7 rounded-lg bg-[#0d1628] border border-slate-800 flex items-center justify-center group-hover:border-emerald-500 transition-colors">
              <ArrowLeft className="w-4 h-4 text-slate-400 group-hover:text-emerald-400" />
            </div>
            <span>Back to Home</span>
          </Link>
        </div>

        {/* Category Header Banner */}
        <section className="rounded-2xl border border-slate-800/80 bg-[#0a1222] p-5 sm:p-6 shadow-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            {/* Category Round Badge / Flag */}
            <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-slate-900 border border-slate-700/80 flex items-center justify-center text-2xl sm:text-3xl shrink-0 shadow-lg">
              <span>{categoryConfig.badge}</span>
            </div>

            {/* Title & Description */}
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight">
                {categoryConfig.title}
              </h1>
              <p className="text-xs sm:text-sm text-slate-400 font-normal mt-0.5 max-w-2xl">
                {categoryConfig.description}
              </p>
            </div>
          </div>

          {/* Right Channel Count Badge */}
          <div className="shrink-0 self-start sm:self-center">
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#0d172e] border border-emerald-500/40 text-emerald-400 text-xs font-bold shadow-md">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>{categoryChannels.length} Channels</span>
            </div>
          </div>
        </section>

        {/* In-Page Sub-Category / Genre Filter Tabs */}
        <section className="grid grid-cols-4 gap-1.5 sm:flex sm:items-center sm:gap-3 sm:overflow-x-auto sm:scrollbar-none pb-1">
          {GENRE_FILTERS.map((filter) => {
            const isActive = activeGenre === filter.id;
            const count = genreCounts[filter.id] || 0;

            return (
              <button
                key={filter.id}
                onClick={() => setActiveGenre(filter.id)}
                className={`flex sm:inline-flex items-center justify-center gap-1 sm:gap-2 px-1.5 sm:px-4 py-2 sm:py-2.5 rounded-lg sm:rounded-xl text-[10px] sm:text-xs font-bold transition-all min-w-0 sm:shrink-0 cursor-pointer ${
                  isActive
                    ? "bg-[#00c978] text-slate-950 shadow-lg shadow-emerald-500/25 ring-2 ring-emerald-400/50 sm:scale-[1.02]"
                    : "bg-[#0d1628] text-slate-300 border border-slate-800 hover:border-slate-700 hover:text-white hover:bg-[#111c34]"
                }`}
              >
                <span className="shrink-0">{filter.icon}</span>
                <span className="truncate">{filter.label}</span>
                <span
                  className={`hidden sm:inline text-[10px] font-extrabold px-2 py-0.5 rounded-full ${
                    isActive
                      ? "bg-slate-950/20 text-slate-950"
                      : "bg-slate-900 border border-slate-700/80 text-slate-400"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </section>

        {/* Channels Grid Section */}
        {loading ? (
          <div className="rounded-2xl border border-slate-800 bg-[#0a1222] p-16 text-center max-w-md mx-auto my-8">
            <RefreshCw className="w-10 h-10 text-emerald-400 animate-spin mx-auto mb-3" />
            <p className="text-sm font-bold text-white">Loading {categoryConfig.title} Streams...</p>
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-slate-800 bg-[#0a1222] p-10 text-center max-w-md mx-auto my-8">
            <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <h3 className="text-base font-bold text-white mb-1">Error Loading Channels</h3>
            <p className="text-xs text-slate-400 mb-4">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold"
            >
              Retry
            </button>
          </div>
        ) : displayedChannels.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-[#0a1222] p-16 text-center max-w-md mx-auto my-8">
            <Tv className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <h3 className="text-base font-bold text-white mb-1">No Channels Found</h3>
            <p className="text-xs text-slate-400 mt-1">
              {searchQuery
                ? `No channels matching "${searchQuery}" in this section.`
                : `No channels found under "${activeGenre}" for this category.`}
            </p>
            {activeGenre !== "all" && (
              <button
                onClick={() => setActiveGenre("all")}
                className="mt-4 px-4 py-2 bg-[#00c978] text-slate-950 rounded-xl text-xs font-bold hover:bg-[#00db84] transition-all"
              >
                View All {categoryChannels.length} Channels
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 gap-2.5 sm:gap-6 animate-fade-in">
            {displayedChannels.map((channel) => {
              const displayLogo = getChannelLogo(channel.name, channel.logo);

              return (
                <Link
                  key={channel._id}
                  href={`/watch/${channel._id}?category=${categoryConfig.slug}`}
                  className="relative rounded-2xl sm:rounded-3xl border border-slate-800/80 bg-gradient-to-b from-[#0d1627] to-[#080d19] hover:border-emerald-500/60 hover:shadow-2xl hover:shadow-emerald-500/15 transition-all duration-300 p-2.5 sm:p-6 flex flex-col items-center justify-center group overflow-hidden"
                >
                  {/* Background Glow */}
                  <div className="absolute inset-0 bg-gradient-to-tr from-emerald-500/0 via-emerald-500/0 to-emerald-500/10 group-hover:to-emerald-500/20 transition-colors pointer-events-none" />

                  {/* Prominent Large Circular White Logo Frame */}
                  <div className="relative w-14 h-14 sm:w-32 sm:h-32 rounded-full bg-white p-2 sm:p-4 flex items-center justify-center overflow-hidden mb-2 sm:mb-4 shadow-xl border-2 border-slate-700/40 group-hover:border-emerald-400 group-hover:scale-105 transition-all duration-300 shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={displayLogo}
                      alt={channel.name}
                      className="max-w-full max-h-full object-contain filter drop-shadow-sm"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        if (!target.dataset.fallback) {
                          target.dataset.fallback = "true";
                          const initials = channel.name.substring(0, 2).toUpperCase();
                          target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=0284c7&color=ffffff&size=200&bold=true`;
                        }
                      }}
                    />
                  </div>

                  {/* Channel Title */}
                  <h3 className="font-extrabold text-white text-[10px] sm:text-base text-center line-clamp-1 w-full group-hover:text-emerald-300 transition-colors">
                    {channel.name}
                  </h3>
                </Link>
              );
            })}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-[#070d18] py-4 text-center text-xs text-slate-400 mt-12">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>FreeTV • {categoryConfig.title} Stream Hub</span>
          <div className="flex items-center gap-4 text-slate-400">
            {CATEGORIES.map((c) => (
              <Link
                key={c.slug}
                href={`/category/${c.slug}`}
                className={c.slug === slug ? "text-emerald-400 font-bold" : "hover:text-white"}
              >
                {c.name}
              </Link>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
