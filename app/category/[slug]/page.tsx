"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import Header from "@/components/Header";
import { getCategoryBySlug, CATEGORIES } from "@/lib/categories";
import { getChannelLogo } from "@/lib/utils";
import { ArrowLeft, RefreshCw, AlertCircle, Tv } from "lucide-react";

interface ChannelItem {
  _id: string;
  name: string;
  logo: string;
  category: string;
  country: string;
  activeStreamCount: number;
}

export default function CategoryPage() {
  const params = useParams();
  const slug = (params?.slug as string) || "";
  const categoryConfig = getCategoryBySlug(slug);

  const [categoryChannels, setCategoryChannels] = useState<ChannelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadCategoryChannels() {
      setLoading(true);
      setError(null);
      try {
        // Ask the API for just this rail: it already knows the curated (pinned)
        // catalogue and the exact category, so the payload is this rail only
        // instead of the whole catalogue filtered in the browser.
        const url = categoryConfig
          ? `/api/channels?rail=${encodeURIComponent(slug)}`
          : "/api/channels";
        const res = await fetch(url);
        const data = await res.json();
        const list: ChannelItem[] = Array.isArray(data)
          ? data
          : Array.isArray(data?.channels)
          ? data.channels
          : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.items)
          ? data.items
          : [];

        setCategoryChannels(list);
      } catch (err: any) {
        setError(err.message || "Network error loading channels");
      } finally {
        setLoading(false);
      }
    }

    loadCategoryChannels();
  }, [slug, categoryConfig]);

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
      <Header />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Back button + category name + active channel count, unified bar */}
        <section className="flex items-center gap-3 rounded-2xl border border-slate-800/80 bg-[#0a1222] pl-3 pr-4 py-2.5 sm:py-3 shadow-lg">
          <Link
            href="/"
            aria-label="Back to Home"
            className="group shrink-0 w-9 h-9 rounded-xl bg-[#0d1628] border border-slate-800 flex items-center justify-center hover:border-transparent hover:bg-gradient-to-tr hover:from-blue-500 hover:via-cyan-400 hover:to-emerald-400 transition-all"
          >
            <ArrowLeft className="w-4 h-4 text-slate-400 group-hover:text-slate-950 transition-colors" />
          </Link>

          <div className="w-px h-6 bg-slate-800 shrink-0" />

          <span className="text-lg shrink-0">{categoryConfig.badge}</span>
          <h1 className="text-sm sm:text-lg font-black text-white tracking-tight truncate min-w-0">
            {categoryConfig.title}
          </h1>

          <span className="ml-auto inline-flex items-center gap-1.5 pl-3 sm:pl-4 py-1 sm:py-1.5 pr-1 sm:pr-1 rounded-full text-[11px] sm:text-xs font-bold text-emerald-400 shrink-0 border-l border-slate-800">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="hidden sm:inline">{categoryChannels.length} Active Channel{categoryChannels.length === 1 ? "" : "s"}</span>
            <span className="sm:hidden">{categoryChannels.length}</span>
          </span>
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
        ) : categoryChannels.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-[#0a1222] p-16 text-center max-w-md mx-auto my-8">
            <Tv className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <h3 className="text-base font-bold text-white mb-1">No Channels Yet</h3>
            <p className="text-xs text-slate-400 mt-1">
              {`No pinned channels are listed under ${categoryConfig.title} right now.`}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 gap-2.5 sm:gap-6 animate-fade-in">
            {categoryChannels.map((channel) => {
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
          <span>SoluPlay • {categoryConfig.title} Stream Hub</span>
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
