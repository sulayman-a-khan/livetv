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

        {/* App promo banner — asset is trimmed to its visible ink so the
            height classes below are the real on-screen height */}
        <div className="ml-auto flex items-center shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/app-promo-banner.png"
            alt="মোবাইল অ্যাপটি ডাউনলোড করুন"
            className="h-[34px] sm:h-[42px] lg:h-[48px] w-auto object-contain select-none"
          />
        </div>
      </div>
    </header>
  );
}
