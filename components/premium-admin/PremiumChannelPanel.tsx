"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AdminSection, { SectionBadge } from "@/components/AdminSection";
import { CheckSquare, Crown, Edit2, Loader2, PlusCircle, Save, Square, Trash2, Unlink, Upload, X } from "lucide-react";

interface PremiumRow {
  _id: string;
  name: string;
  category: string;
  logoUrl: string;
  active: boolean;
  sortOrder: number;
  note: string;
  /** The handle this channel's source sits under on the stream box, or "". */
  proxyChannelKey: string;
  proxyPushedAt: string | null;
  updatedAt: string;
}

interface FormState {
  name: string;
  category: string;
  logoUrl: string;
  sortOrder: string;
  note: string;
  proxyChannelKey: string;
  active: boolean;
}

/** The line an admin is about to hand to the box. It exists only inside this dialog. */
interface PushState {
  id: string;
  channelName: string;
  sourceUrl: string;
  userAgent: string;
  referer: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  category: "Premium",
  logoUrl: "",
  sortOrder: "99",
  note: "",
  proxyChannelKey: "",
  active: true,
};

const FIELD_CLASS =
  "w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-brand-500";
const LABEL_CLASS = "block text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1";

/**
 * The evidence a push leaves on the row: the handle the box filed the source under and the
 * moment it was accepted. Neither is the source — that never comes back from the box, and this
 * panel has no column for it.
 */
function boxLabel(row: PremiumRow): string {
  if (!row.proxyChannelKey) return "No source on the box yet";
  const pushed = row.proxyPushedAt ? new Date(row.proxyPushedAt).toLocaleString() : "";
  return `On the box as ${row.proxyChannelKey}${pushed ? ` · pushed ${pushed}` : ""}`;
}

/**
 * The premium tier's admin list. It is its own section over its own collections:
 * a channel entered here never joins the Direct HLS grid, its ranking pass or its
 * maintenance sweep, which is why nothing here reads or writes `Channel`.
 */
