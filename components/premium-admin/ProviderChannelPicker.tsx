"use client";

import { useMemo, useState } from "react";
import { Loader2, RefreshCw, Search } from "lucide-react";
import type { CatalogueChannel } from "./useProviderCatalogue";
import type { StreamSlot } from "./providerChannelPick";

const SLOT_LABEL: Record<StreamSlot, string> = {
  primary: "Plays first",
  backup1: "Backup 1",
  backup2: "Backup 2",
};

/**
 * How many rows are shown at once.
 *
 * An account can hold thousands of channels, so the list is searched rather than shown whole:
 * an account with four thousand channels must not put four thousand rows on a phone.
 */
const MAX_ROWS = 60;

const FIELD_CLASS =
  "w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-brand-500";

/**
 * Picks the channels a provider-backed channel plays from.
 *
 * The account's credential lives in the box, so the account's own panel is the only thing that
 * can say which channels it holds. This list is that answer, read through the box: names,
 * categories and stream ids, and nothing else.
 *
 * An account can also carry a stream the live list does not name, so the ids can still be typed
 * by hand. That is the fallback, not the way: nobody should have to guess a number to add a
 * channel whose name is right here.
 */
export default function ProviderChannelPicker({
  channels,
  loading,
  error,
  slots,
  onPick,
  onManual,
  onClear,
  onReload,
}: {
  channels: CatalogueChannel[];
  loading: boolean;
  error: string | null;
  slots: Record<StreamSlot, string>;
  onPick: (channel: CatalogueChannel, slot: StreamSlot) => void;
  onManual: (slot: StreamSlot, value: string) => void;
  onClear: (slot: StreamSlot) => void;
  onReload: () => void;
}) {
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return channels.slice(0, MAX_ROWS);
    const found: CatalogueChannel[] = [];
    for (const channel of channels) {
      if (
        channel.name.toLowerCase().includes(q) ||
        channel.category.toLowerCase().includes(q) ||
        channel.streamId.toLowerCase().includes(q)
      ) {
        found.push(channel);
        if (found.length >= MAX_ROWS) break;
      }
    }
    return found;
  }, [channels, query]);

  /** The name a picked stream id goes by, when the list still knows it. */
  const nameOf = (streamId: string) =>
    channels.find((channel) => channel.streamId === streamId)?.name || streamId;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
          Channels in this account
        </p>
        <button
          type="button"
          onClick={onReload}
          className="ml-auto flex items-center gap-1 text-[10px] font-bold text-slate-400 hover:text-white"
        >
          {loading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
          Read again
        </button>
      </div>

      {error && (
        <p className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2 py-1.5">
          {error}
        </p>
      )}

      <div className="space-y-1.5">
        {(["primary", "backup1", "backup2"] as StreamSlot[]).map((slot) => (
          <div key={slot} className="flex items-center gap-2 text-[11px]">
            <span className="text-slate-500 w-20 shrink-0">{SLOT_LABEL[slot]}</span>
            {manual ? (
              <input
                className={FIELD_CLASS}
                value={slots[slot]}
                onChange={(e) => onManual(slot, e.target.value)}
                placeholder="stream ID"
              />
            ) : (
              <span className="text-slate-200 truncate">
                {slots[slot] ? `${nameOf(slots[slot])} · ${slots[slot]}` : "— not chosen —"}
              </span>
            )}
            {slots[slot] && (
              <button
                type="button"
                onClick={() => onClear(slot)}
                className="text-[10px] font-bold text-slate-500 hover:text-white shrink-0"
              >
                Clear
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        {!manual && (
          <div className="relative flex-1">
            <Search size={11} className="absolute left-2.5 top-2.5 text-slate-500" />
            <input
              className={`${FIELD_CLASS} pl-7`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, category or ID"
            />
          </div>
        )}
        <button
          type="button"
          onClick={() => setManual((value) => !value)}
          className={`text-[10px] font-bold text-slate-400 hover:text-white ${manual ? "ml-auto" : ""}`}
        >
          {manual ? "Pick from the list" : "Type the IDs"}
        </button>
      </div>

      {!manual && (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-800 divide-y divide-slate-800/70">
          {loading && channels.length === 0 && (
            <p className="px-2.5 py-2 text-[11px] text-slate-500">Asking the account…</p>
          )}
          {!loading && channels.length === 0 && !error && (
            <p className="px-2.5 py-2 text-[11px] text-slate-500">
              This account lists no live channels. Type the IDs instead.
            </p>
          )}
          {query.trim() && matches.length === 0 && (
            <p className="px-2.5 py-2 text-[11px] text-slate-500">Nothing matches “{query.trim()}”.</p>
          )}
          {matches.map((channel) => (
            <div key={channel.streamId} className="flex items-center gap-2 px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] text-white truncate">{channel.name}</p>
                <p className="text-[10px] text-slate-500 truncate">
                  {channel.category || "No category"} · {channel.streamId}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => onPick(channel, "primary")}
                  className="text-[10px] font-bold px-1.5 py-1 rounded bg-brand-600/80 hover:bg-brand-500 text-white"
                >
                  Play
                </button>
                <button
                  type="button"
                  onClick={() => onPick(channel, "backup1")}
                  className="text-[10px] font-bold px-1.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  B1
                </button>
                <button
                  type="button"
                  onClick={() => onPick(channel, "backup2")}
                  className="text-[10px] font-bold px-1.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  B2
                </button>
              </div>
            </div>
          ))}
          {query.trim() && matches.length === MAX_ROWS && (
            <p className="px-2.5 py-1.5 text-[10px] text-slate-500">
              First {MAX_ROWS} matches — narrow the search to see the rest.
            </p>
          )}
        </div>
      )}

      <p className="text-[10px] text-slate-500">
        The box plays the first stream and falls back to Backup 1, then Backup 2, if the one
        before it fails. All three are streams of the account above.
      </p>
    </div>
  );
}
