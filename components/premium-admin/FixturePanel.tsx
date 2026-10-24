"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AdminSection, { SectionBadge } from "@/components/AdminSection";
import {
  CheckSquare,
  CalendarClock,
  Edit2,
  Loader2,
  PlusCircle,
  Save,
  Square,
  Trash2,
  X,
} from "lucide-react";

interface FixtureRow {
  _id: string;
  sport: "football" | "cricket";
  teamA: string;
  teamB: string;
  teamALogo: string;
  teamBLogo: string;
  competition: string;
  startsAt: string;
  durationMinutes: number;
  premiumChannelId: string | null;
  visible: boolean;
  phase: "upcoming" | "live" | "finished";
}

interface OptionRow {
  _id: string;
  name: string;
}

interface FormState {
  sport: "football" | "cricket";
  teamA: string;
  teamB: string;
  teamALogo: string;
  teamBLogo: string;
  competition: string;
  /** Local wall clock as typed into the datetime field. */
  startsAt: string;
  durationMinutes: string;
  premiumChannelId: string;
  visible: boolean;
}

const EMPTY_FORM: FormState = {
  sport: "football",
  teamA: "",
  teamB: "",
  teamALogo: "",
  teamBLogo: "",
  competition: "",
  startsAt: "",
  durationMinutes: "120",
  premiumChannelId: "",
  visible: false,
};

const FIELD_CLASS =
  "w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-brand-500";
const LABEL_CLASS = "block text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1";

const PHASE_STYLE: Record<FixtureRow["phase"], string> = {
  upcoming: "bg-slate-800 text-slate-300 border-slate-700",
  live: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  finished: "bg-slate-900 text-slate-500 border-slate-800",
};

/** The value a `datetime-local` input wants: no seconds, no zone. */
function toInputValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

