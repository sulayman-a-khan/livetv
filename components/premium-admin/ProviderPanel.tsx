"use client";

import { useEffect, useState } from "react";
import AdminSection, { SectionBadge } from "@/components/AdminSection";
import {
  CheckSquare,
  Edit2,
  Loader2,
  PlusCircle,
  Save,
  Server,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useBoxProviders, type BoxProvider } from "./useBoxProviders";

interface ProviderForm {
  label: string;
  providerId: string;
  serverUrl: string;
  username: string;
  password: string;
}

const EMPTY_FORM: ProviderForm = {
  label: "",
  providerId: "",
  serverUrl: "",
  username: "",
  password: "",
};

const FIELD_CLASS =
  "w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-brand-500";
const LABEL_CLASS = "block text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1";

/**
 * What the panel can say about an account without knowing its credential.
 *
 * The address arrives from the box already masked and is trimmed again here, so what is on the
 * screen is the host and nothing that could be a password.
 */
function addressOf(provider: BoxProvider): string {
  if (!provider.server) return "No address on the box";
  return provider.server;
}

/**
 * The provider half of the panel: the accounts the box plays from.
 *
 * An account lives in the box's vault and nowhere else. This panel asks the box for the list,
 * sends a registration to it, and asks it to change or remove an account — the credential
 * travels in the one request that needs it and is never kept here, so there is no column for
 * a password and no way to read one back.
 */
