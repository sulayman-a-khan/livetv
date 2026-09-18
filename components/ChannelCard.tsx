"use client";

import Link from "next/link";
import { getChannelLogo } from "@/lib/utils";

interface ChannelCardProps {
  id: string;
  name: string;
  logo: string;
  category?: string;
  subCategory?: string;
  country?: string;
  activeStreamCount?: number;
  categorySlug?: string;
}

export default function ChannelCard({
  id,
  name,
  logo,
  categorySlug,
}: ChannelCardProps) {
  const displayLogo = getChannelLogo(name, logo);
  const watchUrl = categorySlug ? `/watch/${id}?category=${categorySlug}` : `/watch/${id}`;

  return (
    <Link
      href={watchUrl}
      className="relative rounded-3xl border border-slate-800/80 bg-gradient-to-b from-[#0d1627] to-[#080d19] hover:border-emerald-500/60 hover:shadow-2xl hover:shadow-emerald-500/15 transition-all duration-300 p-5 sm:p-6 flex flex-col items-center justify-center group overflow-hidden"
    >
      {/* Background Subtle Glow on Hover */}
      <div className="absolute inset-0 bg-gradient-to-tr from-emerald-500/0 via-emerald-500/0 to-emerald-500/10 group-hover:to-emerald-500/20 transition-colors pointer-events-none" />

      {/* Prominent Large Circular White Logo Frame */}
      <div className="relative w-28 h-28 sm:w-32 sm:h-32 rounded-full bg-white p-4 flex items-center justify-center overflow-hidden mb-4 shadow-xl border-2 border-slate-700/40 group-hover:border-emerald-400 group-hover:scale-105 transition-all duration-300 shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={displayLogo}
          alt={name}
          className="max-w-full max-h-full object-contain filter drop-shadow-sm"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            if (!target.dataset.fallback) {
              target.dataset.fallback = "true";
              const initials = name
                .replace(/[^a-zA-Z0-9\s]/g, "")
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .map((w) => w[0])
                .join("")
                .toUpperCase() || name.substring(0, 2).toUpperCase();
              target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(
                initials
              )}&background=0284c7&color=ffffff&size=200&bold=true`;
            }
          }}
        />
      </div>

      {/* Channel Title */}
      <h3 className="font-extrabold text-white text-sm sm:text-base text-center line-clamp-1 w-full group-hover:text-emerald-300 transition-colors">
        {name}
      </h3>
    </Link>
  );
}

