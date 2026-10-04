"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import {
  Trophy,
  Tv,
  Radio,
  Play,
  Clock,
  Flame,
  ChevronRight,
  RefreshCw,
  Sparkles,
  Signal,
  Calendar,
} from "lucide-react";
import { resolveStreamUrl } from "@/lib/streamUrl";

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

function formatMatchTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return "Live Soon";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
  } catch {
    return "Live Soon";
  }
}

function formatMatchDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return "Today";
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return "Today";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "Today";
  }
}

export default function LiveSportsArena() {
  const [events, setEvents] = useState<SportsEventCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeSportFilter, setActiveSportFilter] = useState("All");

  const loadSportsEvents = async (manual: boolean = false) => {
    if (manual) setIsRefreshing(true);
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
      if (manual) setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadSportsEvents();
    const interval = setInterval(() => loadSportsEvents(false), 15_000);
    return () => clearInterval(interval);
  }, []);

  const sportTypes = useMemo(() => {
    const types = new Set<string>();
    events.forEach((ev) => {
      if (ev.sportType) types.add(ev.sportType);
    });
    return ["All", ...Array.from(types)];
  }, [events]);

  const filteredEvents = useMemo(() => {
    if (activeSportFilter === "All") return events;
    return events.filter(
      (ev) => ev.sportType?.toLowerCase() === activeSportFilter.toLowerCase()
    );
  }, [events, activeSportFilter]);

  return (
    <section className="space-y-4 rounded-3xl border border-emerald-500/20 bg-gradient-to-b from-[#091523] via-[#060e1a] to-[#040810] p-4 sm:p-6 shadow-2xl relative overflow-hidden animate-fade-in">
      {/* Decorative Glow */}
      <div className="absolute top-0 right-0 -mt-8 -mr-8 w-64 h-64 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 left-0 -mb-8 -ml-8 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />

      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 relative z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-emerald-500 to-cyan-400 p-0.5 flex items-center justify-center shadow-lg shadow-emerald-500/20">
            <div className="w-full h-full bg-[#060e1a] rounded-[14px] flex items-center justify-center">
              <Flame className="w-5 h-5 text-emerald-400 animate-pulse" />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base sm:text-xl font-black text-white tracking-tight">
                Live Sports Arena
              </h2>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-rose-500/20 text-rose-400 border border-rose-500/30">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping" />
                Live Hub
              </span>
              <button
                onClick={() => loadSportsEvents(true)}
                title="Refresh Live Matches"
                className="p-1.5 rounded-lg bg-[#0d1728] border border-slate-800 text-slate-400 hover:text-emerald-400 hover:border-emerald-500/40 transition-all cursor-pointer ml-1"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin text-emerald-400" : ""}`} />
              </button>
            </div>
            <p className="text-xs text-slate-400">
              HD Match Feeds &amp; Direct Multi-Bitrate Streams
            </p>
          </div>
        </div>

        {/* Sport Type Filters */}
        {sportTypes.length > 2 && (
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none py-1">
            {sportTypes.map((type) => {
              const active = activeSportFilter === type;
              return (
                <button
                  key={type}
                  onClick={() => setActiveSportFilter(type)}
                  className={`px-3 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap ${
                    active
                      ? "bg-[#00c978] text-slate-950 shadow-md shadow-emerald-500/20"
                      : "bg-[#0d1728] text-slate-400 hover:text-white border border-slate-800 hover:border-slate-700"
                  }`}
                >
                  {type === "All" ? "🔥 All Matches" : `${getSportIcon(type)} ${type}`}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Content: Loading Skeleton vs Empty State vs Match Cards */}
      {loading && events.length === 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 relative z-10">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-2xl border border-slate-800 bg-[#0a1322] p-5 space-y-3 animate-pulse">
              <div className="flex justify-between items-center">
                <div className="h-5 w-24 bg-[#111e33] rounded-xl" />
                <div className="h-5 w-20 bg-[#111e33] rounded-xl" />
              </div>
              <div className="h-6 w-3/4 bg-[#111e33] rounded-lg" />
              <div className="h-4 w-1/2 bg-[#111e33] rounded-lg" />
              <div className="pt-3 border-t border-slate-800/80 flex justify-between items-center">
                <div className="h-4 w-28 bg-[#111e33] rounded" />
                <div className="h-8 w-24 bg-[#111e33] rounded-xl" />
              </div>
            </div>
          ))}
        </div>
      ) : filteredEvents.length === 0 ? (
        <div className="rounded-2xl border border-slate-800/80 bg-[#0a1322]/80 p-8 sm:p-10 text-center relative z-10">
          <div className="w-12 h-12 rounded-2xl bg-[#0f1b2e] border border-slate-700/80 flex items-center justify-center mx-auto mb-3 shadow-inner">
            <Calendar className="w-6 h-6 text-emerald-400" />
          </div>
          <h3 className="text-sm sm:text-base font-bold text-white mb-1">
            No Live Matches Scheduled Right Now
          </h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto mb-4">
            Live tournament feeds and fixtures will appear here automatically when matches begin. Tune into our 24/7 Live Sports channels below anytime.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link
              href="/category/sports-tv"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#00c978] hover:bg-[#00db84] text-slate-950 text-xs font-bold transition-all shadow-md shadow-emerald-500/20"
            >
              <Tv className="w-3.5 h-3.5" />
              <span>Browse 24/7 Sports Channels</span>
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 relative z-10">
          {filteredEvents.map((ev) => {
            const isLive = ev.status === "live";
            const icon = getSportIcon(ev.sportType);
            const matchId = ev.id || ev._id || "event";
            const rawStreamUrl = ev.primaryStreamUrl || ev.streamUrl || "";
            const streamUrl = resolveStreamUrl(rawStreamUrl);
            const targetHref = `/arena/${matchId}?stream=${encodeURIComponent(streamUrl)}&title=${encodeURIComponent(ev.matchTitle)}`;

            return (
              <div
                key={matchId}
                className="group relative rounded-2xl border border-slate-800/90 bg-[#0a1322] hover:border-emerald-500/50 hover:shadow-xl hover:shadow-emerald-500/10 transition-all duration-300 p-4 flex flex-col justify-between overflow-hidden"
              >
                {/* Match Header: Sport + Status badge */}
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-[#111e33] border border-slate-800 text-xs font-extrabold text-slate-300">
                    <span>{icon}</span>
                    <span className="truncate max-w-[120px]">{ev.sportType || "Sports"}</span>
                  </span>

                  {isLive ? (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-black uppercase tracking-wider">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      LIVE NOW
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-slate-800/80 text-slate-400 text-xs font-bold">
                      <Clock className="w-3.5 h-3.5 text-slate-400" />
                      <span>{formatMatchDate(ev.startTime)} • {formatMatchTime(ev.startTime)}</span>
                    </span>
                  )}
                </div>

                {/* Match Title */}
                <div className="my-2">
                  <h3 className="text-sm sm:text-base font-black text-white group-hover:text-emerald-300 transition-colors line-clamp-2 leading-snug">
                    {ev.matchTitle}
                  </h3>
                </div>

                {/* Footer row: stream server status + watch button */}
                <div className="pt-3 mt-1 border-t border-slate-800/80 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400">
                    {ev.isLocalServerActive ? (
                      <span className="inline-flex items-center gap-1 text-emerald-400">
                        <Signal className="w-3.5 h-3.5 text-emerald-400" />
                        HD Server Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-slate-400">
                        <Radio className="w-3.5 h-3.5 text-slate-500" />
                        Cloud Mirror Ready
                      </span>
                    )}
                  </div>

                  <Link
                    href={targetHref}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[#00c978] hover:bg-[#00db84] text-slate-950 font-black text-xs shadow-md shadow-emerald-500/20 hover:scale-[1.03] active:scale-[0.98] transition-all"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Watch Stream</span>
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