export default function ProviderPanel({
  secretKey,
  open,
  onToggle,
}: {
  secretKey: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { reachable, authorized, providers, loading, error, reload } = useBoxProviders(
    secretKey,
    open
  );
  const [message, setMessage] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const editing = showForm || saving || busyId !== null;

  // A closed panel is not refreshed behind the admin's back, and an open one is never
  // refreshed while a form is being filled in.
  useEffect(() => {
    if (!open || editing) return;
    const id = setInterval(reload, 60_000);
    return () => clearInterval(id);
  }, [open, editing, reload]);

  function startCreate() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(true);
    setMessage(null);
  }

  function startEdit(provider: BoxProvider) {
    // The address is not pre-filled: what the box shows is a masked form of it, and writing
    // that back would replace the real address with a masked one. A blank field means "keep
    // what you have".
    setForm({
      label: provider.label,
      providerId: provider.providerId,
      serverUrl: "",
      username: "",
      password: "",
    });
    setEditingId(provider.providerId);
    setShowForm(true);
    setMessage(null);
  }

  async function submit() {
    setSaving(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = { label: form.label };
      if (form.serverUrl) body.serverUrl = form.serverUrl;
      if (form.username) body.username = form.username;
      if (form.password) body.password = form.password;
      // The handle is only sent on a create: it is what the box files the account under, and
      // an edit never renames it.
      if (!editingId && form.providerId) body.providerId = form.providerId;

      const res = await fetch(
        editingId
          ? `/api/admin/premium/providers/${encodeURIComponent(editingId)}`
          : "/api/admin/premium/providers",
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
        editingId
          ? `Updated ${data.providerId}.`
          : `Added ${data.label} to the box as ${data.providerId}.`
      );
      setShowForm(false);
      setEditingId(null);
      await reload();
    } catch (err: any) {
      setMessage(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Takes an account out of service, or puts it back.
   *
   * The account stays on the box either way: a provider that has to be replaced for a moment
   * is a provider that is switched off, not one that is deleted and has to be typed in again.
   */
  async function toggleService(provider: BoxProvider) {
    setBusyId(provider.providerId);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/premium/providers/${encodeURIComponent(provider.providerId)}`, {
        method: "PATCH",
        headers: { "x-admin-secret": secretKey.trim(), "Content-Type": "application/json" },
        body: JSON.stringify({ active: !provider.active }),
        cache: "no-store",
      });
      const data = await res.json();
      if (!data.success) {
        setMessage(data.error || `The change was refused (${res.status})`);
        return;
      }
      setMessage(
        provider.active
          ? `${provider.label} is out of service. Its channels stop playing until it is back on.`
          : `${provider.label} is back in service.`
      );
      await reload();
    } catch (err: any) {
      setMessage(`The change failed: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(provider: BoxProvider) {
    if (
      !window.confirm(
        `Remove "${provider.label}" from the box? The box refuses while a channel still plays from it.`
      )
    )
      return;
    setBusyId(provider.providerId);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/premium/providers/${encodeURIComponent(provider.providerId)}`, {
        method: "DELETE",
        headers: { "x-admin-secret": secretKey.trim() },
        cache: "no-store",
      });
      const data = await res.json();
      setMessage(
        data.success
          ? `Removed ${provider.label}.`
          : data.error || `The removal was refused (${res.status})`
      );
      await reload();
    } catch (err: any) {
      setMessage(`The removal failed: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  }

  const inService = providers.filter((p) => p.active).length;

  return (
    <AdminSection
      title="Providers"
      icon={<Server size={16} />}
      open={open}
      onToggle={onToggle}
      collapsedHint={
        loading
          ? "Loading the provider list…"
          : `${providers.length} on the box · ${inService} in service. The accounts the box plays from.`
      }
      badge={<SectionBadge text={loading ? "…" : `${inService}/${providers.length}`} />}
      actions={
        <button
          type="button"
          onClick={showForm ? () => setShowForm(false) : startCreate}
          className="flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-lg bg-brand-600 hover:bg-brand-500 text-white shrink-0"
        >
          {showForm ? <X size={12} /> : <PlusCircle size={12} />}
          {showForm ? "Close" : "Add provider"}
        </button>
      }
    >
      <div className="space-y-3">
        {error && (
          <p className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
        {message && (
          <p className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
            {message}
          </p>
        )}

        {!loading && !reachable && (
          <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
            The stream box did not answer, so the accounts it holds cannot be listed. The panel
            still works for everything that does not need the box.
          </p>
        )}
        {!loading && reachable && !authorized && (
          <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
            The box answered but refused this server&apos;s credential, so the accounts it holds
            are not shown. This is a setup problem on the server, not a missing account.
          </p>
        )}

        {showForm && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
            <p className="text-xs font-bold text-white">
              {editingId ? "Edit the account" : "Add an account to the box"}
            </p>
            <p className="text-[10px] text-slate-400">
              The password is sent to the box once and sealed there. This site keeps no copy and
              shows none, so an edit leaves the password blank to keep the one the box holds.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={LABEL_CLASS}>Provider name</label>
                <input
                  className={FIELD_CLASS}
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder="Example Sports"
                />
              </div>
              {!editingId && (
                <div>
                  <label className={LABEL_CLASS}>Provider ID (optional)</label>
                  <input
                    className={FIELD_CLASS}
                    value={form.providerId}
                    onChange={(e) => setForm({ ...form, providerId: e.target.value })}
                    placeholder="Leave blank to derive it from the name"
                  />
                </div>
              )}
            </div>

            <div>
              <label className={LABEL_CLASS}>Server URL</label>
              <input
                className={FIELD_CLASS}
                value={form.serverUrl}
                onChange={(e) => setForm({ ...form, serverUrl: e.target.value })}
                placeholder="http://host:port"
              />
              {editingId && (
                <p className="text-[10px] text-slate-500 mt-1">
                  Leave blank to keep the address the box already holds.
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={LABEL_CLASS}>Username</label>
                <input
                  className={FIELD_CLASS}
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Password</label>
                <input
                  type="password"
                  className={FIELD_CLASS}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  autoComplete="new-password"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="flex items-center gap-1 text-[11px] font-bold px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
              >
                <X size={12} />
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={submit}
                className="ml-auto flex items-center gap-1 text-[11px] font-bold px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                {editingId ? "Save changes" : "Add provider"}
              </button>
            </div>
          </div>
        )}

        {loading && providers.length === 0 ? (
          <p className="text-xs text-slate-400">Loading the accounts the box holds…</p>
        ) : providers.length === 0 ? (
          <p className="text-xs text-slate-400">
            No accounts on the box yet. Add one here and the channels below can play from it.
          </p>
        ) : (
          <ul className="space-y-2">
            {providers.map((provider) => (
              <li
                key={provider.providerId}
                className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 flex flex-wrap items-center gap-2"
              >
                <button
                  type="button"
                  title={provider.active ? "Take out of service" : "Put back in service"}
                  disabled={busyId === provider.providerId}
                  onClick={() => toggleService(provider)}
                  className="shrink-0 disabled:opacity-40"
                >
                  {provider.active ? (
                    <CheckSquare size={16} className="text-emerald-400" />
                  ) : (
                    <Square size={16} className="text-slate-500" />
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-white truncate">
                    {provider.label || provider.providerId}
                    <span className="ml-2 text-[10px] font-normal text-slate-400">
                      {provider.providerId}
                    </span>
                  </p>
                  <p className="text-[10px] text-slate-400 truncate">
                    {addressOf(provider)}
                    {provider.usernameHint ? ` · ${provider.usernameHint}` : ""} ·{" "}
                    {provider.channels.length} channel
                    {provider.channels.length === 1 ? "" : "s"}
                  </p>
                  {!provider.active && (
                    <p className="text-[10px] text-amber-400">Out of service</p>
                  )}
                  {provider.problem && (
                    <p className="text-[10px] text-red-400">
                      The box cannot use this account ({provider.problem})
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => startEdit(provider)}
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 shrink-0"
                  title="Edit"
                >
                  <Edit2 size={12} />
                </button>
                <button
                  type="button"
                  disabled={busyId === provider.providerId}
                  onClick={() => remove(provider)}
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
