"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { resolveStreamUrl } from "@/lib/streamUrl";

/** Client-side shape of a sports event card (matches the /api/events payload). */
export interface MatchCardEvent {
  id?: string;
  _id?: string;
  matchTitle: string;
  sportType?: string;
  startTime: string;
  status?: string;
  /** Direct stream-availability flag from the server, when present. */
  isLive?: boolean;
  primaryStreamUrl?: string;
  streamUrl?: string;
}

interface MatchCardProps {
  event: MatchCardEvent;
  icon?: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export default function MatchCard({ event, icon = "🏆" }: MatchCardProps) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  const [showNotStarted, setShowNotStarted] = useState(false);

  // Stream availability straight from the server payload — no pre-match time gating.
  const isLive =
    typeof event.isLive === "boolean"
      ? event.isLive
      : (event.status || "").toLowerCase() === "live";

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const startMs = new Date(event.startTime).getTime();
  const remainingMs = Number.isNaN(startMs) ? 0 : Math.max(0, startMs - now);
  const totalSec = Math.floor(remainingMs / 1000);
  const hh = pad2(Math.floor(totalSec / 3600));
  const mm = pad2(Math.floor((totalSec % 3600) / 60));
  const ss = pad2(totalSec % 60);

  const handleClick = () => {
    if (!isLive) {
      setShowNotStarted(true);
      return;
    }
    const matchId = event.id || event._id || "event";
    const streamUrl = resolveStreamUrl(event.primaryStreamUrl || event.streamUrl || "");
    router.push(
      `/arena/${matchId}?stream=${encodeURIComponent(streamUrl)}&title=${encodeURIComponent(event.matchTitle)}`
    );
  };

  return (
    <>
      <div className="group relative rounded-2xl border border-slate-800/90 bg-[#0a1322] hover:border-emerald-500/60 hover:shadow-xl hover:shadow-emerald-500/15 transition-all duration-300 overflow-hidden [container-type:inline-size]">
        <button
          type="button"
          onClick={handleClick}
          aria-label={
            isLive
              ? `${event.matchTitle} — live now, click to watch`
              : `${event.matchTitle} — not started yet`
          }
          className="relative block w-full cursor-pointer text-left"
        >
          {/* FIXTURE BANNER BACKDROP */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/match-fixture-banner.jpg"
            alt={event.matchTitle}
            draggable={false}
            className="w-full h-auto select-none transition-transform duration-500 group-hover:scale-[1.03]"
          />

          {/* Match identity chip */}
          <span className="absolute top-2 left-2 sm:top-2.5 sm:left-2.5 max-w-[72%] inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-950/75 backdrop-blur-sm border border-white/10 text-[10px] sm:text-xs font-bold text-slate-100">
            <span className="shrink-0">{icon}</span>
            <span className="truncate">{event.matchTitle}</span>
          </span>

          {/* Bottom dark bar: countdown to startTime, or live cue */}
          <span className="absolute left-[13%] right-[13%] bottom-[6.8%] h-[7%] flex items-center justify-center overflow-hidden">
            {isLive ? (
              <span className="text-[clamp(9px,2.9cqi,15px)] leading-[1.35] font-black text-emerald-300 [text-shadow:0_1px_8px_rgba(2,6,23,0.95)] whitespace-nowrap">
                লাইভ উপলব্ধ! দেখতে ক্লিক করুন
              </span>
            ) : (
              <span className="text-[clamp(9px,2.9cqi,15px)] leading-[1.35] font-black text-white [text-shadow:0_1px_8px_rgba(2,6,23,0.95)] whitespace-nowrap">
                আর মাত্র {hh} : {mm} : {ss} মিনিট পর খেলা শুরু হবে
              </span>
            )}
          </span>
        </button>
      </div>

      {/* Not-started warning modal */}
      {showNotStarted && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="খেলা এখনও শুরু হয়নি"
          onClick={() => setShowNotStarted(false)}
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/75 backdrop-blur-md animate-fade-in"
        >
          <div className="relative w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/not-started-banner.png"
              alt="খেলা এখনও শুরু হয়নি — খেলা শুরু হওয়ার সাথে সাথে লাইভ শুরু হবে। অনুগ্রহ করে সাথে থাকুন।"
              className="w-full h-auto rounded-2xl border border-slate-700/60 shadow-2xl"
            />
            <button
              type="button"
              onClick={() => setShowNotStarted(false)}
              aria-label="Close"
              className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-[#0d1628] border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800 hover:border-slate-500 flex items-center justify-center shadow-lg transition-all cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
