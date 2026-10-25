"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ChoiceState, FixtureChoice, PublicFixture } from "@/lib/fixtureBoard";

/**
 * The channel picker a fixture card opens when the match is linked to more than one channel.
 *
 * It does not play anything and it does not fetch anything: every row is either a link to a route
 * that already exists — `/watch/…` for a direct channel, `/premium/…` for a secured one — or the
 * channel named with the reason it cannot be opened right now. So the dialog cannot invent a second
 * delivery path, cannot reach the stream box, and cannot learn a source line even if it wanted to:
 * the payload it is handed has none.
 */

/** The reason a choice is on the card but not openable, in the words a viewer reads. */
export function unavailableText(state: ChoiceState): string {
  if (state === "box-offline") return "প্রিমিয়াম স্ট্রিম এখন চালু নেই।";
  if (state === "not-pushed") return "এই চ্যানেলের স্ট্রিম এখনও যোগ করা হয়নি।";
  return "চ্যানেলটি এখন অফ-এয়ার।";
}

/** Which tier a row comes from, in the same words the rest of the app uses for them. */
const TIER_LABEL: Record<FixtureChoice["sourceType"], string> = {
  direct: "Direct",
  secured: "Premium",
};

/** What Tab reaches inside the dialog, in the order it reaches it. */
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function ChoiceRow({ choice }: { choice: FixtureChoice }) {
  const [logoBroken, setLogoBroken] = useState(false);

  const detail = choice.watchPath
    ? `${TIER_LABEL[choice.sourceType]} · ${choice.category}`
    : unavailableText(choice.state);

  return (
    <div className="flex flex-col gap-1">
      {choice.watchPath ? (
        <Link
          href={choice.watchPath}
          className="flex items-center gap-2.5 rounded-xl border border-slate-700/70 bg-white/[0.04] p-2.5 transition-colors active:bg-white/[0.08]"
        >
          <ChoiceMark choice={choice} broken={logoBroken} onBroken={() => setLogoBroken(true)} />
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-bold text-slate-100 truncate">
              {choice.name}
            </span>
            <span className="block text-[10px] font-bold text-slate-400 truncate">{detail}</span>
          </span>
          <span className="text-[11px] font-black text-emerald-400 shrink-0">▶</span>
        </Link>
      ) : (
        // Reachable by keyboard so the reason is read rather than guessed at, but refusing the
        // tap rather than leading it somewhere that has nothing to play.
        <div
          tabIndex={0}
          aria-disabled="true"
          className="flex items-center gap-2.5 rounded-xl border border-slate-800/60 p-2.5 opacity-60"
        >
          <ChoiceMark choice={choice} broken={logoBroken} onBroken={() => setLogoBroken(true)} />
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-bold text-slate-300 truncate">
              {choice.name}
            </span>
            <span className="block text-[10px] font-bold text-amber-300/90 truncate">{detail}</span>
          </span>
        </div>
      )}
    </div>
  );
}

function ChoiceMark({
  choice,
  broken,
  onBroken,
}: {
  choice: FixtureChoice;
  broken: boolean;
  onBroken: () => void;
}) {
  return choice.logoUrl && !broken ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={choice.logoUrl}
      alt=""
      className="w-7 h-7 rounded-lg object-contain bg-white/95 border border-slate-700 shrink-0"
      onError={onBroken}
    />
  ) : (
    <span className="w-7 h-7 rounded-lg bg-white/10 border border-slate-700 shrink-0" />
  );
}

export default function FixtureChannelDialog({
  fixture,
  onClose,
}: {
  fixture: PublicFixture;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const panel = panelRef.current;
    const restoreTo = document.activeElement as HTMLElement | null;
    // Straight onto the first channel a viewer can pick, so the keyboard and a screen reader land on
    // the choices rather than on the panel or on cancel, and a phone's first tap needs no scrolling.
    // With nothing openable, the first thing that can be reached is the honest stop.
    const target =
      panel?.querySelector<HTMLElement>("a[href]") ??
      panel?.querySelector<HTMLElement>(FOCUSABLE) ??
      panel;
    target?.focus();

    return () => {
      // Back to the card that opened this — unless the tap navigated away and the board, with it,
      // is gone.
      if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      role="presentation"
      onClick={(event) => {
        // Only the backdrop itself cancels: a tap on a row belongs to that row.
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center sm:p-4"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fixture-chooser-match"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="w-full sm:max-w-md max-h-[80vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-slate-800/80 bg-[#0a1222] p-3 flex flex-col gap-2 outline-none"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide truncate">
              {fixture.competition || (fixture.sport === "cricket" ? "Cricket" : "Football")}
              {fixture.phase === "live" ? " · LIVE" : ""}
            </p>
            <h2
              id="fixture-chooser-match"
              className="text-sm font-black text-white truncate"
            >{`${fixture.teamA} vs ${fixture.teamB}`}</h2>
            <p className="text-[11px] font-bold text-slate-400">কোন চ্যানেলে দেখবেন?</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="বন্ধ করুন"
            className="w-7 h-7 shrink-0 rounded-lg border border-slate-700/70 text-slate-300 text-xs font-black"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          {fixture.choices.map((choice) => (
            <ChoiceRow key={`${choice.sourceType}:${choice.channelId}`} choice={choice} />
          ))}
        </div>
      </div>
    </div>
  );
}
