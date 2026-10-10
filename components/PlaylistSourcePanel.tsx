"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AdminSection, { SectionBadge } from "@/components/AdminSection";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Edit2,
  Layers,
  Loader2,
  PlusCircle,
  RefreshCw,
  Save,
  Square,
  CheckSquare,
  Trash2,
  X,
} from "lucide-react";

/** Mirrors PLAYLIST_SOURCE_TYPES in models/PlaylistSource (kept local: that file pulls in mongoose). */
const SOURCE_TYPES = [
  { value: "github-raw", label: "GitHub raw M3U" },
  { value: "m3u", label: "Public M3U" },
  { value: "m3u8", label: "Public M3U8" },
  { value: "other", label: "Other" },
];

interface SourceRow {
  _id: string;
  name: string;
  url: string;
  sourceType: string;
  active: boolean;
  monitored: boolean;
  lastStatus: string;
  lastError: string;
  consecutiveFetchFailures: number;
  lastCheckedAt: string | null;
  lastSyncAt: string | null;
  lastChangeAt: string | null;
  entriesParsed: number;
  summary: Record<string, number>;
  counts: { entries: number; present: number; missing: number; channels: number };
  nextCheckAt: string | null;
  dueNow: boolean;
}

interface MonitorStatus {
  running: boolean;
  dueTickMinutes: number;
  checkIntervalHours: number;
  /** UTC hour the one daily source check is anchored to. */
  syncHourUtc: number;
  nextScheduledSyncAt: string;
  lastTickAt: string | null;
  lastResult: unknown;
}

interface Totals {
  sources: number;
  active: number;
  monitored: number;
  due: number;
  entries: number;
}

interface SyncProgress {
  sourceId: string;
  sourceName: string;
  phase: string;
  message: string;
  lines: string[];
  current: number;
  total: number;
  percent: number;
  done: boolean;
  failed: boolean;
}

interface SourceForm {
  name: string;
  url: string;
  sourceType: string;
  active: boolean;
  monitored: boolean;
}

const EMPTY_FORM: SourceForm = {
  name: "",
  url: "",
  sourceType: "m3u",
  active: true,
  monitored: true,
};

function relative(iso: string | null, now: number): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${String(min % 60).padStart(2, "0")}m ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function countdown(iso: string | null, now: number): string {
  if (!iso) return "now";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "now";
  const diff = t - now;
  if (diff <= 0) return "due now";
  const min = Math.floor(diff / 60_000);
  const hr = Math.floor(min / 60);
  if (hr > 0) return `in ${hr}h ${String(min % 60).padStart(2, "0")}m`;
  if (min > 0) return `in ${min}m`;
  return `in ${Math.floor((diff % 60_000) / 1000)}s`;
}

/** One-line result sentence from the last sync's counters. */
function summarySentence(summary: Record<string, number>): string {
  const parts: string[] = [];
  if (summary.newEntries) parts.push(`${summary.newEntries} new entr${summary.newEntries === 1 ? "y" : "ies"}`);
  if (summary.updatedUrls) parts.push(`${summary.updatedUrls} URL(s) updated`);
  if (summary.linksAddedActive) parts.push(`${summary.linksAddedActive} link(s) added active`);
  if (summary.linksAddedBroken) parts.push(`${summary.linksAddedBroken} held as candidate`);
  if (summary.linksRevived) parts.push(`${summary.linksRevived} link(s) revived`);
  if (summary.linksRetired) parts.push(`${summary.linksRetired} link(s) retired`);
  if (summary.entriesRemoved) parts.push(`${summary.entriesRemoved} entr${summary.entriesRemoved === 1 ? "y" : "ies"} unavailable`);
  return parts.length ? parts.join(" · ") : "No changes";
}

interface PlaylistSourcePanelProps {
  secretKey: string;
  /** A sync mutates Channel / StreamLink rows, so the rest of the dashboard must re-read. */
  onCatalogueChanged: () => void;
  /** The panel is one of the dashboard's collapsible sections; the page owns which are open. */
  open: boolean;
  onToggle: () => void;
}

