"use client";

import { useEffect, useRef, useState } from "react";
import { isEmbeddedApp } from "@/lib/appRuntime";

// Speed is fixed in px/s and the duration is derived from the measured copy,
// because Bengali falls back to system fonts here and glyph widths differ per device.
const PIXELS_PER_SECOND = 55;

// Text fades in on the left and out on the right instead of hard-clipping at the frame.
const EDGE_FADE =
  "linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)";

export default function NewsTicker({ text }: { text: string }) {
  const copyRef = useRef<HTMLParagraphElement>(null);
  const [seconds, setSeconds] = useState(30);
  // Decided after mount, so server and client markup can never disagree.
  const [show, setShow] = useState(false);

  useEffect(() => {
    setShow(!isEmbeddedApp());
  }, []);

  useEffect(() => {
    const copy = copyRef.current;
    if (!copy) return;
    const width = copy.getBoundingClientRect().width;
    if (width > 0) setSeconds(Math.max(10, width / PIXELS_PER_SECOND));
  }, [text, show]);

  if (!show) return null;

  return (
    <div className="relative overflow-hidden border border-amber-500/35 bg-[#1c1206]">
      <div
        className="overflow-hidden"
        style={{ WebkitMaskImage: EDGE_FADE, maskImage: EDGE_FADE }}
      >
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
              className="whitespace-nowrap px-8 py-1.5 text-[13px] sm:text-sm font-semibold leading-relaxed text-amber-200"
            >
              {text}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
