"use client";

import { ReactNode, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Goal, Play } from "lucide-react";
import FixtureChannelDialog, { unavailableText } from "./FixtureChannelDialog";
import { offersOf, type FixtureChoice, type PublicFixture } from "@/lib/fixtureBoard";
import { teamFlagUrl } from "@/lib/teamFlags";

const pad = (n: number) => String(n).padStart(2, "0");

/** The four numbers a countdown is made of, so the two forms of it cannot disagree. */
function countdownParts(ms: number): { d: number; h: number; m: number; s: number } {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    d: Math.floor(total / 86400),
    h: Math.floor((total % 86400) / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60,
  };
}

/** The countdown the approved wording asks for: a clock, then Bengali text. */
function countdownText(ms: number): string {
  const { d, h, m, s } = countdownParts(ms);
  const clock = d > 0 ? `${d} দিন ${pad(h)} : ${pad(m)}` : `${pad(h)} : ${pad(m)} : ${pad(s)}`;
  return `${clock} মিনিট পর খেলা শুরু হবে`;
}

/**
 * The clock the card shows: days, hours and minutes while the kickoff is still more than a day
 * away, and hours, minutes and seconds for the last day — the hour before the match is the one a
 * viewer watches most closely, so that is where the seconds are.
 */
function countdownLabel(ms: number): string {
  const { d, h, m, s } = countdownParts(ms);
  return d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}h ${pad(m)}m ${pad(s)}s`;
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

/**
 * The day a match falls on, in words where words help.
 *
 * A card that says "TODAY" or "TOMORROW" tells the reader more than the date it replaces, and
 * the two are counted in Bangladesh time so the card never says tomorrow at ten at night.
 */
function dayWord(ms: number, now: number): string {
  const day = Math.floor((ms + BDT_OFFSET_MS) / 86400000);
  const today = Math.floor((now + BDT_OFFSET_MS) / 86400000);
  if (day === today) return "TODAY";
  if (day === today + 1) return "TOMORROW";
  return "";
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
    <div className="relative w-full max-w-[92px] aspect-[4/3] rounded-xl overflow-hidden bg-white/95 border border-white/20 shadow-lg shadow-black/50">
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

/**
 * The sport's mark, small and quiet beside the match's name: a goal for football, and a bat
 * with the stumps for cricket — drawn here because the icon set has no cricket mark to pick.
 */
function SportMark({ sport }: { sport: PublicFixture["sport"] }) {
  if (sport === "cricket") {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-3.5 h-3.5 shrink-0 text-indigo-300"
        aria-hidden="true"
      >
        <path d="M4.6 20.4 13.4 6.6" />
        <path d="M13.4 6.6 16.2 2.9" />
        <path d="M14.5 5.1 16.5 6.4" />
        <path d="M16.6 12.4v8.2" />
        <path d="M19.6 12.4v8.2" />
        <path d="M22.6 12.4v8.2" />
        <path d="M16.6 11.9h6" />
      </svg>
    );
  }
  return <Goal className="w-3.5 h-3.5 shrink-0 text-indigo-300" aria-hidden="true" />;
}

/**
 * The title's type size, stepped down as the name gets longer.
 *
 * A card is half the page wide on a phone and a quarter of it on a desktop, so a long name has
 * to give up its size before it gives up its place: the smaller the name, the smaller the type,
 * until the whole thing fits the box instead of being cut off.
 */
function titleSizeClass(text: string): string {
  const n = text.length;
  if (n <= 18) return "text-[11px] sm:text-[12px] tracking-[0.12em]";
  if (n <= 26) return "text-[10px] sm:text-[11px] tracking-[0.1em]";
  if (n <= 34) return "text-[9px] sm:text-[10px] tracking-[0.08em]";
  if (n <= 44) return "text-[8px] sm:text-[9px] tracking-[0.06em]";
  return "text-[7px] sm:text-[8px] tracking-[0.04em]";
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
  onChoose,
}: {
  fixture: PublicFixture;
  now: number;
  onChoose: (id: string) => void;
}) {
  const live = fixture.phase === "live";
  const offers = offersOf(fixture.choices);
  const startsAt = new Date(fixture.startsAt).getTime();
  const kickoff = kickoffParts(startsAt);
  const day = dayWord(startsAt, now);
  const remaining = startsAt - now;
  // The name the admin gave the match, and the competition under it. The title is what the top
  // box carries; the competition only keeps a line of its own when the title did not take it.
  const title = fixture.title.trim();
  const competition = fixture.competition.trim();
  // A live match whose channels are all shut says so on its face: a red badge would promise a
  // stream the card cannot open.
  const noOffer = live && offers.length === 0 ? noOfferText(fixture.choices) : "";

  const card = (
    <article
      className="relative isolate overflow-hidden rounded-2xl border border-slate-800/80 bg-gradient-to-br from-[#111d33] via-[#0b1322] to-[#080d18] p-2.5 sm:p-3 flex flex-col gap-2 w-full h-full sm:h-auto"
    >
      {/* The two corners the card carries: the theme's indigo and its mint, both held low so the
          teams stay the brightest thing on the card. */}
      <div className="pointer-events-none absolute -top-10 -left-8 h-24 w-24 rounded-full bg-brand-500/20 blur-2xl" />
      <div className="pointer-events-none absolute -bottom-12 -right-6 h-24 w-24 rounded-full bg-brand-accent/10 blur-2xl" />

      {/* The match's name, in the box that used to sit at the foot of the card: the title first,
          the competition under it when the title did not already say it. The sport's mark sits
          beside the name, small enough to be read and not to shout. */}
      {title || competition ? (
        <div className="relative mb-1 flex items-center justify-center rounded-lg border border-slate-800/80 bg-black/30 px-2 py-1.5">
          {/* The sport's mark sits at the edge of the box, so the name keeps the whole of the
              middle to itself and stays centred on it. */}
          <span className="absolute left-2 top-1/2 -translate-y-1/2">
            <SportMark sport={fixture.sport} />
          </span>
          <span
            className={`min-w-0 px-4 line-clamp-1 text-center font-normal uppercase leading-tight text-slate-200 ${titleSizeClass(
              title || competition
            )}`}
          >
            {title || competition}
          </span>
        </div>
      ) : null}

      {title && competition ? (
        <p className="relative text-center text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500 truncate">
          {competition}
        </p>
      ) : null}

      {/* The two teams, spread across the card: the flags take the two ends and the middle says
          when the match begins — or, once it has begun, that it is running now. The row is pushed
          down, so the air a taller card leaves lands above the flags and never above the bar. */}
      <div className="relative mt-auto flex items-center justify-between gap-1.5 sm:gap-2">
        <div className="flex w-[38px] sm:w-[48px] flex-col items-center gap-1">
          <TeamFlag name={fixture.teamA} logo={fixture.teamALogo} />
          <span className="text-[8px] sm:text-[9px] font-black uppercase tracking-wide text-white text-center leading-tight line-clamp-2">
            {fixture.teamA}
          </span>
        </div>

        {live ? (
          <span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-red-600 px-2 py-1 text-[8px] sm:text-[10px] font-black uppercase tracking-wider text-white">
            <span className="w-1 sm:w-1.5 h-1 sm:h-1.5 rounded-full bg-white animate-ping" />
            LIVE NOW
          </span>
        ) : (
          <div className="flex flex-col items-center gap-0.5 text-center min-w-0">
            <span className="text-[8px] sm:text-[9px] font-bold uppercase tracking-[0.12em] text-slate-500">
              Starts at
            </span>
            <span className="text-[9px] sm:text-[10px] font-black text-slate-200 whitespace-nowrap">
              {day || kickoff.date}
            </span>
            <span className="text-[9px] sm:text-[10px] font-bold text-slate-400 whitespace-nowrap">
              {kickoff.time}
            </span>
          </div>
        )}

        <div className="flex w-[38px] sm:w-[48px] flex-col items-center gap-1">
          <TeamFlag name={fixture.teamB} logo={fixture.teamBLogo} />
          <span className="text-[8px] sm:text-[9px] font-black uppercase tracking-wide text-white text-center leading-tight line-clamp-2">
            {fixture.teamB}
          </span>
        </div>
      </div>

      {/* The foot of the card: the countdown for a match that has not started, and the way in for
          one that has. It sits directly under the teams, so nothing opens up between them. */}
      <div className="relative flex items-center justify-center gap-1.5 rounded-lg border border-slate-800/80 bg-black/30 px-2 py-1.5">
        {live ? (
          noOffer ? (
            <span className="text-center text-[9px] sm:text-[10px] font-bold text-amber-300/90">
              {noOffer}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[9px] sm:text-[11px] font-black uppercase tracking-wider text-emerald-300">
              <Play className="w-3 h-3 fill-emerald-300" />
              Click here to watch live
            </span>
          )
        ) : (
          <span
            title={countdownText(remaining)}
            aria-label={countdownText(remaining)}
            className="text-[10px] sm:text-[12px] font-black tabular-nums text-amber-300/90"
          >
            {countdownLabel(remaining)}
          </span>
        )}
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
        className="block h-full sm:h-auto text-left transition-transform active:scale-[0.99]"
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
        className="block h-full sm:h-auto text-left transition-transform active:scale-[0.99]"
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
  // Which of the cards after the first is on the phone's stage right now.
  const [slide, setSlide] = useState(0);

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

  // The phone's second slot is a stage: every card after the first takes a turn on it, sliding in
  // from the right over the card that was there, and the turn after the last one belongs to the
  // second card again — so the loop never leaves the first card's place.
  useEffect(() => {
    const turns = fixtures.length - 1;
    if (turns < 2) return;
    const timer = window.setInterval(() => setSlide((turn) => (turn + 1) % turns), 5000);
    return () => clearInterval(timer);
  }, [fixtures]);

  if (fixtures.length === 0) return <>{children}</>;

  const choosing = choosingId
    ? fixtures.find((fixture) => fixture.id === choosingId) ?? null
    : null;

  // The stage only starts once there is more than the one card beside it to take turns.
  const stage = fixtures.length > 2;
  const turns = fixtures.length - 1;
  const onStage = turns > 0 ? slide % turns : 0;

  return (
    <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-5">
      {/* The section's own name, so the cards below read as the 24/7 sports section rather than
          as another panel of channels. It appears only when the board has cards to show: an
          empty board is not a section, it is the promo banner that the caller passed in. */}
      <h2 className="text-sm font-black text-white tracking-tight mb-2.5">24/7 Sports</h2>
      {/* Two cards to a line on a phone and four on a desktop. Every card fills its own column, so
          the row starts at the page's left edge and nothing needs a margin to be narrower. */}
      <div className="grid gap-2 sm:gap-3 grid-cols-2 lg:grid-cols-4">
        {/* The first card keeps its place and is never covered by anything. */}
        <FixtureCard key={fixtures[0].id} fixture={fixtures[0]} now={now} onChoose={setChoosingId} />

        {turns > 0 ? (
          /* The stage: on a phone it is the second column, and the cards take turns on it; from
              a tablet up it is no box at all, and its cards are the rest of the row. On the phone
              the cards share one grid cell, so the cell is as tall as the tallest of them and
              every card covers the one it replaces down to the last pixel. */
          <div
            className={`${
              stage ? "relative grid grid-cols-1 overflow-hidden" : ""
            } sm:contents`}
          >
            {fixtures.slice(1).map((fixture, index) => (
              <div
                key={fixture.id}
                className={`h-full ${
                  stage
                    ? `max-sm:[grid-area:1/1] transition-transform duration-700 ease-out sm:translate-x-0 ${
                        index === onStage ? "z-10 translate-x-0" : "z-0 translate-x-full"
                      }`
                    : ""
                }`}
              >
                <FixtureCard fixture={fixture} now={now} onChoose={setChoosingId} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {choosing ? <FixtureChannelDialog fixture={choosing} onClose={closeChooser} /> : null}
    </div>
  );
}