function countdown(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "now";
  const total = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * The manual fixture board. Every match on it was typed in by the admin: there is
 * no schedule feed behind this panel, and a new fixture starts unpublished so an
 * entered match cannot appear to viewers until it is switched on.
 */
export default function FixturePanel({
  secretKey,
  open,
  onToggle,
}: {
  secretKey: string;
  open: boolean;
  onToggle: () => void;
}) {
  const [rows, setRows] = useState<FixtureRow[]>([]);
  const [channels, setChannels] = useState<OptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const [fixtures, premium] = await Promise.all([
        fetch("/api/admin/fixtures", {
          headers: { "x-admin-secret": secretKey.trim() },
          cache: "no-store",
        }).then((r) => r.json()),
        fetch("/api/admin/premium/channels", {
          headers: { "x-admin-secret": secretKey.trim() },
          cache: "no-store",
        }).then((r) => r.json()),
      ]);
      if (seq !== loadSeq.current) return;
      if (!fixtures.success) {
        setLoadError(fixtures.error || "Failed to load fixtures");
        return;
      }
      setRows((fixtures.fixtures || []) as FixtureRow[]);
      setChannels(
        ((premium.premiumChannels || []) as OptionRow[]).map((c) => ({ _id: c._id, name: c.name }))
      );
      setLoadError(null);
    } catch (err: any) {
      if (seq !== loadSeq.current) return;
      setLoadError(`Error loading fixtures: ${err.message}`);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [secretKey]);

  useEffect(() => {
    load();
  }, [load]);

  const editing = showForm || saving || busyId !== null;

  useEffect(() => {
    if (!open || editing) return;
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [open, editing, load]);

  // Opening the panel re-reads it: a closed panel does not poll, so what it
  // shows can be a minute old — including the premium channels this board links
  // a match to, which are entered in the panel above and may not have existed
  // when this one first loaded.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) load();
    wasOpen.current = open;
  }, [open, load]);

  // The countdown and the LIVE badge are the whole point of the board, so they
  // move while it is open instead of lying for a minute at a time.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  function startCreate() {
    setForm({ ...EMPTY_FORM, startsAt: toInputValue(new Date(Date.now() + 3_600_000).toISOString()) });
    setEditingId(null);
    setShowForm(true);
    setMessage(null);
  }

  function startEdit(row: FixtureRow) {
    setForm({
      sport: row.sport,
      teamA: row.teamA,
      teamB: row.teamB,
      teamALogo: row.teamALogo,
      teamBLogo: row.teamBLogo,
      competition: row.competition,
      startsAt: toInputValue(row.startsAt),
      durationMinutes: String(row.durationMinutes),
      premiumChannelId: row.premiumChannelId || "",
      visible: row.visible,
    });
    setEditingId(row._id);
    setShowForm(true);
    setMessage(null);
  }

  async function submit() {
    setSaving(true);
    setMessage(null);
    try {
      const body = {
        sport: form.sport,
        teamA: form.teamA,
        teamB: form.teamB,
        teamALogo: form.teamALogo,
        teamBLogo: form.teamBLogo,
        competition: form.competition,
        startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : "",
        durationMinutes: Number(form.durationMinutes),
        premiumChannelId: form.premiumChannelId || null,
        visible: form.visible,
      };
      const res = await fetch(editingId ? `/api/admin/fixtures/${editingId}` : "/api/admin/fixtures", {
        method: editingId ? "PATCH" : "POST",
        headers: { "x-admin-secret": secretKey.trim(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const data = await res.json();
      if (!data.success) {
        setMessage(data.error || `Save failed (${res.status})`);
        return;
      }
      setMessage(editingId ? `Updated ${data.fixture.teamA} v ${data.fixture.teamB}.` : "Match entered.");
      setShowForm(false);
      setEditingId(null);
      await load();
    } catch (err: any) {
      setMessage(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>, label: string) {
    setBusyId(id);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/fixtures/${id}`, {
        method: "PATCH",
        headers: { "x-admin-secret": secretKey.trim(), "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, secretKey: secretKey.trim() }),
        cache: "no-store",
      });
      const data = await res.json();
      if (!data.success) setMessage(data.error || `${label} failed (${res.status})`);
      await load();
    } catch (err: any) {
      setMessage(`${label} failed: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: FixtureRow) {
    if (!window.confirm(`Delete "${row.teamA} v ${row.teamB}"?`)) return;
    setBusyId(row._id);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/fixtures/${row._id}`, {
        method: "DELETE",
        headers: { "x-admin-secret": secretKey.trim() },
        cache: "no-store",
      });
      const data = await res.json();
      setMessage(data.success ? data.message : data.error || `Delete failed (${res.status})`);
      await load();
    } catch (err: any) {
      setMessage(`Delete failed: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  }

  const liveCount = rows.filter((r) => r.phase === "live").length;
  const visibleCount = rows.filter((r) => r.visible).length;

  return (
    <AdminSection
      title="Match fixtures"
      icon={<CalendarClock size={16} />}
      open={open}
      onToggle={onToggle}
      collapsedHint={
        loading
          ? "Loading the fixture board…"
          : `${rows.length} entered · ${visibleCount} published · ${liveCount} live. Typed in by hand, no schedule feed.`
      }
      badge={<SectionBadge text={loading ? "…" : `${visibleCount}/${rows.length} shown`} />}
      actions={
        <button
          type="button"
          onClick={showForm ? () => setShowForm(false) : startCreate}
          className="flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-lg bg-brand-600 hover:bg-brand-500 text-white shrink-0"
        >
          {showForm ? <X size={12} /> : <PlusCircle size={12} />}
          {showForm ? "Close" : "Add match"}
        </button>
      }
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

        {showForm && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={LABEL_CLASS}>Sport</label>
                <select
                  className={FIELD_CLASS}
                  value={form.sport}
                  onChange={(e) => setForm({ ...form, sport: e.target.value as FormState["sport"] })}
                >
                  <option value="football">Football</option>
                  <option value="cricket">Cricket</option>
                </select>
              </div>
              <div>
                <label className={LABEL_CLASS}>Competition</label>
                <input
                  className={FIELD_CLASS}
                  value={form.competition}
                  onChange={(e) => setForm({ ...form, competition: e.target.value })}
                  placeholder="BPL · Premier League"
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Team A</label>
                <input
                  className={FIELD_CLASS}
                  value={form.teamA}
                  onChange={(e) => setForm({ ...form, teamA: e.target.value })}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Team B</label>
                <input
                  className={FIELD_CLASS}
                  value={form.teamB}
                  onChange={(e) => setForm({ ...form, teamB: e.target.value })}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Team A logo URL</label>
                <input
                  className={FIELD_CLASS}
                  value={form.teamALogo}
                  onChange={(e) => setForm({ ...form, teamALogo: e.target.value })}
                  placeholder="https://…"
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Team B logo URL</label>
                <input
                  className={FIELD_CLASS}
                  value={form.teamBLogo}
                  onChange={(e) => setForm({ ...form, teamBLogo: e.target.value })}
                  placeholder="https://…"
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Kickoff (your local time)</label>
                <input
                  type="datetime-local"
                  className={FIELD_CLASS}
                  value={form.startsAt}
                  onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Length (minutes live)</label>
                <input
                  type="number"
                  min={1}
                  max={720}
                  className={FIELD_CLASS}
                  value={form.durationMinutes}
                  onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2">
                <label className={LABEL_CLASS}>Watch on (premium channel)</label>
                <select
                  className={FIELD_CLASS}
                  value={form.premiumChannelId}
                  onChange={(e) => setForm({ ...form, premiumChannelId: e.target.value })}
                >
                  <option value="">Not linked</option>
                  {channels.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setForm({ ...form, visible: !form.visible })}
                className="flex items-center gap-2 text-xs text-slate-200"
              >
                {form.visible ? (
                  <CheckSquare size={14} className="text-emerald-400" />
                ) : (
                  <Square size={14} className="text-slate-500" />
                )}
                Published to viewers
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={submit}
                className="ml-auto flex items-center gap-1 text-[11px] font-bold px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                {editingId ? "Save changes" : "Add match"}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <p className="text-xs text-slate-400">Loading fixtures…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-slate-400">
            No matches entered. Add one and it stays hidden until you publish this card.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li
                key={row._id}
                className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 flex flex-wrap items-center gap-2"
              >
                <button
                  type="button"
                  title={row.visible ? "Unpublish" : "Publish"}
                  onClick={() => patch(row._id, { visible: !row.visible }, row.visible ? "Unpublish" : "Publish")}
                  className="shrink-0"
                >
                  {row.visible ? (
                    <CheckSquare size={16} className="text-emerald-400" />
                  ) : (
                    <Square size={16} className="text-slate-500" />
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-white truncate">
                    {row.teamA} <span className="text-slate-500">v</span> {row.teamB}
                    <span className="ml-2 text-[10px] font-normal capitalize text-slate-400">{row.sport}</span>
                  </p>
                  <p className="text-[10px] text-slate-500 truncate">
                    {row.competition ? `${row.competition} · ` : ""}
                    {new Date(row.startsAt).toLocaleString()}
                    {row.premiumChannelId
                      ? ` · ${channels.find((c) => c._id === row.premiumChannelId)?.name || "linked channel"}`
                      : ""}
                  </p>
                </div>
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${PHASE_STYLE[row.phase]}`}
                >
                  {row.phase === "upcoming"
                    ? `in ${countdown(row.startsAt, now)}`
                    : row.phase === "live"
                      ? "LIVE NOW"
                      : "finished"}
                </span>
                <button
                  type="button"
                  onClick={() => startEdit(row)}
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 shrink-0"
                  title="Edit"
                >
                  <Edit2 size={12} />
                </button>
                <button
                  type="button"
                  disabled={busyId === row._id}
                  onClick={() => remove(row)}
                  className="p-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-300 disabled:opacity-40 shrink-0"
                  title="Delete"
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminSection>
  );
}
