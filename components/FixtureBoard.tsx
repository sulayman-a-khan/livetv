"use client";

import { ReactNode, useEffect, useState } from "react";
import type { PublicFixture } from "@/lib/fixtureBoard";

const pad = (n: number) => String(n).padStart(2, "0");

/** The countdown the approved wording asks for: a clock, then Bengali text. */
function countdownText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)} : ${pad(m)} : ${pad(s)} মিনিট পর খেলা শুরু হবে`;
}

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0] ?? "")
      .join("")
      .toUpperCase() || "?"
  );
}

/** Team mark: the logo the admin entered, or its initials when there is none. */
function TeamMark({ name, logo }: { name: string; logo: string }) {
  const [broken, setBroken] = useState(false);

  return (
    <div className="w-9 h-9 rounded-full bg-white/95 border border-slate-700 flex items-center justify-center overflow-hidden shrink-0">
      {logo && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt=""
          className="max-w-full max-h-full object-contain"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="text-[10px] font-black text-slate-700">{initialsOf(name)}</span>
      )}
    </div>
  );
}

function FixtureCard({ fixture, now, hideOnPhone }: { fixture: PublicFixture; now: number; hideOnPhone: boolean }) {
  const live = fixture.phase === "live";

  return (
    <article
      className={`rounded-2xl border border-slate-800/80 bg-[#0a1222] p-3 flex-col gap-2.5 ${
        hideOnPhone ? "hidden sm:flex" : "flex"
      }`}
    >
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide truncate">
          {fixture.competition || (fixture.sport === "cricket" ? "Cricket" : "Football")}
        </span>
        {live ? (
          <span className="flex items-center gap-1 text-[10px] font-black text-red-400 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            LIVE NOW
          </span>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <TeamMark name={fixture.teamA} logo={fixture.teamALogo} />
          <span className="text-[11px] font-bold text-slate-200 truncate">{fixture.teamA}</span>
        </div>
        <span className="text-[10px] font-black text-slate-600 shrink-0">vs</span>
        <div className="flex items-center gap-2 min-w-0 flex-1 justify-end flex-row-reverse">
          <TeamMark name={fixture.teamB} logo={fixture.teamBLogo} />
          <span className="text-[11px] font-bold text-slate-200 truncate text-right">
            {fixture.teamB}
          </span>
        </div>
      </div>

      <p
        className={`text-[11px] font-bold ${
          live ? "text-emerald-400" : "text-white"
        } truncate`}
      >
        {live
          ? `Live on ${fixture.channelName}`
          : countdownText(new Date(fixture.startsAt).getTime() - now)}
      </p>
    </article>
  );
}

/**
 * The homepage match board.
 *
 * It owns the banner slot on every viewport: when the admin has published a match
 * that is live or kicking off within the day, a card takes the slot; otherwise the
 * children it is given — the promo banner — render exactly as they did before this
 * component existed. A read that fails keeps the promo banner too, so a slow
 * lookup never blanks the homepage.
 */
export default function FixtureBoard({ children }: { children: ReactNode }) {
  const [fixtures, setFixtures] = useState<PublicFixture[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const res = await fetch("/api/fixtures", { cache: "no-store" });
        const data = await res.json();
        if (!active || !res.ok || data?.success !== true) return;
        setFixtures(Array.isArray(data.fixtures) ? data.fixtures : []);
      } catch {
        // No board this visit; the slot keeps its banner.
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  // The clock only needs to move while a card is counting down to kickoff.
  useEffect(() => {
    if (!fixtures.some((fixture) => fixture.phase === "upcoming")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [fixtures]);

  if (fixtures.length === 0) return <>{children}</>;

  return (
    <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-5">
      <div className="grid gap-2 sm:gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {fixtures.map((fixture, index) => (
          <FixtureCard
            key={fixture.id}
            fixture={fixture}
            now={now}
            hideOnPhone={index > 0}
          />
        ))}
      </div>
    </div>
  );
}
