"use client";

import Link from "next/link";
import { Search, Tv } from "lucide-react";

interface HeaderProps {
  searchQuery?: string;
  setSearchQuery?: (q: string) => void;
  onSearchSubmit?: (e: React.FormEvent) => void;
}

export default function Header({
  searchQuery = "",
  setSearchQuery,
  onSearchSubmit,
}: HeaderProps) {
  return (
    <header className="sticky top-0 z-50 bg-[#070d18]/90 backdrop-blur-md border-b border-slate-800/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-3">
        {/* Brand Logo */}
        <Link href="/" className="flex items-center gap-2.5 group shrink-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-600 via-emerald-500 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/20 group-hover:scale-105 transition-transform">
            <Tv className="w-5 h-5 text-white stroke-[2.2]" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xl font-black tracking-tight text-white">
              Free<span className="text-emerald-400 font-extrabold">TV</span>
            </span>
          </div>
        </Link>

        {/* Search Bar */}
        <div className="flex-1 max-w-md">
          <form
            onSubmit={(e) => {
              if (onSearchSubmit) onSearchSubmit(e);
              else e.preventDefault();
            }}
            className="relative"
          >
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery && setSearchQuery(e.target.value)}
              className="w-full bg-[#0d1527] text-xs sm:text-sm text-slate-100 placeholder-slate-400 pl-10 pr-4 py-2 rounded-xl border border-slate-700/60 focus:outline-none focus:border-emerald-500/80 focus:ring-1 focus:ring-emerald-500/50 transition-all shadow-inner"
            />
          </form>
        </div>
      </div>
    </header>
  );
}
