"use client";

import Link from "next/link";
import { Search } from "lucide-react";

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
        <Link href="/" className="flex items-center group shrink-0 py-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/logo.png"
            alt="SoluPlay"
            className="h-7 sm:h-8 w-auto object-contain group-hover:scale-105 transition-transform"
          />
        </Link>

        {/* Search Bar - compact & docked right on mobile, expands from sm: up */}
        <div className="ml-auto w-28 sm:w-auto sm:ml-0 sm:flex-1 sm:max-w-md">
          <form
            onSubmit={(e) => {
              if (onSearchSubmit) onSearchSubmit(e);
              else e.preventDefault();
            }}
            className="relative"
          >
            <Search className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400 absolute left-2.5 sm:left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery && setSearchQuery(e.target.value)}
              className="w-full bg-[#0d1527] text-[11px] sm:text-sm text-slate-100 placeholder-slate-400 pl-8 sm:pl-10 pr-3 sm:pr-4 py-1.5 sm:py-2 rounded-lg sm:rounded-xl border border-slate-700/60 focus:outline-none focus:border-emerald-500/80 focus:ring-1 focus:ring-emerald-500/50 transition-all shadow-inner"
            />
          </form>
        </div>
      </div>
    </header>
  );
}
