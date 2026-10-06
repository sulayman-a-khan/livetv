"use client";

import { useEffect, useRef, useState } from "react";

// Speed is fixed in px/s and the duration is derived from the measured copy,
// because Bengali falls back to system fonts here and glyph widths differ per device.
const PIXELS_PER_SECOND = 55;

export default function NewsTicker({ text }: { text: string }) {
  const copyRef = useRef<HTMLParagraphElement>(null);
  const [seconds, setSeconds] = useState(30);

  useEffect(() => {
    const copy = copyRef.current;
    if (!copy) return;
    const width = copy.getBoundingClientRect().width;
    if (width > 0) setSeconds(Math.max(10, width / PIXELS_PER_SECOND));
  }, [text]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-amber-500/35 bg-[#1c1206]">
      <div
        className="animate-news-ticker flex w-max"
        style={{ animationDuration: `${seconds}s` }}
      >
        {[0, 1].map((i) => (
          <p
            key={i}
            ref={i === 0 ? copyRef : undefined}
            lang="bn"
            aria-hidden={i === 1 || undefined}
            className="whitespace-nowrap px-8 py-2.5 text-[13px] sm:text-sm font-semibold leading-relaxed text-amber-200"
          >
            {text}
          </p>
        ))}
      </div>
    </div>
  );
}
