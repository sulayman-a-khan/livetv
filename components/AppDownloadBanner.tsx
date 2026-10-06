"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { APP_DOWNLOAD_URL, isEmbeddedApp } from "@/lib/appRuntime";

/** App-download promo shown above the footer, phones only. */
export default function AppDownloadBanner() {
  const [isPhone, setIsPhone] = useState(false);

  useEffect(() => {
    if (isEmbeddedApp()) return;
    const mq = window.matchMedia("(max-width: 767px)");
    const sync = () => setIsPhone(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);

  if (!isPhone) return null;

  return (
    <section className="w-full max-w-7xl mx-auto px-4 pb-6">
      <Link
        href={APP_DOWNLOAD_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="আমাদের মোবাইল অ্যাপ ডাউনলোড করুন"
        className="block"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/app-download-banner.png"
          alt="নিরবিচ্ছিন্ন লাইভ খেলা ও টিভি দেখতে আমাদের মোবাইল অ্যাপ ডাউনলোড করুন"
          className="w-full h-auto rounded-2xl border border-slate-800/80 select-none active:scale-[0.99] transition-transform"
        />
      </Link>
    </section>
  );
}
