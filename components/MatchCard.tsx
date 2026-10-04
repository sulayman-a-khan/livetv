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

/* ------------------------------------------------------------------ *
 * Teams → country flags
 * ------------------------------------------------------------------ */

/** Team abbreviations / names (lowercased) → ISO 3166-1 alpha-2 code (or gb-eng/gb-sct) for flagcdn.com. */
const TEAM_FLAG_CODES: Record<string, string> = {
  // Cricket / South Asia
  bd: "bd", ban: "bd", bangladesh: "bd",
  ind: "in", india: "in",
  pak: "pk", pakistan: "pk",
  sl: "lk", sri: "lk", "sri lanka": "lk", ceylon: "lk",
  afg: "af", afghanistan: "af",
  nep: "np", nepal: "np",
  hk: "hk", "hong kong": "hk",
  uae: "ae", oma: "om", oman: "om",
  zim: "zw", zimbabwe: "zw",
  ire: "ie", ireland: "ie",
  eng: "gb-eng", england: "gb-eng",
  sco: "gb-sct", scotland: "gb-sct",
  aus: "au", australia: "au",
  nz: "nz", "new zealand": "nz",
  sa: "za", rsa: "za", "south africa": "za",
  nam: "na", namibia: "na",
  usa: "us", "united states": "us",

  // Football / global
  bra: "br", brazil: "br",
  arg: "ar", argentina: "ar",
  por: "pt", portugal: "pt",
  fra: "fr", france: "fr",
  esp: "es", spain: "es",
  ger: "de", germany: "de",
  ita: "it", italy: "it",
  ned: "nl", netherlands: "nl", hol: "nl", holland: "nl",
  bel: "be", belgium: "be",
  cro: "hr", croatia: "hr",
  uru: "uy", uruguay: "uy",
  col: "co", colombia: "co",
  mex: "mx", mexico: "mx",
  jpn: "jp", japan: "jp",
  kor: "kr", "south korea": "kr",
  ksa: "sa", "saudi arabia": "sa",
  qat: "qa", qatar: "qa",
  mar: "ma", morocco: "ma",
  sen: "sn", senegal: "sn",
  nga: "ng", nigeria: "ng",
  gha: "gh", ghana: "gh",
  egy: "eg", egypt: "eg",
  tur: "tr", turkey: "tr", "türkiye": "tr",
  sui: "ch", switzerland: "ch",
  den: "dk", denmark: "dk",
  swe: "se", sweden: "se",
  nor: "no", norway: "no",
  pol: "pl", poland: "pl",
  aut: "at", austria: "at",
  cze: "cz", czech: "cz", "czech republic": "cz",
  srb: "rs", serbia: "rs",
  gre: "gr", greece: "gr",
  ukr: "ua", ukraine: "ua",
  can: "ca", canada: "ca",
  chi: "cl", chile: "cl",
  per: "pe", peru: "pe",
  ecu: "ec", ecuador: "ec",
  par: "py", paraguay: "py",
  ven: "ve", venezuela: "ve",
  crc: "cr", "costa rica": "cr",
  jam: "jm", jamaica: "jm",
  irn: "ir", iran: "ir",
  irq: "iq", iraq: "iq",
  jor: "jo", jordan: "jo",
  uzb: "uz", uzbekistan: "uz",
  kaz: "kz", kazakhstan: "kz",
  tha: "th", thailand: "th",
  vie: "vn", vietnam: "vn",
  mas: "my", malaysia: "my",
  sin: "sg", singapore: "sg",
  phi: "ph", philippines: "ph",
  ina: "id", indonesia: "id",
};

/**
 * Best-effort flag code for one side of a match title ("PAK 2nd T20", "Sri Lanka Women").
 * Tries the full token first, then progressively shorter leading word groups.
 */
function flagCodeFor(rawTeam: string): string | null {
  const words = rawTeam
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (let n = Math.min(words.length, 3); n >= 1; n--) {
    const code = TEAM_FLAG_CODES[words.slice(0, n).join(" ")];
    if (code) return code;
  }
  return null;
}

/** Splits "BD vs PAK", "India v Australia" or "Sri Lanka - Bangladesh" into the two sides. */
function parseTeams(title: string): { a: string; b: string } | null {
  const clean = (title || "").trim();
  if (!clean) return null;

  const byWord = clean.split(/\s+(?:versus|vs\.?|v)\s+/i);
  if (byWord.length >= 2) {
    const a = byWord[0].trim();
    const b = byWord[1].trim();
    if (a && b) return { a, b };
  }

  const byDash = clean.split(/\s+[-–—]\s+/);
  if (byDash.length === 2) {
    const a = byDash[0].trim();
    const b = byDash[1].trim();
    if (a && b && (flagCodeFor(a) || flagCodeFor(b))) return { a, b };
  }
  return null;
}

function flagUrl(code: string): string {
  return `https://flagcdn.com/w80/${code}.png`;
}

/* ------------------------------------------------------------------ */

