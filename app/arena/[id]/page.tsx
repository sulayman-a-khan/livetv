"use client";

import "@/lib/tvPolyfills";
import { useEffect, useState, useMemo, Suspense } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import Header from "@/components/Header";
import { SecuredHlsPlayer } from "@/components/players";
import {
  SportsEvent,
  fetchLiveSportsEvents,
  checkLocalPcBridgeStatus,
} from "@/lib/sportsArenaService";
import { resolveStreamUrl } from "@/lib/streamUrl";
import { RefreshCw, Trophy, Clock, Play } from "lucide-react";

function SportsArenaContent() {
  const params = useParams();
  const searchParams = useSearchParams();

  const eventIdParam = (params?.id as string) || "";
  const streamParam = searchParams.get("stream");
  const titleParam = searchParams.get("title");

  const [events, setEvents] = useState<SportsEvent[]>([]);
  const [currentEvent, setCurrentEvent] = useState<SportsEvent | null>(null);
  const [loading, setLoading] = useState(true);

  // Load sports events & PC bridge status
  useEffect(() => {
    let mounted = true;

    async function initArena() {
      setLoading(true);
      try {
        const [fetchedEvents, pcStatus] = await Promise.all([
          fetchLiveSportsEvents(),
          checkLocalPcBridgeStatus(),
        ]);

        if (!mounted) return;

        setEvents(fetchedEvents);

        // Find current match
        const found = fetchedEvents.find((e) => e.id === eventIdParam || e._id === eventIdParam);
        if (found) {
          setCurrentEvent(found);
        } else if (streamParam) {
          setCurrentEvent({
            id: eventIdParam || "live-arena-stream",
            _id: eventIdParam || "live-arena-stream",
            matchTitle: titleParam ? decodeURIComponent(titleParam) : "Live Arena Match",
            sportType: "Live Sports",
            startTime: new Date().toISOString(),
            endTime: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
            status: "live",
            primaryStreamUrl: streamParam,
            streamUrl: streamParam,
            backupStreamUrls: [],
            isLocalServerActive: pcStatus.online,
          });
        } else if (fetchedEvents.length > 0) {
          setCurrentEvent(fetchedEvents[0]);
        }
      } catch (err) {
        console.error("Failed to initialize Sports Arena page:", err);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    initArena();

    const interval = setInterval(async () => {
      const fetchedEvents = await fetchLiveSportsEvents();
      if (mounted) {
        setEvents(fetchedEvents);

        // Follow the server's currently published URL — picks up panel-side
        // source switches and tunnel rotations without a page refresh.
        const found = fetchedEvents.find((e) => e.id === eventIdParam || e._id === eventIdParam);
        if (found) setCurrentEvent(found);
      }
    }, 20_000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [eventIdParam, streamParam, titleParam]);

  // Single server-controlled feed: the panel owns the source and switches it
  // automatically; viewers just follow whatever URL the sync publishes.
  const rawStreamUrl = currentEvent
    ? currentEvent.primaryStreamUrl || currentEvent.streamUrl || ""
    : "";
  const streamUrl = useMemo(() => resolveStreamUrl(rawStreamUrl), [rawStreamUrl]);

  // Format date and time
  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
    } catch {
      return "Live Now";
    }
  };

  const otherLiveMatches = useMemo(() => {
    return events.filter(
      (e) => (e.id || e._id) !== (currentEvent?.id || currentEvent?._id)
    );
  }, [events, currentEvent]);

  return (
    <div className="min-h-screen bg-[#030712] text-slate-100 flex flex-col font-sans">
      {/* Top Navbar */}
      <Header wide />

      <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6 space-y-6">
        {/* Solo Match Player Area */}
        {loading && !currentEvent ? (
          <div className="rounded-3xl border border-slate-800/80 bg-[#091322] p-16 text-center max-w-lg mx-auto my-12 shadow-2xl space-y-3">
            <RefreshCw className="w-10 h-10 text-emerald-400 animate-spin mx-auto" />
            <h3 className="text-base font-bold text-white">Loading Arena Stream Signal...</h3>
            <p className="text-xs text-slate-400">Connecting to high-bitrate encoder forwarder</p>
          </div>
        ) : currentEvent ? (
          <div className="space-y-4">
            {/* Solo Player Frame - WITHOUT any Free Portal channel lists */}
            <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl border border-emerald-500/20 shadow-2xl bg-black">
              <SecuredHlsPlayer
                matchTitle={currentEvent.matchTitle}
                sportType={currentEvent.sportType}
                streamUrl={streamUrl}
              />
            </div>

            {/* Match Information Card */}
            <div className="rounded-2xl border border-slate-800/90 bg-gradient-to-r from-[#091523] via-[#07101d] to-[#050b14] p-5 sm:p-6 shadow-xl flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-black bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                    {currentEvent.sportType || "Live Sports"}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-black bg-rose-500/15 text-rose-400 border border-rose-500/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping" />
                    LIVE MATCH
                  </span>
                  <span className="text-xs font-semibold text-slate-400 flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    {formatTime(currentEvent.startTime)}
                  </span>
                </div>

                <h1 className="text-lg sm:text-2xl font-black text-white tracking-tight">
                  {currentEvent.matchTitle}
                </h1>

                <p className="text-xs text-slate-400">
                  Dedicated High-Definition Stadium Feed • Server-Controlled Live Relay
                </p>
              </div>
            </div>

            {/* Other Live Matches in Arena Hub */}
            {otherLiveMatches.length > 0 && (
              <div className="pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm sm:text-base font-black text-white flex items-center gap-2">
                    <Trophy className="w-4 h-4 text-emerald-400" />
                    <span>Other Matches in Live Sports Arena</span>
                  </h2>
                  <span className="text-xs font-bold text-slate-400">
                    {otherLiveMatches.length} Live Fixtures
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {otherLiveMatches.map((ev) => {
                    const matchId = ev.id || ev._id || "event";
                    const sUrl = ev.primaryStreamUrl || ev.streamUrl || "";
                    const linkHref = `/arena/${matchId}?stream=${encodeURIComponent(sUrl)}&title=${encodeURIComponent(ev.matchTitle)}`;

                    return (
                      <Link
                        key={matchId}
                        href={linkHref}
                        className="group rounded-2xl border border-slate-800/80 bg-[#091322] hover:border-emerald-500/50 p-4 transition-all duration-200 flex items-center justify-between gap-3 shadow-lg hover:shadow-emerald-500/10"
                      >
                        <div className="min-w-0 space-y-1">
                          <span className="inline-block text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/30">
                            {ev.sportType || "Sports"}
                          </span>
                          <h4 className="text-xs font-black text-white group-hover:text-emerald-300 truncate">
                            {ev.matchTitle}
                          </h4>
                          <span className="text-[11px] font-semibold text-slate-400 flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5" />
                            {formatTime(ev.startTime)}
                          </span>
                        </div>

                        <div className="w-8 h-8 rounded-xl bg-emerald-500/10 group-hover:bg-emerald-500 text-emerald-400 group-hover:text-slate-950 flex items-center justify-center shrink-0 transition-colors shadow-sm">
                          <Play className="w-3.5 h-3.5 fill-current" />
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-3xl border border-slate-800 bg-[#091322] p-12 text-center max-w-md mx-auto my-12 shadow-2xl space-y-4">
            <Trophy className="w-12 h-12 text-slate-600 mx-auto" />
            <h3 className="text-base font-bold text-white">No Live Arena Match Selected</h3>
            <p className="text-xs text-slate-400">
              Select a live sports tournament match from the home arena or return to SoluPlay home.
            </p>
            <Link
              href="/"
              className="inline-block px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl text-xs transition-colors shadow-lg"
            >
              Browse Live Sports Arena
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}

export default function SportsArenaWatchPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#030712] text-white flex flex-col items-center justify-center space-y-3">
          <RefreshCw className="w-10 h-10 text-emerald-400 animate-spin" />
          <p className="text-xs font-bold text-slate-400">Loading Sports Arena...</p>
        </div>
      }
    >
      <SportsArenaContent />
    </Suspense>
  );
}
