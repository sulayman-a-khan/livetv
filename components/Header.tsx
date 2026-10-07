"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { APP_DOWNLOAD_URL, isEmbeddedApp } from "@/lib/appRuntime";

interface HeaderProps {
  /**
   * The player and arena pages let their content run to 1400px; without this
   * the logo and the download CTA stay inset at 1280px and no longer line up
   * with the edges of the screen below them.
   */
  wide?: boolean;
}

export default function Header({ wide = false }: HeaderProps) {
  const [showPromo, setShowPromo] = useState(false);

  useEffect(() => {
    setShowPromo(!isEmbeddedApp());
  }, []);

  return (
    <header className="sticky top-0 z-50 bg-[#070d18]/90 backdrop-blur-md border-b border-slate-800/80">
      <div
        className={`${wide ? "max-w-[1400px]" : "max-w-7xl"} mx-auto px-4 sm:px-6 lg:px-8 h-16 sm:h-[72px] lg:h-[80px] flex items-center justify-between gap-3`}
      >
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
        {showPromo && (
          <div className="ml-auto flex items-center shrink-0">
            <Link
              href={APP_DOWNLOAD_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="মোবাইল অ্যাপটি ডাউনলোড করুন"
              className="block shrink-0"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/app-promo-banner.png"
                alt="মোবাইল অ্যাপটি ডাউনলোড করুন"
                className="h-[44px] sm:h-[52px] lg:h-[58px] w-auto object-contain select-none hover:scale-[1.04] active:scale-[0.99] transition-transform"
              />
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
