"use client";

import Link from "next/link";

export default function Header() {
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

        {/* Live banner — cropped to its text, sized so the visible glyphs
            match the brand logo's visible height, right-aligned */}
        <div className="ml-auto flex items-center shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/header-banner.png"
            alt="লাইভ খেলা ও টিভি দেখুন"
            className="h-[24px] sm:h-[27px] w-auto object-contain"
          />
        </div>
      </div>
    </header>
  );
}