export default function MatchCard({ event, icon = "🏆" }: MatchCardProps) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  const [showNotStarted, setShowNotStarted] = useState(false);

  const status = (event.status || "").toLowerCase();
  const isLive = typeof event.isLive === "boolean" ? event.isLive : status === "live";
  const isEnded = !isLive && status === "ended";

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

  const teams = parseTeams(event.matchTitle);
  const flagA = teams ? flagCodeFor(teams.a) : null;
  const flagB = teams ? flagCodeFor(teams.b) : null;

  const startDate = new Date(event.startTime);
  const validStart = !Number.isNaN(startDate.getTime());
  const startTimeText = validStart
    ? startDate.toLocaleTimeString("bn-BD", { hour: "numeric", minute: "2-digit" })
    : "";
  const startDateText =
    validStart && startDate.toDateString() !== new Date().toDateString()
      ? startDate.toLocaleDateString("bn-BD", { day: "numeric", month: "short" })
      : "";

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

  const statusChipClass = isLive
    ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
    : isEnded
    ? "bg-slate-600/20 border-slate-600/40 text-slate-400"
    : "bg-sky-500/10 border-sky-500/30 text-sky-300";

  return (
    <>
      <div className="group relative rounded-2xl border border-slate-800/90 bg-gradient-to-br from-[#0d1a2f] via-[#0a1322] to-[#071022] hover:border-emerald-500/60 hover:shadow-xl hover:shadow-emerald-500/15 transition-all duration-300 overflow-hidden [container-type:inline-size]">
        {/* Sport watermark */}
        <span
          aria-hidden
          className="pointer-events-none select-none absolute -bottom-4 -right-3 text-[76px] leading-none opacity-[0.06] -rotate-12"
        >
          {icon}
        </span>

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
          <div className="flex flex-col aspect-video p-3 sm:p-4 gap-1.5">
            {/* Header: sport chip + status */}
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 min-w-0 px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-[10px] sm:text-xs font-bold text-slate-200">
                <span className="shrink-0">{icon}</span>
                <span className="truncate uppercase tracking-wide">{event.sportType || "Live Sports"}</span>
              </span>
              <span
                className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] sm:text-xs font-black ${statusChipClass}`}
              >
                {isLive && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
                {isLive ? "লাইভ" : isEnded ? "সমাপ্ত" : "আসন্ন"}
              </span>
            </div>

            {/* Center: teams with flags, or the full title */}
            <div className="flex-1 min-h-0 flex items-center justify-center">
              {teams ? (
                <div className="flex items-center justify-center gap-2 sm:gap-3 w-full min-w-0">
                  <div className="flex flex-col items-center gap-1.5 min-w-0 flex-1">
                    {flagA && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={flagUrl(flagA)}
                        alt=""
                        draggable={false}
                        className="w-[clamp(26px,8cqi,40px)] h-auto rounded-[3px] ring-1 ring-white/15 shadow-md"
                      />
                    )}
                    <span className="max-w-full truncate text-[clamp(12px,3.6cqi,17px)] font-black text-slate-100">
                      {teams.a}
                    </span>
                  </div>

                  <span className="shrink-0 px-2 py-1 rounded-lg bg-white/10 border border-white/10 text-[clamp(9px,2.4cqi,12px)] font-black text-emerald-300 tracking-widest">
                    VS
                  </span>

                  <div className="flex flex-col items-center gap-1.5 min-w-0 flex-1">
                    {flagB && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={flagUrl(flagB)}
                        alt=""
                        draggable={false}
                        className="w-[clamp(26px,8cqi,40px)] h-auto rounded-[3px] ring-1 ring-white/15 shadow-md"
                      />
                    )}
                    <span className="max-w-full truncate text-[clamp(12px,3.6cqi,17px)] font-black text-slate-100">
                      {teams.b}
                    </span>
                  </div>
                </div>
              ) : (
                <span className="px-2 text-[clamp(14px,4.6cqi,22px)] leading-tight font-black text-white text-center line-clamp-2">
                  {event.matchTitle}
                </span>
              )}
            </div>

            {/* Start time */}
            {startTimeText && (
              <div className="text-center text-[10px] sm:text-[11px] font-semibold text-slate-400">
                শুরু: {startDateText ? `${startDateText}, ` : ""}
                {startTimeText}
              </div>
            )}

            {/* Bengali cue */}
            <div className="flex items-center justify-center overflow-hidden">
              {isLive ? (
                <span className="text-[clamp(10px,3cqi,15px)] leading-[1.35] font-black text-emerald-300 whitespace-nowrap">
                  লাইভ উপলব্ধ! দেখতে ক্লিক করুন
                </span>
              ) : isEnded ? (
                <span className="text-[clamp(10px,3cqi,15px)] leading-[1.35] font-black text-slate-400 whitespace-nowrap">
                  ম্যাচ শেষ হয়ে গেছে
                </span>
              ) : (
                <span className="text-[clamp(9px,2.9cqi,15px)] leading-[1.35] font-black text-white whitespace-nowrap">
                  আর মাত্র {hh} : {mm} : {ss} মিনিট পর খেলা শুরু হবে
                </span>
              )}
            </div>
          </div>
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
