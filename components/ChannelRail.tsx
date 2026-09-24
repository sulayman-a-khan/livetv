"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ArrowRight } from "lucide-react";
import { getChannelLogo } from "@/lib/utils";

export interface RailChannel {
  _id: string;
  name: string;
  logo: string;
}

interface ChannelRailProps {
  /** Row heading, e.g. "Sports Channels". */
  title: string;
  /** Small accent shown before the title (emoji badge). */
  accent?: string;
  /** Category slug — used for the watch deep-link and the "See all" href. */
  categorySlug: string;
  channels: RailChannel[];
}

/**
 * A single premium horizontal "rail" of channel icons for one category.
 * The row scrolls/swipes left–right when the channels overflow the viewport;
 * on desktop, hover arrow buttons sweep it too. Edge fade masks hint that
 * there's more to scroll.
 */
export default function ChannelRail({ title, accent, categorySlug, channels }: ChannelRailProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const updateArrows = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanLeft(scrollLeft > 4);
    setCanRight(scrollLeft + clientWidth < scrollWidth - 4);
  }, []);

  useEffect(() => {
    updateArrows();
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateArrows, channels.length]);

  const scrollByPage = (dir: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.8, 200), behavior: "smooth" });
  };

  if (channels.length === 0) return null;

  return (
    <section className="space-y-3">
      {/* Row header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {accent && (
            <span className="shrink-0 w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-[#0d1628] border border-slate-800 flex items-center justify-center text-base sm:text-lg shadow-inner">
              {accent}
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-sm sm:text-lg font-black text-white tracking-tight truncate">
              {title}
            </h2>
            <p className="text-[10px] sm:text-xs font-medium text-slate-500 truncate">
              {channels.length} live channel{channels.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {/* Desktop sweep arrows */}
          <button
            type="button"
            aria-label={`Scroll ${title} left`}
            onClick={() => scrollByPage(-1)}
            disabled={!canLeft}
            className="hidden sm:flex w-8 h-8 items-center justify-center rounded-lg border border-slate-800 bg-[#0d1628] text-slate-300 hover:border-emerald-500/60 hover:text-white disabled:opacity-30 disabled:hover:border-slate-800 transition-all"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            aria-label={`Scroll ${title} right`}
            onClick={() => scrollByPage(1)}
            disabled={!canRight}
            className="hidden sm:flex w-8 h-8 items-center justify-center rounded-lg border border-slate-800 bg-[#0d1628] text-slate-300 hover:border-emerald-500/60 hover:text-white disabled:opacity-30 disabled:hover:border-slate-800 transition-all"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          <Link
            href={`/category/${categorySlug}`}
            className="group inline-flex items-center gap-1 text-[11px] sm:text-xs font-bold text-emerald-400 hover:text-emerald-300 pl-1 sm:pl-2 transition-colors"
          >
            <span className="hidden sm:inline">See all</span>
            <ArrowRight className="w-3.5 h-3.5 stroke-[2.5] group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </div>
      </div>

      {/* Scrolling rail */}
      <div className="relative -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8">
        {/* Edge fade masks */}
        {canLeft && (
          <div className="pointer-events-none absolute left-0 top-0 bottom-2 w-8 sm:w-12 bg-gradient-to-r from-[#060b13] to-transparent z-10" />
        )}
        {canRight && (
          <div className="pointer-events-none absolute right-0 top-0 bottom-2 w-8 sm:w-12 bg-gradient-to-l from-[#060b13] to-transparent z-10" />
        )}

        <div
          ref={scrollerRef}
          onScroll={updateArrows}
          className="flex items-start gap-3 sm:gap-4 overflow-x-auto scrollbar-none snap-x snap-mandatory scroll-smooth pb-2 pt-1"
        >
          {channels.map((channel) => {
            const logo = getChannelLogo(channel.name, channel.logo);
            return (
              <Link
                key={channel._id}
                href={`/watch/${channel._id}?category=${categorySlug}`}
                className="group shrink-0 snap-start w-[78px] sm:w-[104px] flex flex-col items-center gap-2 focus:outline-none"
              >
                <div className="relative">
                  {/* Circular white logo frame */}
                  <div className="w-[62px] h-[62px] sm:w-[84px] sm:h-[84px] rounded-full bg-white p-1.5 sm:p-2 flex items-center justify-center overflow-hidden shadow-lg border-2 border-slate-700/40 group-hover:border-emerald-400 group-hover:scale-105 group-hover:shadow-emerald-500/25 transition-all duration-300">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={logo}
                      alt={channel.name}
                      loading="lazy"
                      className="max-w-full max-h-full object-contain"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        if (!target.dataset.fallback) {
                          target.dataset.fallback = "true";
                          target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(
                            channel.name.substring(0, 2).toUpperCase()
                          )}&background=0284c7&color=ffffff&size=200&bold=true`;
                        }
                      }}
                    />
                  </div>
                  {/* Live indicator */}
                  <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full bg-emerald-500 border-2 border-[#060b13] flex items-center justify-center">
                    <span className="w-1 h-1 sm:w-1.5 sm:h-1.5 rounded-full bg-white animate-pulse" />
                  </span>
                </div>

                <span className="w-full text-[10px] sm:text-xs font-bold text-slate-300 group-hover:text-white text-center line-clamp-2 leading-tight transition-colors">
                  {channel.name}
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
