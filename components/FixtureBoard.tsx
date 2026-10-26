"use client";

import { ReactNode, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import FixtureChannelDialog, { unavailableText } from "./FixtureChannelDialog";
import { offersOf, type FixtureChoice, type PublicFixture } from "@/lib/fixtureBoard";

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

/**
 * What a live match with nothing to open says.
 *
 * When every choice gives the same reason, that reason is the card's line: a premium outage, a
 * source nobody pushed, a channel switched off, or a direct channel the catalogue has stopped
 * showing. When they disagree — or when the card has no channel left to name at all, only links that
 * have gone stale — the shared answer is the honest one, and the dialog is where the detail lives.
 */
function noOfferText(choices: FixtureChoice[]): string {
  const states = new Set(choices.map((choice) => choice.state));
  return states.size === 1 && choices.length > 0
    ? unavailableText(choices[0].state)
    : "এখন দেখার জন্য কোনো চ্যানেল নেই।";
}

function FixtureCard({
  fixture,
  now,
  hideOnPhone,
  onChoose,
}: {
  fixture: PublicFixture;
  now: number;
  hideOnPhone: boolean;
  onChoose: (id: string) => void;
}) {
  const live = fixture.phase === "live";
  const offers = offersOf(fixture.choices);
  // The card's own line names the channel a tap would reach, so the first offer is the one worth
  // printing — the same answer `watchPath` was built from, not a field carried alongside it.
  const named = offers[0] ?? fixture.choices[0];
  const extra = offers.length > 1 ? ` +${offers.length - 1}` : "";

  const card = (
    <article
      className={`rounded-2xl border border-slate-800/80 bg-[#0a1222] p-3 flex-col gap-2.5 w-full ${
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
          live ? (offers.length > 0 ? "text-emerald-400" : "text-slate-400") : "text-white"
        } truncate`}
      >
        {live
          ? offers.length > 0
            ? `▶ Live on ${named.name}${extra}`
            : noOfferText(fixture.choices)
          : countdownText(new Date(fixture.startsAt).getTime() - now)}
      </p>
    </article>
  );

  // Three cards wear the same face and do three different things, decided by the projection rather
  // than guessed here: one thing to offer means a tap can go straight to it, several mean the
  // viewer has to pick, and nothing means the card stays a poster — the match is still on the
  // board, the watch is not.
  if (fixture.watchPath) {
    return (
      <Link
        href={fixture.watchPath}
        className={`block text-left transition-transform active:scale-[0.99] ${hideOnPhone ? "hidden sm:block" : "block"}`}
      >
        {card}
      </Link>
    );
  }

  if (offers.length > 1) {
    return (
      <button
        type="button"
        onClick={() => onChoose(fixture.id)}
        aria-haspopup="dialog"
        className={`text-left transition-transform active:scale-[0.99] ${hideOnPhone ? "hidden sm:block" : "block"}`}
      >
        {card}
      </button>
    );
  }

  return card;
}

/**
 * The homepage match board.
 *
 * It owns the banner slot on every viewport: when the admin has published a match
 * that is live or kicking off within the day, a card takes the slot; otherwise the
 * children it is given — the promo banner — render exactly as they did before this
 * component existed. A read that fails keeps the promo banner too, so a slow
 * lookup never blanks the homepage.
 *
 * A card that can be watched on several channels opens `FixtureChannelDialog` instead of playing
 * one of them by luck, and which of the two a card is comes from the projection, not from the
 * markup.
 */
export default function FixtureBoard({ children }: { children: ReactNode }) {
  const [fixtures, setFixtures] = useState<PublicFixture[]>([]);
  const [now, setNow] = useState(() => Date.now());
  // The one card whose chooser is open, by id rather than by copied payload: a board read that
  // arrives while the dialog is up refreshes the reasons inside it instead of leaving a stale list
  // on screen.
  const [choosingId, setChoosingId] = useState<string | null>(null);
  const closeChooser = useCallback(() => setChoosingId(null), []);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const res = await fetch("/api/fixtures", { cache: "no-store" });
        const data = await res.json();
        if (!active || !res.ok || data?.success !== true) return;
        setFixtures(Array.isArray(data.fixtures) ? data.fixtures : []);
      } catch {
        // No board this visit; the slot keeps its banner.
      }
    };

    load();

    // The readiness a card was drawn with belongs to the second it was read. Asking again when
    // the tab comes back — rather than on a timer, which would charge every open homepage its
    // own poll — takes the link off a live card during an outage and puts it back once the box
    // has answered for itself again.
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // The clock only needs to move while a card is counting down to kickoff.
  useEffect(() => {
    if (!fixtures.some((fixture) => fixture.phase === "upcoming")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [fixtures]);

  if (fixtures.length === 0) return <>{children}</>;

  const choosing = choosingId
    ? fixtures.find((fixture) => fixture.id === choosingId) ?? null
    : null;

  return (
    <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-5">
      <div className="grid gap-2 sm:gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {fixtures.map((fixture, index) => (
          <FixtureCard
            key={fixture.id}
            fixture={fixture}
            now={now}
            hideOnPhone={index > 0}
            onChoose={setChoosingId}
          />
        ))}
      </div>
      {choosing ? <FixtureChannelDialog fixture={choosing} onClose={closeChooser} /> : null}
    </div>
  );
}
