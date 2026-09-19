"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import { CATEGORIES } from "@/lib/categories";
import { ArrowRight } from "lucide-react";

/**
 * Mobile category buttons. `flagCode` is an ISO-3166 alpha-2 code rendered as a
 * real country flag image; categories that aren't a country fall back to an icon.
 */
const MOBILE_CATEGORY_BUTTONS: {
  label: string;
  href: string;
  flagCode?: string;
  icon?: string;
}[] = [
  { label: "Bangladesh", href: "/category/bangladeshi-tv", flagCode: "bd", icon: "\ud83c\udde7\ud83c\udde9" },
  { label: "India", href: "/category/indian-tv", flagCode: "in", icon: "\ud83c\uddee\ud83c\uddf3" },
  { label: "Pakistan", href: "/category/pakistani-tv", flagCode: "pk", icon: "\ud83c\uddf5\ud83c\uddf0" },
  { label: "Sports", href: "/category/sports-tv", icon: "\u26bd" },
  { label: "News", href: "/category/news-tv", icon: "\ud83d\udcf0" },
  { label: "Global", href: "/category/global-tv", icon: "\ud83c\udf0d" },
];

export default function HomePage() {
  const [searchQuery, setSearchQuery] = useState("");
  const router = useRouter();

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    // Route to sports or default category with search query or search first category
    router.push(`/category/sports-tv?search=${encodeURIComponent(searchQuery)}`);
  };

  return (
    <div className="min-h-screen bg-[#060b13] text-slate-100 flex flex-col">
      <Header
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        onSearchSubmit={handleSearchSubmit}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-6 sm:space-y-8">
        {/* Top Hero Banner Section */}
        <section className="relative rounded-3xl overflow-hidden border border-slate-800/80 bg-gradient-to-r from-[#0a1222] via-[#0d172c] to-[#0f1d38] shadow-2xl">
          {/* Subtle ambient light glow */}
          <div className="absolute top-0 right-1/4 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute bottom-0 left-10 w-72 h-72 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />

          <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[220px] sm:min-h-[300px]">
            {/* Left Hero Content - hidden on mobile, only the hero banner image shows */}
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
                Choose Your Category to Start Watching
              </p>

              {/* Green accent line */}
              <div className="w-16 h-1 bg-emerald-400 rounded-full mt-3 shadow-md shadow-emerald-500/50" />
            </div>

            {/* Right Hero Graphic Montage */}
            <div className="lg:col-span-6 relative overflow-hidden flex items-center justify-center min-h-[220px] lg:min-h-full">
              {/* Montage Background Image with soft gradient blending on left */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/hero_banner.png"
                alt="Live TV Portal Category Montage"
                className="absolute inset-0 w-full h-full object-cover object-center opacity-90 filter saturate-[1.1]"
              />
              <div className="absolute inset-0 bg-gradient-to-r from-[#0a1222] via-[#0a1222]/40 to-transparent lg:block hidden" />
              <div className="absolute inset-0 bg-gradient-to-t from-[#0a1222] via-transparent to-transparent lg:hidden" />
            </div>
          </div>
        </section>

        {/* ===== Mobile Only: 3-per-row Flag Category Buttons (replaces the cards) ===== */}
        <section className="sm:hidden">
          <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3">
            Browse Categories
          </h2>
          <div className="grid grid-cols-3 gap-3">
            {MOBILE_CATEGORY_BUTTONS.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className="group flex flex-col items-center justify-center gap-2 rounded-2xl border border-slate-800 bg-[#0d1628] px-2 py-4 shadow-md active:scale-[0.97] hover:border-emerald-500/60 transition-all"
              >
                {/* Country flag (or icon fallback for non-country categories) */}
                <span className="relative w-12 h-12 rounded-full overflow-hidden bg-[#070d18] border border-slate-700 flex items-center justify-center shadow-inner group-hover:border-emerald-500/60 transition-colors">
                  {/* Emoji sits underneath and shows through if the flag image fails */}
                  <span className="text-2xl leading-none">{item.icon}</span>
                  {item.flagCode && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={`https://flagcdn.com/w80/${item.flagCode}.png`}
                      srcSet={`https://flagcdn.com/w160/${item.flagCode}.png 2x`}
                      alt={`${item.label} flag`}
                      loading="lazy"
                      className="absolute inset-0 w-full h-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  )}
                </span>
                <span className="text-[11px] font-bold text-slate-200 text-center leading-tight">
                  {item.label}
                </span>
              </Link>
            ))}
          </div>
        </section>

        {/* Category Cards Section - hidden on mobile (flag buttons are used there instead) */}
        <section className="hidden sm:block space-y-4">
          <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest">
            Browse Categories
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-5">
            {CATEGORIES.map((category) => (
              <Link
                key={category.slug}
                href={`/category/${category.slug}`}
                className="group relative rounded-2xl p-[1.5px] bg-gradient-to-br from-slate-800 via-slate-800 to-slate-800 hover:from-blue-500 hover:via-cyan-400 hover:to-emerald-400 transition-colors duration-300"
              >
                <div className="relative rounded-[15px] bg-[#0b1220] overflow-hidden flex items-center gap-4 p-3.5 lg:p-4 h-full">
                  {/* Thumbnail tile */}
                  <div className="relative w-20 h-20 lg:w-24 lg:h-24 rounded-xl overflow-hidden shrink-0 border border-slate-800">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={category.image}
                      alt={category.name}
                      className="w-full h-full object-cover object-center group-hover:scale-110 transition-transform duration-500 filter saturate-[1.15]"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
                    <span className="absolute bottom-1 left-1 w-6 h-6 rounded-full bg-slate-950/90 backdrop-blur-sm border border-slate-700/80 flex items-center justify-center text-xs shadow-md">
                      {category.badge}
                    </span>
                  </div>

                  {/* Text content */}
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm lg:text-base font-black text-white tracking-tight truncate group-hover:text-transparent group-hover:bg-clip-text group-hover:bg-gradient-to-r group-hover:from-blue-400 group-hover:via-cyan-300 group-hover:to-emerald-400 transition-colors">
                      {category.title}
                    </h3>
                    <p className="text-[11px] lg:text-xs text-slate-400 font-medium line-clamp-1 mt-0.5">
                      {category.subtitle}
                    </p>
                  </div>

                  {/* Gradient arrow chip */}
                  <div className="w-8 h-8 lg:w-9 lg:h-9 rounded-full bg-slate-900 border border-slate-700/80 group-hover:border-transparent group-hover:bg-gradient-to-tr group-hover:from-blue-500 group-hover:via-cyan-400 group-hover:to-emerald-400 text-slate-400 group-hover:text-slate-950 flex items-center justify-center shrink-0 transition-all group-hover:scale-105">
                    <ArrowRight className="w-4 h-4 stroke-[2.5] group-hover:translate-x-0.5 transition-transform" />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-[#070d18] py-4 text-center text-xs text-slate-400">
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
