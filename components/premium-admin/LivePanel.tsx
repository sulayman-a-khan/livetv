"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AdminSection, { SectionBadge } from "@/components/AdminSection";
import { CheckSquare, Loader2, Radio, Square } from "lucide-react";

interface LiveChannel {
  channelId: string;
  name: string;
  category: string;
  logoUrl: string;
  providerId: string;
  streamId: string;
  /** How many backups the row carries. A count, never the ids. */
  backups: number;
  /** The site's switch: is this row shown to viewers? */
  visible: boolean;
  /** The box's switch: is this lane on air? */
  live: boolean;
  /** Whether the box knows this channel at all. */
  onBox: boolean;
  /** What the box says about the lane: serving, inactive, or unusable — or null when it said nothing. */
  boxState: "serving" | "inactive" | "unusable" | null;
  /** The box's own code for why a lane cannot be used, when it gave one. */
  boxProblem: string | null;
}

/**
 * Why the box will not serve a lane, in words.
 *
 * The box sends a code — `provider_disabled`, `provider_unusable`, `row_unusable` — and the
 * panel says what that means. A code in a sentence is a question the admin has to look up.
 */
function problemText(problem: string | null): string {
  if (problem === "provider_disabled") return "the provider is switched off";
  if (problem === "provider_unusable") return "the provider cannot be used";
  if (problem === "row_unusable") return "the channel's own record is broken";
  return "the box will not serve it";
}

/**
 * What the box says about a lane, in words the panel can use.
 *
 * "Serving" is the only state that means a viewer can watch it. A lane the box knows but has
 * taken out of service is not live, and a lane it cannot use is worse than not live.
 */
function stateLabel(channel: LiveChannel): { text: string; className: string } {
  if (!channel.onBox) {
    return { text: "Not on the box", className: "text-slate-500" };
  }
  if (channel.boxState === "unusable" || channel.boxProblem) {
    return { text: `Unusable — ${problemText(channel.boxProblem)}`, className: "text-red-400" };
  }
  if (channel.boxState === "serving") {
    return { text: "Serving on the box", className: "text-emerald-400" };
  }
  if (channel.boxState === "inactive") {
    return { text: "Off air", className: "text-amber-400" };
  }
  // The box did not say. The switch beside it still knows whether the lane is on, so the line
  // follows the switch rather than claiming something the box never said.
  return channel.live
    ? { text: "On air on the box", className: "text-emerald-400" }
    : { text: "Off air", className: "text-amber-400" };
}

/**
 * The Live on Server list: every premium channel, and whether it is on air.
 *
 * Two switches live on a channel and they are not the same switch. The box's says the lane is
 * on — that is what actually plays. The site's says the row is shown to viewers. Both are here
 * because a channel can be live on the box and hidden from the rail, and one can be on the
 * rail with its lane off, and neither of those is visible from a single "active" field.
 *
 * Neither switch edits the channel and neither removes it: editing and deleting stay in the
 * channel list, where the whole row is on show.
 */