export default function PremiumChannelPanel({
  secretKey,
  open,
  onToggle,
}: {
  secretKey: string;
  open: boolean;
  onToggle: () => void;
}) {
  const [rows, setRows] = useState<PremiumRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [push, setPush] = useState<PushState | null>(null);
  const [pushing, setPushing] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await fetch("/api/admin/premium/channels", {
        headers: { "x-admin-secret": secretKey.trim() },
        cache: "no-store",
      });
      const data = await res.json();
      if (seq !== loadSeq.current) return;
      if (data.success) {
        setRows((data.premiumChannels || []) as PremiumRow[]);
        setLoadError(null);
      } else {
        setLoadError(data.error || `Failed to load premium channels (${res.status})`);
      }
    } catch (err: any) {
      if (seq !== loadSeq.current) return;
      setLoadError(`Error loading premium channels: ${err.message}`);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [secretKey]);

  useEffect(() => {
    load();
  }, [load]);

  const editing = showForm || saving || busyId !== null || push !== null || pushing;

  // A closed panel is not refreshed behind the admin's back, and an open one is
  // never refreshed while a form is being filled in.
  useEffect(() => {
    if (!open || editing) return;
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [open, editing, load]);

  // Opening the panel re-reads it: a closed panel does not poll, so what it
  // shows can be a minute old.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) load();
    wasOpen.current = open;
  }, [open, load]);

  function startCreate() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(true);
    setMessage(null);
  }

  function startEdit(row: PremiumRow) {
    setForm({
      name: row.name,
      category: row.category,
      logoUrl: row.logoUrl,
      sortOrder: String(row.sortOrder),
      note: row.note,
      proxyChannelKey: row.proxyChannelKey,
      active: row.active,
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
        name: form.name,
        category: form.category,
        logoUrl: form.logoUrl,
        sortOrder: Number(form.sortOrder),
        note: form.note,
        proxyChannelKey: form.proxyChannelKey,
        active: form.active,
      };
      const res = await fetch(
        editingId ? `/api/admin/premium/channels/${editingId}` : "/api/admin/premium/channels",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "x-admin-secret": secretKey.trim(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
          cache: "no-store",
        }
      );
      const data = await res.json();
      if (!data.success) {
        setMessage(data.error || `Save failed (${res.status})`);
        return;
      }
      setMessage(
        editingId ? `Updated ${data.channel.name}.` : `Added ${data.channel.name} to the premium rail.`
      );
      setShowForm(false);
      setEditingId(null);
      await load();
    } catch (err: any) {
      setMessage(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  /** Sends only the one switched field, so a toggle cannot rewrite the rest. */
  async function patch(id: string, body: Record<string, unknown>, label: string) {
    setBusyId(id);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/premium/channels/${id}`, {
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

  async function remove(row: PremiumRow) {
    if (
      !window.confirm(
        row.proxyChannelKey
          ? `Delete premium channel "${row.name}"? Its source is on the stream box as ${row.proxyChannelKey}, so that goes first. Fixtures stay in place.`
          : `Delete premium channel "${row.name}"? Fixtures stay in place.`
      )
    )
      return;
    setBusyId(row._id);
    setMessage(null);
    try {
      // Taking the lane off the box is the delete route's job, not this panel's, so that a row
      // cannot be removed by anything that talks to the API directly and leave a premium stream
      // running on the box behind it.
      const res = await fetch(`/api/admin/premium/channels/${row._id}`, {
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

  function startPush(row: PremiumRow) {
    setPush({
      id: row._id,
      channelName: row.name,
      sourceUrl: "",
      userAgent: "",
      referer: "",
    });
    setMessage(null);
  }

  /**
   * Hand one source line to the box. What comes back is the handle it was filed under and the
   * moment it was accepted: the line is not echoed, and nothing here keeps it — the vault on the
   * box is the only copy, which is why this dialog has to be reopened for every push.
   */
  async function submitPush() {
    if (!push) return;
    setPushing(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/premium/channels/${push.id}/push`, {
        method: "POST",
        headers: { "x-admin-secret": secretKey.trim(), "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceUrl: push.sourceUrl,
          userAgent: push.userAgent,
          referer: push.referer,
        }),
        cache: "no-store",
      });
      const data = await res.json();
      if (!data.success) {
        setMessage(data.error || `Push failed (${res.status})`);
        return;
      }
      setMessage(`Pushed. The box holds it as ${data.channelKey}.`);
      setPush(null);
      await load();
    } catch (err: any) {
      setMessage(`Push failed: ${err.message}`);
    } finally {
      setPushing(false);
    }
  }

  /** Removes this channel's lane from the box and clears the handle. The row stays. */
  async function retractFromBox(row: PremiumRow): Promise<boolean> {
    const res = await fetch(`/api/admin/premium/channels/${row._id}/push`, {
      method: "DELETE",
      headers: { "x-admin-secret": secretKey.trim() },
      cache: "no-store",
    });
    const data = await res.json();
    if (!data.success) {
      setMessage(data.error || `Removing the source failed (${res.status})`);
      return false;
    }
    return true;
  }

  async function retract(row: PremiumRow) {
    if (!window.confirm(`Take "${row.name}" off the stream box? The channel row stays.`)) return;
    setBusyId(row._id);
    setMessage(null);
    try {
      if (await retractFromBox(row)) {
        setMessage(`Removed from the box. "${row.name}" has no stream until you push one.`);
        await load();
      }
    } catch (err: any) {
      setMessage(`Removing the source failed: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  }

  const activeCount = rows.filter((r) => r.active).length;
  const pushedCount = rows.filter((r) => r.proxyChannelKey).length;

  return (
    <AdminSection
      title="Premium channels"
      icon={<Crown size={16} />}
      open={open}
      onToggle={onToggle}
      collapsedHint={
        loading
          ? "Loading the premium list…"
          : `${rows.length} entered · ${activeCount} switched on · ${pushedCount} with a source on the box. Kept out of the Direct HLS grid.`
      }
      badge={<SectionBadge text={loading ? "…" : `${activeCount}/${rows.length}`} />}
      actions={
        <button
          type="button"
          onClick={showForm ? () => setShowForm(false) : startCreate}
          className="flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-lg bg-brand-600 hover:bg-brand-500 text-white shrink-0"
        >
          {showForm ? <X size={12} /> : <PlusCircle size={12} />}
          {showForm ? "Close" : "Add channel"}
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
                <label className={LABEL_CLASS}>Channel name</label>
                <input
                  className={FIELD_CLASS}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Example Sports HD"
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Category</label>
                <input
                  className={FIELD_CLASS}
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="Sports"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={LABEL_CLASS}>Logo URL</label>
                <input
                  className={FIELD_CLASS}
                  value={form.logoUrl}
                  onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
                  placeholder="https://…"
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Rail position</label>
                <input
                  type="number"
                  min={1}
                  max={999}
                  className={FIELD_CLASS}
                  value={form.sortOrder}
                  onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                />
              </div>
            </div>

            <div>
              <label className={LABEL_CLASS}>Stream box handle (optional)</label>
              <input
                className={FIELD_CLASS}
                value={form.proxyChannelKey}
                onChange={(e) => setForm({ ...form, proxyChannelKey: e.target.value })}
                placeholder="Leave blank — a push fills it in"
              />
              <p className="text-[10px] text-slate-500 mt-1">
                Only needed for a lane you registered on the box by hand. A source pushed from
                here is filed under its own handle and this row keeps nothing but that name.
              </p>
            </div>

            <div>
              <label className={LABEL_CLASS}>Note (for you only)</label>
              <input
                className={FIELD_CLASS}
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="Where this came from, what it costs, when it expires"
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setForm({ ...form, active: !form.active })}
                className="flex items-center gap-2 text-xs text-slate-200"
              >
                {form.active ? (
                  <CheckSquare size={14} className="text-emerald-400" />
                ) : (
                  <Square size={14} className="text-slate-500" />
                )}
                Switched on
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={submit}
                className="ml-auto flex items-center gap-1 text-[11px] font-bold px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                {editingId ? "Save changes" : "Add channel"}
              </button>
            </div>
          </div>
        )}

        {push && (
          <div className="rounded-xl border border-brand-500/40 bg-slate-900/60 p-4 space-y-3">
            <p className="text-xs font-bold text-white">
              Send a source to the stream box — {push.channelName}
            </p>
            <p className="text-[10px] text-slate-400">
              This line goes straight to the box and is not kept here: the box holds the only copy,
              and this row keeps just the handle it was filed under.
            </p>

            <div>
              <label className={LABEL_CLASS}>Source URL (manifest)</label>
              <input
                className={FIELD_CLASS}
                value={push.sourceUrl}
                onChange={(e) => setPush({ ...push, sourceUrl: e.target.value })}
                placeholder="https://host/path/index.m3u8?token=…"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={LABEL_CLASS}>User-Agent header</label>
                <input
                  className={FIELD_CLASS}
                  value={push.userAgent}
                  onChange={(e) => setPush({ ...push, userAgent: e.target.value })}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Referer header</label>
                <input
                  className={FIELD_CLASS}
                  value={push.referer}
                  onChange={(e) => setPush({ ...push, referer: e.target.value })}
                  placeholder="https://…"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPush(null)}
                className="flex items-center gap-1 text-[11px] font-bold px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
              >
                <X size={12} />
                Cancel
              </button>
              <button
                type="button"
                disabled={pushing}
                onClick={submitPush}
                className="ml-auto flex items-center gap-1 text-[11px] font-bold px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-50"
              >
                {pushing ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                {pushing ? "Sending…" : "Send to box"}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <p className="text-xs text-slate-400">Loading premium channels…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-slate-400">
            No premium channels yet. Anything you add here appears in its own rail above the grid, and
            nothing here changes a Direct HLS channel.
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
                  title={row.active ? "Switch off" : "Switch on"}
                  onClick={() => patch(row._id, { active: !row.active }, row.active ? "Switch off" : "Switch on")}
                  className="shrink-0"
                >
                  {row.active ? (
                    <CheckSquare size={16} className="text-emerald-400" />
                  ) : (
                    <Square size={16} className="text-slate-500" />
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-white truncate">
                    {row.sortOrder}. {row.name}
                    <span className="ml-2 text-[10px] font-normal text-slate-400">{row.category}</span>
                  </p>
                  <p
                    className={`text-[10px] truncate ${
                      row.proxyChannelKey ? "text-emerald-400" : "text-slate-500"
                    }`}
                    title={boxLabel(row)}
                  >
                    {boxLabel(row)}
                  </p>
                  {row.note && <p className="text-[10px] text-slate-400 truncate">{row.note}</p>}
                </div>
                <button
                  type="button"
                  disabled={busyId === row._id}
                  onClick={() => startPush(row)}
                  className="flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-lg bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-40 shrink-0"
                  title={row.proxyChannelKey ? "Push a new source over this one" : "Push this channel's source to the box"}
                >
                  <Upload size={12} />
                  {row.proxyChannelKey ? "Re-push" : "Push source"}
                </button>
                {row.proxyChannelKey && (
                  <button
                    type="button"
                    disabled={busyId === row._id}
                    onClick={() => retract(row)}
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 shrink-0"
                    title="Take this source off the box"
                  >
                    <Unlink size={12} />
                  </button>
                )}
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
