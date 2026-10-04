"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import MatchCard from "@/components/MatchCard";

export interface SportsEventCard {
  id: string;
  _id?: string;
  matchTitle: string;
  sportType: string;
  startTime: string;
  endTime: string;
  status: "scheduled" | "live" | "ended";
  primaryStreamUrl: string;
  streamUrl?: string;
  backupStreamUrls?: string[];
  isLocalServerActive?: boolean;
  priorityOrder?: number;
}

const SPORT_ICONS: Record<string, string> = {
  cricket: "🏏",
  football: "⚽",
  soccer: "⚽",
  basketball: "🏀",
  tennis: "🎾",
  badminton: "🏸",
  racing: "🏎️",
  "f1 / motorsport": "🏎️",
  motorsport: "🏎️",
  volleyball: "🏐",
  baseball: "⚾",
  hockey: "🏒",
  wrestling: "🤼",
  wwe: "🤼",
  boxing: "🥊",
  mma: "🥊",
  ufc: "🥊",
  kabaddi: "🏆",
};

function getSportIcon(sportType?: string): string {
  if (!sportType) return "🏆";
  const clean = sportType.toLowerCase().trim();
  for (const [key, icon] of Object.entries(SPORT_ICONS)) {
    if (clean.includes(key)) return icon;
  }
  return "🏆";
}

/** Card width: full on mobile, halves on sm, thirds on lg — extra cards scroll in the rail. */
const CARD_WIDTH = "w-full sm:w-[calc((100%-0.875rem)/2)] lg:w-[calc((100%-1.75rem)/3)]";

export default function LiveSportsArena() {
  const [events, setEvents] = useState<SportsEventCard[]>([]);
  const [loading, setLoading] = useState(true);
  const railRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const loadSportsEvents = async () => {
    try {
      const t = Date.now();
      const res = await fetch(`/api/events?_t=${t}`, {
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
      });

      let rawData: any = null;
      if (res.ok) {
        rawData = await res.json();
      } else {
        // Fallback to /api/sports/events or /api/sports
        const altRes = await fetch(`/api/sports/events?_t=${t}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate", Pragma: "no-cache" },
        }).catch(() => null);

        if (altRes && altRes.ok) {
          rawData = await altRes.json();
        } else {
          const fbRes = await fetch(`/api/sports?_t=${t}`, {
            cache: "no-store",
            headers: { "Cache-Control": "no-cache, no-store, must-revalidate", Pragma: "no-cache" },
          }).catch(() => null);
          if (fbRes && fbRes.ok) {
            rawData = await fbRes.json();
          }
        }
      }

      if (rawData) {
        const list: SportsEventCard[] = Array.isArray(rawData)
          ? rawData
          : Array.isArray(rawData?.events)
          ? rawData.events
          : Array.isArray(rawData?.matches)
          ? rawData.matches
          : Array.isArray(rawData?.data)
          ? rawData.data
          : Array.isArray(rawData?.items)
          ? rawData.items
          : [];
        setEvents(list);
      }
    } catch (err) {
      console.warn("Live Sports Arena fetch fallback:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSportsEvents();
    const interval = setInterval(() => loadSportsEvents(), 15_000);
    return () => clearInterval(interval);
  }, []);

  const updateArrows = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setIsOverflowing(scrollWidth > clientWidth + 2);
    setCanLeft(scrollLeft > 4);
    setCanRight(scrollLeft + clientWidth < scrollWidth - 4);
  }, []);

  useEffect(() => {
    updateArrows();
    const el = railRef.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateArrows);
      return () => window.removeEventListener("resize", updateArrows);
    }
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateArrows, loading, events.length]);

  const scrollByPage = (dir: 1 | -1) => {
    const el = railRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.8, 200), behavior: "smooth" });
  };

  if (!loading && events.length === 0) {
    return (
      <section className="animate-fade-in">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/arena-promo-banner.png"
          alt="SoluPlay — লাইভ খেলা ৩ টিভি দেখুন"
          className="w-full h-auto rounded-3xl border border-emerald-500/20 shadow-2xl"
        />
      </section>
    );
  }

  return (
    <section className="rounded-3xl border border-emerald-500/20 bg-gradient-to-b from-[#091523] via-[#060e1a] to-[#040810] p-4 sm:p-6 shadow-2xl animate-fade-in">
      {loading && events.length === 0 ? (
        <div className="flex flex-wrap justify-center gap-3.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`${CARD_WIDTH} rounded-2xl border border-slate-800 bg-[#0a1322] aspect-video animate-pulse`} />
          ))}
        </div>
      ) : (
        <div className="relative">
          <div
            ref={railRef}
            onScroll={updateArrows}
            className={`flex gap-3.5 overflow-x-auto scrollbar-none scroll-smooth snap-x snap-mandatory pt-1 pb-2 ${
              isOverflowing ? "justify-start" : "justify-center"
            }`}
          >
            {events.map((ev) => (
              <div key={ev.id || ev._id || "event"} className={`${CARD_WIDTH} shrink-0 snap-start`}>
                <MatchCard event={ev} icon={getSportIcon(ev.sportType)} />
              </div>
            ))}
          </div>

          {isOverflowing && canLeft && (
            <button
              type="button"
              aria-label="Scroll match cards left"
              onClick={() => scrollByPage(-1)}
              className="hidden sm:flex absolute left-1 top-1/2 -translate-y-1/2 z-20 w-8 h-8 items-center justify-center rounded-lg border border-slate-700 bg-[#0d1628]/95 text-slate-300 shadow-lg hover:border-emerald-500/60 hover:text-white transition-all cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
          {isOverflowing && canRight && (
            <button
              type="button"
              aria-label="Scroll match cards right"
              onClick={() => scrollByPage(1)}
              className="hidden sm:flex absolute right-1 top-1/2 -translate-y-1/2 z-20 w-8 h-8 items-center justify-center rounded-lg border border-slate-700 bg-[#0d1628]/95 text-slate-300 shadow-lg hover:border-emerald-500/60 hover:text-white transition-all cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
