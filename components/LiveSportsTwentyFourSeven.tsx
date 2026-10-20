"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Radio, RefreshCw, Satellite } from "lucide-react";
import Sports247HlsPlayer from "@/components/Sports247HlsPlayer";

interface TwentyFourSevenCard {
  channelKey: string;
  displayName: string;
  category: string;
  logoUrl: string;
  entryUrl: string;
  expiresAt: number;
  playable: boolean;
}

/**
 * The isolated "24/7 Live Sports" section, backed by the cloud proxy rather than by
 * the app's own channel catalogue. It fetches, renders and plays on its own: nothing
 * here reads or writes the Direct/Secured arena paths, so a change to one cannot
 * reach the other.
 *
 * When the proxy is not configured — or is answering with nothing serving — the
 * section renders no markup at all. An empty framed heading on the homepage would
 * read as a broken feature rather than an unconfigured one.
 */
export default function LiveSportsTwentyFourSeven() {
  const [cards, setCards] = useState<TwentyFourSevenCard[]>([]);
  const [source, setSource] = useState<"proxy" | "mirror" | "none" | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sports-247/channels", { cache: "no-store" });
      const data = await res.json();
      const list: TwentyFourSevenCard[] = Array.isArray(data?.channels) ? data.channels : [];
      setCards(list.filter((card) => typeof card?.channelKey === "string"));
      setSource(data?.ok ? data.source ?? "none" : "none");
    } catch {
      setCards([]);
      setSource("none");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => cards.find((card) => card.channelKey === selectedKey) ?? null,
    [cards, selectedKey]
  );

  if (!loading && cards.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-cyan-400" />
          <h2 className="text-base font-black tracking-tight text-white sm:text-lg">24/7 Live Sports</h2>
          <span className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-300">
            {cards.length} channel{cards.length === 1 ? "" : "s"}
          </span>
        </div>
        <button
          onClick={() => void load()}
          className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-bold text-slate-300 transition-colors hover:bg-white/10"
          title="Re-read the cloud relay"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Relay
        </button>
      </div>

      {/* The proxy is unreachable but the mirror still knows the names, so the cards
          are drawn and the reason is stated once instead of per card. */}
      {source === "mirror" && (
        <p className="rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[11px] font-bold text-amber-300">
          The cloud relay is not responding. Channels are listed but cannot be opened right now.
        </p>
      )}

      {selected?.playable && (
        <Sports247HlsPlayer
          channelKey={selected.channelKey}
          title={selected.displayName}
          category={selected.category || "24/7 Live"}
          entryUrl={selected.entryUrl}
          expiresAt={selected.expiresAt}
        />
      )}

      {loading ? (
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex w-[86px] shrink-0 flex-col items-center gap-2">
              <div className="h-16 w-16 rounded-full bg-[#0d1628] animate-pulse" />
              <div className="h-2.5 w-14 rounded bg-[#0d1628] animate-pulse" />
            </div>
          ))}
        </div>
      ) : (
        <div className="scrollbar-none flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1">
          {cards.map((card) => {
            const active = card.channelKey === selectedKey;
            return (
              <button
                key={card.channelKey}
                onClick={() => setSelectedKey(card.channelKey)}
                className={`flex w-[86px] shrink-0 snap-start cursor-pointer flex-col items-center gap-1.5 rounded-2xl border px-1.5 py-2 transition-colors ${
                  active
                    ? "border-cyan-400/60 bg-cyan-400/10"
                    : "border-white/5 bg-[#0a1222]/60 hover:border-white/15 hover:bg-[#0d1628]"
                }`}
                disabled={!card.playable}
                title={card.playable ? card.displayName : `${card.displayName} — relay unavailable`}
              >
                <span className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-[#060b13]">
                  {card.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={card.logoUrl} alt="" loading="lazy" className="h-full w-full object-contain p-1" />
                  ) : (
                    <Satellite className="h-6 w-6 text-slate-500" />
                  )}
                </span>
                <span
                  className={`line-clamp-2 text-center text-[10px] font-bold leading-tight ${
                    active ? "text-cyan-200" : card.playable ? "text-slate-300" : "text-slate-600"
                  }`}
                >
                  {card.displayName}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