export default function PlaylistSourcePanel({
  secretKey,
  onCatalogueChanged,
  open,
  onToggle,
}: PlaylistSourcePanelProps) {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [monitor, setMonitor] = useState<MonitorStatus | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SourceForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [forceRecheck, setForceRecheck] = useState(false);

  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [resultLog, setResultLog] = useState<string | null>(null);

  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  const headers = useMemo(
    () => ({
      "Content-Type": "application/json",
      "x-admin-secret": secretKey.trim(),
    }),
    [secretKey]
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/playlist-sources", {
        headers: { "x-admin-secret": secretKey.trim() },
        cache: "no-store",
      });
      const data = await res.json();
      if (data.success) {
        setSources(data.sources as SourceRow[]);
        setMonitor(data.monitor as MonitorStatus);
        setTotals(data.totals as Totals);
        setLoadError(null);
      } else {
        setLoadError(data.error || `Failed to load playlist sources (${res.status})`);
      }
    } catch (err: any) {
      setLoadError(`Error loading playlist sources: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [secretKey]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the countdowns moving, and refresh the list while nothing is syncing.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (syncingId) return;
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load, syncingId]);

  const openAddForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormError(null);
    setShowForm(true);
  };

  const openEditForm = (src: SourceRow) => {
    setForm({
      name: src.name,
      url: src.url,
      sourceType: src.sourceType,
      active: src.active,
      monitored: src.monitored,
    });
    setEditingId(src._id);
    setFormError(null);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch(
        editingId ? `/api/admin/playlist-sources/${editingId}` : "/api/admin/playlist-sources",
        {
          method: editingId ? "PATCH" : "POST",
          headers,
          body: JSON.stringify({ ...form, secretKey: secretKey.trim() }),
        }
      );
      const data = await res.json();
      if (!data.success) throw new Error(data.error || `Request failed (${res.status})`);
      closeForm();
      await load();
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleField = async (src: SourceRow, field: "active" | "monitored") => {
    setTogglingId(`${src._id}:${field}`);
    try {
      const res = await fetch(`/api/admin/playlist-sources/${src._id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ [field]: !src[field], secretKey: secretKey.trim() }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Update failed");
      await load();
    } catch (err: any) {
      setLoadError(`Could not update ${src.name}: ${err.message}`);
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (src: SourceRow) => {
    const ok = confirm(
      `Remove playlist source "${src.name}"?\n\nIts ${src.counts.entries} tracked playlist entries are deleted.\nChannels and stream links it provided are LEFT IN PLACE — removing a source never removes the library.`
    );
    if (!ok) return;

    setDeletingId(src._id);
    try {
      const res = await fetch(`/api/admin/playlist-sources/${src._id}`, {
        method: "DELETE",
        headers: { "x-admin-secret": secretKey.trim() },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Delete failed");
      setResultLog(data.message);
      await load();
    } catch (err: any) {
      setLoadError(`Could not delete ${src.name}: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  const handleSync = async (src: SourceRow) => {
    if (syncingId) return;
    setSyncingId(src._id);
    setResultLog(null);
    setLoadError(null);
    setProgress({
      sourceId: src._id,
      sourceName: src.name,
      phase: "Connecting",
      message: "Contacting server...",
      lines: [],
      current: 0,
      total: 0,
      percent: 0,
      done: false,
      failed: false,
    });

    const pushLine = (line: string) =>
      setProgress((p) => (p ? { ...p, lines: [...p.lines.slice(-80), line] } : p));

    let catalogueChanged = false;

    try {
      const res = await fetch(`/api/admin/playlist-sources/${src._id}/sync`, {
        method: "POST",
        headers,
        body: JSON.stringify({ force: forceRecheck, secretKey: secretKey.trim() }),
      });

      // Auth / unknown-source failures come back as plain JSON, not a stream.
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError: string | null = null;
      let finalText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";

        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;

          let evt: any;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }

          switch (evt.phase) {
            case "fetch":
              setProgress((p) => (p ? { ...p, phase: "Downloading", message: evt.message } : p));
              pushLine(evt.message);
              break;
            case "parse":
              setProgress((p) =>
                p ? { ...p, phase: "Comparing", message: evt.message, total: evt.total ?? p.total } : p
              );
              pushLine(evt.message);
              catalogueChanged = true;
              break;
            case "unchanged":
              setProgress((p) =>
                p ? { ...p, phase: "Unchanged", message: evt.message, percent: 100 } : p
              );
              pushLine(evt.message);
              break;
            case "probe": {
              const label =
                evt.status === "active"
                  ? "WORKING"
                  : evt.status === "unavailable"
                  ? "not working"
                  : evt.status;
              setProgress((p) =>
                p
                  ? {
                      ...p,
                      phase: "Verifying streams",
                      current: evt.index,
                      total: evt.total,
                      percent: evt.percent ?? p.percent,
                      message: `Verifying ${evt.index}/${evt.total} — ${evt.name}`,
                    }
                  : p
              );
              pushLine(`[${evt.index}/${evt.total}] ${evt.name} → ${label}`);
              break;
            }
            case "apply":
              setProgress((p) => (p ? { ...p, phase: "Applying", message: evt.message, percent: 100 } : p));
              pushLine(evt.message);
              catalogueChanged = true;
              break;
            case "done": {
              const s = evt.summary || {};
              finalText = `${s.status === "failed" ? "Failed" : s.changed ? "Synced" : "No change"} — ${
                s.status === "failed" ? s.error : summarySentence(s.stats || {})
              }`;
              setProgress((p) =>
                p
                  ? {
                      ...p,
                      phase: s.status === "failed" ? "Failed" : "Complete",
                      message: s.status === "unchanged" ? "Playlist is byte-identical to the last check." : finalText,
                      percent: 100,
                      done: true,
                      failed: s.status === "failed",
                    }
                  : p
              );
              if (s.status !== "unchanged") catalogueChanged = true;
              break;
            }
            case "error":
              streamError = evt.error || "Unknown sync error";
              break;
          }
        }
      }

      if (streamError) throw new Error(streamError);

      if (finalText) {
        setResultLog(`${src.name}: ${finalText}`);
      } else {
        setResultLog(`${src.name}: check finished (the connection closed before the summary — state is saved, re-run to resume).`);
      }
    } catch (err: any) {
      setLoadError(`Sync of ${src.name} failed: ${err.message}`);
      setProgress((p) => (p ? { ...p, phase: "Failed", message: err.message, done: true, failed: true } : p));
    } finally {
      setSyncingId(null);
      await load();
      if (catalogueChanged) onCatalogueChanged();
    }
  };

  return (
    <AdminSection
      title="Direct HLS Playlist Sources"
      icon={<Layers className="w-5 h-5" />}
      open={open}
      onToggle={onToggle}
      collapsedHint="Daily playlist feeds that add, refresh and retire mirrors on their own."
      badge={
        syncingId || (progress && !progress.done) ? (
          <SectionBadge text="Syncing…" tone="amber" />
        ) : (
          <SectionBadge text={`${sources.length} Sources`} />
        )
      }
      actions={
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={forceRecheck}
              onChange={(e) => setForceRecheck(e.target.checked)}
              className="accent-brand-500"
            />
            <span>Force re-check</span>
          </label>

          <button
            onClick={load}
            disabled={loading}
            className="p-2 bg-slate-900 text-slate-300 hover:text-white rounded-xl border border-slate-800 hover:border-slate-700 transition-colors"
            title="Reload sources"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>

          <button
            onClick={openAddForm}
            disabled={showForm && !editingId}
            className="flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-xs font-bold transition-all disabled:opacity-40 shadow-lg shadow-brand-600/25"
          >
            <PlusCircle className="w-4 h-4" />
            <span>Add Playlist Source</span>
          </button>
        </div>
      }
    >
      <p className="text-[11px] text-slate-400 leading-relaxed">
        Each source is checked automatically once a day. When its playlist changes, new channels are detected,
        changed stream URLs are attached to the <span className="text-slate-300 font-semibold">same channel card</span>{" "}
        (never a duplicate), and every new URL is verified before it can become the primary link. A failed fetch never
        touches working data.
      </p>

      {/* Monitor status strip */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 mb-4">
        <div className="px-3 py-2 rounded-xl bg-slate-900/70 border border-slate-800">
          <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
            Daily Sync · {monitor ? `${String(monitor.syncHourUtc).padStart(2, "0")}:00 UTC` : "—"}
          </p>
          <p className={`text-xs font-bold ${monitor?.running ? "text-emerald-400" : "text-amber-400"}`}>
            {monitor?.running ? "Active on server" : "Runs from the scheduled job"}
          </p>
          <p className="text-[10px] text-slate-500">
            {monitor ? `next in ${countdown(monitor.nextScheduledSyncAt, nowTick)}` : ""}
          </p>
        </div>
        <div className="px-3 py-2 rounded-xl bg-slate-900/70 border border-slate-800">
          <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Sources / Monitoring</p>
          <p className="text-xs font-bold text-white">
            {totals ? `${totals.active} of ${totals.sources} active` : "—"}
            {totals ? ` · ${totals.monitored} monitored` : ""}
          </p>
        </div>
        <div className="px-3 py-2 rounded-xl bg-slate-900/70 border border-slate-800">
          <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Due For Check</p>
          <p className={`text-xs font-bold ${totals?.due ? "text-brand-400" : "text-slate-300"}`}>
            {totals ? `${totals.due} source(s)` : "—"}
          </p>
        </div>
        <div className="px-3 py-2 rounded-xl bg-slate-900/70 border border-slate-800">
          <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Tracked Entries</p>
          <p className="text-xs font-bold text-white">{totals ? totals.entries : "—"}</p>
        </div>
      </div>

      {loadError && (
        <div className="mb-4 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs font-mono break-words">
          {loadError}
        </div>
      )}

      {resultLog && (
        <div className="mb-4 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-mono break-words">
          {resultLog}
        </div>
      )}

      {/* Add / edit form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="mb-5 p-4 rounded-xl bg-slate-950 border border-brand-500/30 space-y-3"
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold text-white uppercase tracking-wider">
              {editingId ? "Edit playlist source" : "New playlist source"}
            </p>
            <button
              type="button"
              onClick={closeForm}
              className="text-slate-500 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">Source name</label>
              <input
                type="text"
                required
                maxLength={120}
                placeholder="Sports Global M3U"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full bg-slate-900 text-xs text-white placeholder-slate-600 px-4 py-2.5 rounded-xl border border-slate-800 focus:outline-none focus:border-brand-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">Source type</label>
              <select
                value={form.sourceType}
                onChange={(e) => setForm((f) => ({ ...f, sourceType: e.target.value }))}
                className="w-full bg-slate-900 text-xs text-white px-4 py-2.5 rounded-xl border border-slate-800 focus:outline-none focus:border-brand-500"
              >
                {SOURCE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">Playlist URL (M3U / M3U8)</label>
            <input
              type="url"
              required
              placeholder="https://raw.githubusercontent.com/user/lists/main/sports.m3u"
              value={form.url}
              onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              className="w-full bg-slate-900 text-xs font-mono text-slate-200 placeholder-slate-600 px-4 py-2.5 rounded-xl border border-slate-800 focus:outline-none focus:border-brand-500"
            />
            {editingId && (
              <p className="text-[10px] text-slate-500 mt-1">
                Changing the URL re-points this source to a different playlist: its tracked entries are cleared and
                re-detected on the next check. Channels and links already in the catalogue are not removed.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, active: !f.active }))}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all ${
                form.active
                  ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40"
                  : "bg-slate-900 text-slate-400 border-slate-800"
              }`}
            >
              {form.active ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
              <span>{form.active ? "Active" : "Inactive"}</span>
            </button>

            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, monitored: !f.monitored }))}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all ${
                form.monitored
                  ? "bg-brand-500/20 text-brand-300 border-brand-500/40"
                  : "bg-slate-900 text-slate-400 border-slate-800"
              }`}
            >
              {form.monitored ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
              <span>{form.monitored ? "Daily monitoring on" : "Daily monitoring off"}</span>
            </button>
          </div>

          {formError && (
            <p className="text-[11px] font-bold text-red-400">{formError}</p>
          )}

          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-xs font-bold transition-all disabled:opacity-50 shadow-lg shadow-brand-600/25"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            <span>{saving ? "Saving..." : editingId ? "Save Changes" : "Add Source"}</span>
          </button>
        </form>
      )}

      {/* Source list */}
      {sources.length === 0 && !loading ? (
        <div className="py-10 text-center">
          <Layers className="w-8 h-8 text-slate-600 mx-auto mb-2" />
          <p className="text-xs font-bold text-slate-300">No playlist sources configured</p>
          <p className="text-[11px] text-slate-500 mt-1">
            Add a public M3U / M3U8 URL to have it checked daily and kept in sync automatically.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {sources.map((src) => {
            const isRunning = syncingId === src._id;
            const statusColor =
              src.lastStatus === "failed"
                ? "bg-red-400"
                : src.lastStatus === "unchanged"
                ? "bg-slate-500"
                : src.lastStatus === "ok"
                ? "bg-emerald-400"
                : "bg-slate-600";

            return (
              <div
                key={src._id}
                className={`rounded-xl border transition-colors ${
                  isRunning
                    ? "border-brand-500/40 bg-brand-500/5"
                    : "border-slate-800 bg-slate-950/60"
                }`}
              >
                <div className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${statusColor}`} />
                        <h3 className="text-sm font-bold text-white truncate" title={src.name}>
                          {src.name}
                        </h3>
                        <span className="px-2 py-0.5 rounded-md bg-brand-500/10 border border-brand-500/30 text-brand-300 text-[10px] font-medium">
                          {SOURCE_TYPES.find((t) => t.value === src.sourceType)?.label || src.sourceType}
                        </span>
                        {!src.active && (
                          <span className="px-2 py-0.5 rounded-md bg-slate-900 border border-slate-800 text-slate-400 text-[10px] font-medium">
                            Inactive
                          </span>
                        )}
                        {src.active && !src.monitored && (
                          <span className="px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[10px] font-medium">
                            Manual only
                          </span>
                        )}
                        {src.dueNow && (
                          <span className="px-2 py-0.5 rounded-md bg-brand-500/10 border border-brand-500/30 text-brand-300 text-[10px] font-medium">
                            Due for check
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] font-mono text-slate-500 truncate mt-1" title={src.url}>
                        {src.url}
                      </p>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => toggleField(src, "active")}
                        disabled={togglingId === `${src._id}:active`}
                        title={src.active ? "Deactivate source (keeps all channels/links)" : "Activate source"}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border transition-all disabled:opacity-50 ${
                          src.active
                            ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/30"
                            : "bg-slate-900 text-slate-400 border-slate-800 hover:text-emerald-400 hover:border-emerald-500/30"
                        }`}
                      >
                        <CheckSquare className="w-3 h-3" />
                        <span className="hidden sm:inline">{src.active ? "Active" : "Inactive"}</span>
                      </button>

                      <button
                        onClick={() => toggleField(src, "monitored")}
                        disabled={togglingId === `${src._id}:monitored`}
                        title={src.monitored ? "Stop daily auto-checks" : "Include in daily auto-checks"}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border transition-all disabled:opacity-50 ${
                          src.monitored
                            ? "bg-brand-500/20 text-brand-300 border-brand-500/40 hover:bg-brand-500/30"
                            : "bg-slate-900 text-slate-400 border-slate-800 hover:text-brand-300 hover:border-brand-500/30"
                        }`}
                      >
                        <Clock className="w-3 h-3" />
                        <span className="hidden sm:inline">{src.monitored ? "Monitoring" : "Paused"}</span>
                      </button>

                      <button
                        onClick={() => openEditForm(src)}
                        disabled={isRunning}
                        className="p-1.5 bg-slate-900 text-slate-400 hover:text-white rounded-lg border border-slate-800 hover:border-slate-700 transition-colors disabled:opacity-40"
                        title="Edit source"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => handleDelete(src)}
                        disabled={deletingId === src._id || isRunning}
                        className="p-1.5 bg-slate-900 text-red-400 hover:text-red-300 rounded-lg border border-slate-800 hover:border-red-500/40 transition-colors disabled:opacity-40"
                        title="Remove source (channels and links are kept)"
                      >
                        <Trash2 className={`w-3.5 h-3.5 ${deletingId === src._id ? "animate-pulse" : ""}`} />
                      </button>
                    </div>
                  </div>

                  {/* Sync state */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                    <div className="px-2 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800">
                      <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Entries</p>
                      <p className="text-[11px] font-mono text-slate-200">
                        {src.counts.present} present
                        {src.counts.missing > 0 && (
                          <span className="text-red-400"> · {src.counts.missing} gone</span>
                        )}
                      </p>
                    </div>
                    <div className="px-2 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800">
                      <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Channels fed</p>
                      <p className="text-[11px] font-mono text-slate-200">{src.counts.channels}</p>
                    </div>
                    <div className="px-2 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800">
                      <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Last checked</p>
                      <p className="text-[11px] font-mono text-slate-200" title={src.lastCheckedAt || ""}>
                        {relative(src.lastCheckedAt, nowTick)}
                      </p>
                    </div>
                    <div className="px-2 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800">
                      <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Next auto-check</p>
                      <p className="text-[11px] font-mono text-slate-200">
                        {src.active && src.monitored ? countdown(src.nextCheckAt, nowTick) : "monitoring off"}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-slate-500">
                    <span>last successful sync: {relative(src.lastSyncAt, nowTick)}</span>
                    <span>last change detected: {relative(src.lastChangeAt, nowTick)}</span>
                    {src.entriesParsed > 0 && <span>parsed: {src.entriesParsed} entries</span>}
                    {src.lastStatus !== "failed" && (
                      <span className="text-slate-400">{summarySentence(src.summary)}</span>
                    )}
                  </div>

                  {src.lastStatus === "failed" && src.lastError && (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                      <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                      <p className="text-[11px] font-mono text-red-300 break-words">
                        {src.lastError}
                        {src.consecutiveFetchFailures > 0 && (
                          <span className="text-red-400/70">
                            {" "}
                            ({src.consecutiveFetchFailures} failed check{src.consecutiveFetchFailures === 1 ? "" : "s"} in a row —
                            last good data is still being served)
                          </span>
                        )}
                      </p>
                    </div>
                  )}

                  {progress && progress.sourceId === src._id && (
                    <div className="rounded-xl bg-slate-950 border border-slate-800 overflow-hidden">
                      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-slate-800 bg-slate-900/60">
                        <div className="flex items-center gap-2 min-w-0">
                          {progress.done ? (
                            progress.failed ? (
                              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                            ) : (
                              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                            )
                          ) : (
                            <Loader2 className="w-4 h-4 text-brand-400 animate-spin shrink-0" />
                          )}
                          <span className="text-xs font-bold text-white truncate">{progress.phase}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[11px] font-mono font-bold text-slate-400">
                            {progress.total > 0
                              ? `${progress.current}/${progress.total} • ${progress.percent}%`
                              : `${progress.percent}%`}
                          </span>
                          {progress.done && (
                            <button
                              onClick={() => setProgress(null)}
                              className="text-slate-500 hover:text-white transition-colors"
                              title="Hide console"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="h-1.5 w-full bg-slate-900">
                        <div
                          className={`h-full transition-all duration-300 ${
                            progress.failed ? "bg-red-500" : progress.done ? "bg-emerald-500" : "bg-brand-500"
                          }`}
                          style={{ width: `${Math.min(100, Math.max(2, progress.percent))}%` }}
                        />
                      </div>

                      <div className="px-4 py-2 text-[11px] font-mono text-slate-400 border-b border-slate-800/60 truncate">
                        {progress.message}
                      </div>

                      <div className="max-h-48 overflow-y-auto px-4 py-2 space-y-0.5 text-[11px] font-mono">
                        {progress.lines.map((line, i) => (
                          <div
                            key={i}
                            className={
                              line.includes("→ WORKING")
                                ? "text-emerald-400"
                                : line.includes("→ not working") || line.includes("→ probe-error")
                                ? "text-red-400/80"
                                : "text-slate-400"
                            }
                          >
                            {line}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <p className="text-[10px] text-slate-600">
                      Each channel keeps its own source: syncing this playlist never re-points other channels.
                    </p>
                    <button
                      onClick={() => handleSync(src)}
                      disabled={Boolean(syncingId)}
                      className="flex items-center gap-2 px-3.5 py-2 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-[11px] font-bold transition-all disabled:opacity-40 shadow-lg shadow-brand-600/25 shrink-0"
                    >
                      {isRunning ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {isRunning
                          ? progress
                            ? `${progress.phase}...`
                            : "Working..."
                          : forceRecheck
                          ? "Force Re-check Now"
                          : "Check Now"}
                      </span>
                    </button>
                  </div>
                </div>

                {progress && progress.sourceId === src._id && !progress.done && (
                  <div className="px-4 py-2 border-t border-slate-800 flex items-center gap-2 text-[10px] font-mono text-slate-500">
                    <ChevronDown className="w-3 h-3" />
                    <span>Live sync console — do not close the dashboard until it reports Complete.</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </AdminSection>
  );
}