export default function LivePanel({
  secretKey,
  open,
  onToggle,
}: {
  secretKey: string;
  open: boolean;
  onToggle: () => void;
}) {
  const [channels, setChannels] = useState<LiveChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reachable, setReachable] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await fetch("/api/admin/premium/live", {
        headers: { "x-admin-secret": secretKey.trim() },
        cache: "no-store",
      });
      const data = await res.json();
      if (seq !== loadSeq.current) return;
      if (data.success) {
        setChannels(Array.isArray(data.channels) ? data.channels : []);
        setReachable(Boolean(data.reachable));
        setAuthorized(Boolean(data.authorized));
        setLoadError(null);
      } else {
        setLoadError(data.error || `Failed to load the live list (${res.status})`);
      }
    } catch (err: any) {
      if (seq !== loadSeq.current) return;
      setLoadError(`Error loading the live list: ${err.message}`);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [secretKey]);

  useEffect(() => {
    if (!open) return;
    load();
  }, [open, load]);

  // A closed panel is not refreshed behind the admin's back, and an open one is never
  // refreshed while a switch is being moved.
  useEffect(() => {
    if (!open || busyId !== null) return;
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [open, busyId, load]);

  /**
   * Moves one of the two switches.
   *
   * Only the one switch is sent. The other is left exactly as it was, because a panel that
   * wrote both would make "put it back on the rail" mean "and switch the lane back on too".
   */
  async function move(channel: LiveChannel, scope: "live" | "visible") {
    setBusyId(channel.channelId);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/premium/live", {
        method: "POST",
        headers: { "x-admin-secret": secretKey.trim(), "Content-Type": "application/json" },
        body: JSON.stringify({
          scope,
          channelId: channel.channelId,
          active: scope === "live" ? !channel.live : !channel.visible,
        }),
        cache: "no-store",
      });
      const data = await res.json();
      if (!data.success) {
        setMessage(data.error || `The change was refused (${res.status})`);
        return;
      }
      setMessage(
        scope === "live"
          ? channel.live
            ? `${channel.name} is off air on the box.`
            : `${channel.name} is on air on the box.`
          : channel.visible
            ? `${channel.name} is hidden from viewers.`
            : `${channel.name} is on the rail again.`
      );
      await load();
    } catch (err: any) {
      setMessage(`The change failed: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  }

  const onAir = channels.filter((c) => c.live).length;
  const shown = channels.filter((c) => c.visible).length;

  return (
    <AdminSection
      title="Live on Server"
      icon={<Radio size={16} />}
      open={open}
      onToggle={onToggle}
      collapsedHint={
        loading
          ? "Loading the live list…"
          : `${onAir} on air · ${shown} on the rail. Two switches: on the box, and on the rail.`
      }
      badge={<SectionBadge text={loading ? "…" : `${onAir}/${channels.length}`} />}
    >
      <div className="space-y-3">
        {loadError && (
          <p className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            {loadError}
          </p>
        )}
        {message && (
          <p className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
            {message}
          </p>
        )}

        {!loading && !reachable && (
          <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
            The stream box did not answer, so nothing can be put on air or taken off it from here.
          </p>
        )}
        {!loading && reachable && !authorized && (
          <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
            The box answered but refused this server&apos;s credential, so its lanes cannot be
            switched.
          </p>
        )}

        {loading && channels.length === 0 ? (
          <p className="text-xs text-slate-400">Loading the live list…</p>
        ) : channels.length === 0 ? (
          <p className="text-xs text-slate-400">
            No premium channels yet. They appear here as soon as they are added.
          </p>
        ) : (
          <ul className="space-y-2">
            {channels.map((channel) => {
              const state = stateLabel(channel);
              const busy = busyId === channel.channelId;
              return (
                <li
                  key={channel.channelId}
                  className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 flex flex-wrap items-center gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-white truncate">
                      {channel.name}
                      <span className="ml-2 text-[10px] font-normal text-slate-400">
                        {channel.category}
                      </span>
                    </p>
                    <p className={`text-[10px] truncate ${state.className}`}>{state.text}</p>
                    <p className="text-[10px] text-slate-500 truncate">
                      {channel.providerId
                        ? `${channel.providerId} · stream ${channel.streamId} · ${channel.backups} backup${
                            channel.backups === 1 ? "" : "s"
                          }`
                        : "No provider — a pushed source"}
                    </p>
                  </div>

                  <div className="flex items-center gap-4 shrink-0">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => move(channel, "live")}
                      title={
                        channel.live
                          ? "Take this lane off air on the box"
                          : "Put this lane on air on the box"
                      }
                      className="flex items-center gap-1.5 text-[11px] text-slate-200 disabled:opacity-40"
                    >
                      {busy ? (
                        <Loader2 size={14} className="animate-spin text-slate-400" />
                      ) : channel.live ? (
                        <CheckSquare size={14} className="text-emerald-400" />
                      ) : (
                        <Square size={14} className="text-slate-500" />
                      )}
                      Live on server
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => move(channel, "visible")}
                      title={
                        channel.visible
                          ? "Hide this channel from viewers"
                          : "Show this channel to viewers"
                      }
                      className="flex items-center gap-1.5 text-[11px] text-slate-200 disabled:opacity-40"
                    >
                      {busy ? (
                        <Loader2 size={14} className="animate-spin text-slate-400" />
                      ) : channel.visible ? (
                        <CheckSquare size={14} className="text-emerald-400" />
                      ) : (
                        <Square size={14} className="text-slate-500" />
                      )}
                      Visible to users
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </AdminSection>
  );
}
