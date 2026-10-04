"use client";

import { useEffect, useState } from "react";
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

/** Card width: full on mobile, halves on sm, thirds on lg — rows stay centered via flex wrap. */
const CARD_WIDTH = "w-full sm:w-[calc((100%-0.875rem)/2)] lg:w-[calc((100%-1.75rem)/3)]";

export default function LiveSportsArena() {
  const [events, setEvents] = useState<SportsEventCard[]>([]);
  const [loading, setLoading] = useState(true);

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

  if (!loading && events.length === 0) return null;

  return (
    <section className="rounded-3xl border border-emerald-500/20 bg-gradient-to-b from-[#091523] via-[#060e1a] to-[#040810] p-4 sm:p-6 shadow-2xl animate-fade-in">
      {loading && events.length === 0 ? (
        <div className="flex flex-wrap justify-center gap-3.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`${CARD_WIDTH} rounded-2xl border border-slate-800 bg-[#0a1322] aspect-video animate-pulse`} />
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap justify-center gap-3.5">
          {events.map((ev) => (
            <div key={ev.id || ev._id || "event"} className={CARD_WIDTH}>
              <MatchCard event={ev} icon={getSportIcon(ev.sportType)} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
