"use client";

import { ReactNode, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Calendar, Clock, Goal, Trophy } from "lucide-react";
import FixtureChannelDialog, { unavailableText } from "./FixtureChannelDialog";
import { offersOf, type FixtureChoice, type PublicFixture } from "@/lib/fixtureBoard";
import { teamFlagUrl } from "@/lib/teamFlags";

const pad = (n: number) => String(n).padStart(2, "0");

/** The three numbers a countdown is made of, so the two forms of it cannot disagree. */
function countdownParts(ms: number): { h: number; m: number; s: number } {
  const total = Math.max(0, Math.floor(ms / 1000));
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
}

/** The countdown the approved wording asks for: a clock, then Bengali text. */
function countdownText(ms: number): string {
  const { h, m, s } = countdownParts(ms);
  return `${pad(h)} : ${pad(m)} : ${pad(s)} মিনিট পর খেলা শুরু হবে`;
}

/** The same clock as digits, for the badge that has room for nothing else. */
function countdownDigits(ms: number): string {
  const { h, m, s } = countdownParts(ms);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Bangladesh Standard Time: six hours ahead of UTC and no daylight saving, so the offset is a
 * constant rather than a lookup.
 *
 * The arithmetic is done by hand rather than through `Intl` because the card is rendered on the
 * server and again in the browser, and the two must not disagree about what time it is.
 */
const BDT_OFFSET_MS = 6 * 60 * 60 * 1000;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** The kickoff as the card prints it: the date, and the time of day in Bangladesh. */
function kickoffParts(ms: number): { date: string; time: string } {
  const at = new Date(ms + BDT_OFFSET_MS);
  const hour24 = at.getUTCHours();
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return {
    date: `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()}`,
    time: `${pad(hour12)}:${pad(at.getUTCMinutes())} ${hour24 < 12 ? "AM" : "PM"} BDT`,
  };
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

/**
 * The team's flag, drawn as a panel.
 *
 * The flag comes first because recognition is the point — a national side is recognised from its
 * name, so an admin never has to find, crop and upload a picture of a flag. A logo they entered
 * is the next thing to try and the initials are the last, so a card is never blank, and a
 * picture that fails to load costs the card its picture and nothing else.
 *
 * A country flag fills the panel edge to edge: the flag sheet and the wrapper are both 4:3, so
 * the picture covers the wrapper and no white margin is left showing around it. A crest is a
 * different shape, so it is contained rather than cropped — a crest cut off at the edges is worse
 * than a crest with a little air around it.
 */
function TeamFlag({ name, logo }: { name: string; logo: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const flag = teamFlagUrl(name);
  const candidates = [flag, logo].filter((src): src is string => Boolean(src));
  const src = candidates.find((candidate) => !failed.includes(candidate));
  const isFlag = Boolean(src) && src === flag;

  return (
    <div className="relative w-full max-w-[132px] aspect-[4/3] rounded-xl overflow-hidden bg-white/95 border border-white/20 shadow-lg shadow-black/50">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          className={`w-full h-full ${isFlag ? "object-cover" : "object-contain p-0.5"}`}
          onError={() => setFailed((list) => (list.includes(src) ? list : [...list, src]))}
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-[13px] font-black text-slate-700">
          {initialsOf(name)}
        </span>
      )}
    </div>
  );
}

/** The sport a card is for, in the one word its corner badge shows. */
const SPORT_LABEL: Record<PublicFixture["sport"], string> = {
  football: "Football",
  cricket: "Cricket",
};

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
  const startsAt = new Date(fixture.startsAt).getTime();
  const kickoff = kickoffParts(startsAt);
  const remaining = startsAt - now;
  // A live match whose channels are all shut says so on its face: a red badge would promise a
  // stream the card cannot open.
  const noOffer = live && offers.length === 0 ? noOfferText(fixture.choices) : "";

  const card = (
    <article
      className={`relative isolate overflow-hidden rounded-2xl border border-slate-800/80 bg-gradient-to-br from-[#111d33] via-[#0b1322] to-[#080d18] p-2.5 sm:p-3 flex-col gap-2 w-full ${
        hideOnPhone ? "hidden sm:flex" : "flex"
      }`}
    >
      {/* The two corners the card carries: the theme's indigo and its mint, both held low so the
          teams stay the brightest thing on the card. */}
      <div className="pointer-events-none absolute -top-10 -left-8 h-24 w-24 rounded-full bg-brand-500/20 blur-2xl" />
      <div className="pointer-events-none absolute -bottom-12 -right-6 h-24 w-24 rounded-full bg-brand-accent/10 blur-2xl" />

      {/* What the match is, and where it stands right now: the sport on the left, the status on
          the right, and the two of them share one line at every width. A card on a phone is half
          the page wide, so the type there is small and the sport badge is held to half its
          desktop size — the line gets shorter rather than breaking into two rows. */}
      <div className="relative flex items-center gap-1 sm:gap-2 min-w-0">
        <span className="inline-flex items-center gap-0.5 sm:gap-1 shrink-0 whitespace-nowrap rounded-full border border-brand-500/50 bg-brand-500/10 px-1 sm:px-2.5 py-0 sm:py-1 text-[7px] sm:text-[10px] font-black uppercase tracking-[0.06em] sm:tracking-[0.14em] text-indigo-200">
          {fixture.sport === "cricket" ? (
            <Trophy className="w-2 sm:w-3 h-2 sm:h-3" />
          ) : (
            <Goal className="w-2 sm:w-3 h-2 sm:h-3" />
          )}
          {SPORT_LABEL[fixture.sport]}
        </span>

        {live ? (
          noOffer ? null : (
            <span className="inline-flex items-center gap-1 shrink-0 whitespace-nowrap ml-auto rounded-full bg-red-600 px-1 sm:px-2.5 py-0 sm:py-1 text-[8px] sm:text-[10px] font-black uppercase tracking-wider text-white">
              <span className="w-1 sm:w-1.5 h-1 sm:h-1.5 rounded-full bg-white animate-pulse" />
              LIVE NOW
            </span>
          )
        ) : (
          <span className="flex items-center gap-1 shrink-0 ml-auto">
            <span className="inline-flex items-center gap-0.5 sm:gap-1 whitespace-nowrap rounded-full border border-amber-500/50 bg-amber-500/10 px-1 sm:px-2.5 py-0 sm:py-1 text-[8px] sm:text-[10px] font-black uppercase tracking-wider text-amber-300">
              {/* The clock beside the word has no room on a phone, and the countdown beside it
                  says the same thing more precisely. */}
              <Clock className="hidden sm:block w-3 h-3" />
              UPCOMING
            </span>
            <span
              title={countdownText(remaining)}
              aria-label={countdownText(remaining)}
              className="text-[7px] sm:text-[11px] font-black tabular-nums text-amber-300/90"
            >
              {countdownDigits(remaining)}
            </span>
          </span>
        )}
      </div>

      {noOffer ? (
        <p className="relative text-center text-[10px] font-bold text-amber-300/90">{noOffer}</p>
      ) : null}

      {fixture.competition ? (
        <p className="relative text-center text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500 truncate">
          {fixture.competition}
        </p>
      ) : null}

      {/* The two teams, spread across the card: the flags take the two ends, the VS holds the middle
          and the names sit tight under their own flag. */}
      <div className="relative flex items-center justify-between gap-2">
        <div className="flex w-[54px] sm:w-[68px] flex-col items-center gap-1">
          <TeamFlag name={fixture.teamA} logo={fixture.teamALogo} />
          <span className="text-[9px] sm:text-[10px] font-black uppercase tracking-wide text-white text-center leading-tight line-clamp-2">
            {fixture.teamA}
          </span>
        </div>
        <span className="text-[11px] sm:text-[12px] font-black italic text-slate-300 shrink-0">VS</span>
        <div className="flex w-[54px] sm:w-[68px] flex-col items-center gap-1">
          <TeamFlag name={fixture.teamB} logo={fixture.teamBLogo} />
          <span className="text-[9px] sm:text-[10px] font-black uppercase tracking-wide text-white text-center leading-tight line-clamp-2">
            {fixture.teamB}
          </span>
        </div>
      </div>

      {/* The kickoff, under the teams: the date and the time the whole card comes down to. On a
          narrow card the two parts break onto their own lines rather than running past the edge. */}
      <div className="relative flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 rounded-lg border border-slate-800/80 bg-black/30 px-2 py-1.5 text-[9px] sm:text-[10px] font-bold text-slate-300">
        <span className="flex items-center gap-1 whitespace-nowrap">
          <Calendar className="w-2.5 h-2.5 text-slate-500 shrink-0" />
          {kickoff.date}
        </span>
        <span className="hidden sm:inline text-slate-600">·</span>
        <span className="flex items-center gap-1 whitespace-nowrap">
          <Clock className="w-2.5 h-2.5 text-slate-500 shrink-0" />
          {kickoff.time}
        </span>
      </div>
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
      {/* The section's own name, so the cards below read as the 24/7 sports section rather than
          as another panel of channels. It appears only when the board has cards to show: an
          empty board is not a section, it is the promo banner that the caller passed in. */}
      <h2 className="text-sm font-black text-white tracking-tight mb-2.5">24/7 Sports</h2>
      {/* Two cards to a line on a phone and four on a desktop. Every card fills its own column, so
          the row starts at the page's left edge and nothing needs a margin to be narrower. */}
      <div className="grid gap-2 sm:gap-3 grid-cols-2 lg:grid-cols-4">
        {fixtures.map((fixture, index) => (
          <FixtureCard
            key={fixture.id}
            fixture={fixture}
            now={now}
            hideOnPhone={index > 1}
            onChoose={setChoosingId}
          />
        ))}
      </div>
      {choosing ? <FixtureChannelDialog fixture={choosing} onClose={closeChooser} /> : null}
    </div>
  );
}
