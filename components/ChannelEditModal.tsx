"use client";

import { useState } from "react";
import { getCountryFlag } from "@/lib/utils";
import {
  X,
  Save,
  RefreshCw,
  Trash2,
  PlusCircle,
  Zap,
  AlertTriangle,
  CheckCircle2,
  Tag,
} from "lucide-react";

export interface EditableStream {
  _id: string;
  url: string;
  status: "active" | "degraded" | "broken";
  latency: number;
  priority?: number;
}

export interface EditableChannel {
  _id: string;
  name: string;
  logo: string;
  category: string;
  subCategory?: string;
  country: string;
  tags?: string[];
  streams: EditableStream[];
}

interface Props {
  channel: EditableChannel;
  secretKey: string;
  onClose: () => void;
  /** Called after any successful mutation so the dashboard can refetch. */
  onSaved: () => void | Promise<void>;
}

const CATEGORY_OPTIONS = ["Live Sports", "News", "Entertainment", "Movies", "Kids", "Music", "Religious", "General"];
const COUNTRY_OPTIONS = ["Bangladesh", "India", "Pakistan", "Global"];

/**
 * Manual override panel for a single channel.
 *
 * Saving marks the channel `isManuallyEdited` on the backend, which permanently
 * protects these fields from auto-detection and from the merge pass. Added
 * links are probed server-side before being stored, so their latency feeds the
 * fastest-first ordering straight away.
 */
export default function ChannelEditModal({ channel, secretKey, onClose, onSaved }: Props) {
  const [name, setName] = useState(channel.name);
  const [logo, setLogo] = useState(channel.logo || "");
  const [category, setCategory] = useState(channel.category || "General");
  const [subCategory, setSubCategory] = useState(channel.subCategory || "");
  const [country, setCountry] = useState(channel.country || "Global");
  const [tagsInput, setTagsInput] = useState((channel.tags || []).join(", "));

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [newUrl, setNewUrl] = useState("");
  const [addingLink, setAddingLink] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const authHeaders = {
    "Content-Type": "application/json",
    "x-admin-secret": secretKey.trim(),
  };

  const handleSaveMetadata = async () => {
    if (!name.trim()) {
      setMessage({ type: "err", text: "Channel name cannot be empty." });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/channels/${channel._id}`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({
          name: name.trim(),
          logo: logo.trim(),
          category,
          subCategory: subCategory.trim(),
          country,
          tags: tagsInput
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ type: "ok", text: "Saved. This channel is now protected from auto-detection." });
        await onSaved();
      } else {
        setMessage({ type: "err", text: data.error || "Save failed." });
      }
    } catch (err: any) {
      setMessage({ type: "err", text: err.message || "Network error." });
    } finally {
      setSaving(false);
    }
  };

  const handleAddLink = async () => {
    if (!/^https?:\/\//i.test(newUrl.trim())) {
      setMessage({ type: "err", text: "Enter a valid http(s) stream URL." });
      return;
    }
    setAddingLink(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/channels/${channel._id}/streams`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ url: newUrl.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setNewUrl("");
        setMessage({
          type: data.probe?.ok ? "ok" : "err",
          text: data.probe?.ok
            ? `Link added and verified (${data.probe.latency}ms). Servers re-sorted fastest-first.`
            : `Link added but the probe failed: ${data.probe?.reason || "unreachable"}. It is stored as broken.`,
        });
        await onSaved();
      } else {
        setMessage({ type: "err", text: data.error || "Could not add link." });
      }
    } catch (err: any) {
      setMessage({ type: "err", text: err.message || "Network error." });
    } finally {
      setAddingLink(false);
    }
  };

  const handleDeleteLink = async (streamId: string) => {
    setDeletingId(streamId);
    try {
      const res = await fetch(`/api/admin/streams/${streamId}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      const data = await res.json();
      if (data.success) {
        await onSaved();
      } else {
        setMessage({ type: "err", text: data.error || "Delete failed." });
      }
    } catch (err: any) {
      setMessage({ type: "err", text: err.message || "Network error." });
    } finally {
      setDeletingId(null);
    }
  };

  const sortedStreams = [...channel.streams].sort(
    (a, b) => (a.priority ?? 99) - (b.priority ?? 99)
  );

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-2xl w-full space-y-5 shadow-2xl animate-fade-in my-8">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div>
            <h3 className="text-base font-bold text-white">Edit Channel</h3>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Manual overrides win over automatic categorisation and merging.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {message && (
          <div
            className={`flex items-start gap-2 px-3 py-2 rounded-xl text-[11px] font-semibold ${
              message.type === "ok"
                ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                : "bg-red-500/10 text-red-300 border border-red-500/30"
            }`}
          >
            {message.type === "ok" ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
            )}
            <span>{message.text}</span>
          </div>
        )}

        {/* ---- Metadata ---- */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="space-y-1 sm:col-span-2">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">Channel Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:border-brand-500 outline-none"
            />
            <span className="block text-[10px] text-slate-500">
              Renaming re-computes the merge key, so this channel may join or leave a merge group.
            </span>
          </label>

          <label className="space-y-1 sm:col-span-2">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">Logo URL</span>
            <div className="flex items-center gap-2">
              <input
                value={logo}
                onChange={(e) => setLogo(e.target.value)}
                placeholder="https://..."
                className="flex-1 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:border-brand-500 outline-none"
              />
              {logo && (
                <div className="w-10 h-10 rounded-lg bg-white p-1 flex items-center justify-center shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={logo} alt="preview" className="max-w-full max-h-full object-contain" />
                </div>
              )}
            </div>
          </label>

          <label className="space-y-1">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">Category</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:border-brand-500 outline-none"
            >
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">Country</span>
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:border-brand-500 outline-none"
            >
              {COUNTRY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {getCountryFlag(c)} {c}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wide">Sub-category</span>
            <input
              value={subCategory}
              onChange={(e) => setSubCategory(e.target.value)}
              placeholder="Cricket, Drama..."
              className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:border-brand-500 outline-none"
            />
          </label>

          <label className="space-y-1">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wide flex items-center gap-1">
              <Tag className="w-3 h-3" /> Tags
            </span>
            <input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="hd, popular, bpl"
              className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:border-brand-500 outline-none"
            />
          </label>
        </div>

        <button
          onClick={handleSaveMetadata}
          disabled={saving}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold transition-colors disabled:opacity-50"
        >
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          <span>{saving ? "Saving..." : "Save Channel Details"}</span>
        </button>

        {/* ---- Server links ---- */}
        <div className="border-t border-slate-800 pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold text-white">Server Links</h4>
            <span className="text-[10px] text-slate-500">Ordered fastest-first automatically</span>
          </div>

          <div className="space-y-1.5 max-h-52 overflow-y-auto scrollbar-thin">
            {sortedStreams.length === 0 && (
              <p className="text-[11px] text-slate-500">No server links yet.</p>
            )}
            {sortedStreams.map((st, idx) => (
              <div
                key={st._id}
                className="flex items-center gap-2 px-2.5 py-2 rounded-xl bg-slate-950 border border-slate-800"
              >
                <span
                  className={`px-1.5 py-0.5 rounded-md text-[10px] font-black shrink-0 ${
                    idx === 0
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-slate-800 text-slate-400"
                  }`}
                >
                  #{idx + 1}
                </span>
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    st.status === "active"
                      ? "bg-emerald-400"
                      : st.status === "degraded"
                      ? "bg-amber-400"
                      : "bg-red-400"
                  }`}
                />
                <span className="flex-1 truncate text-[10px] text-slate-300" title={st.url}>
                  {st.url.replace(/^https?:\/\//, "")}
                </span>
                <span className="text-[10px] font-bold text-slate-500 shrink-0 flex items-center gap-0.5">
                  <Zap className="w-2.5 h-2.5" />
                  {st.latency || "—"}ms
                </span>
                <button
                  onClick={() => handleDeleteLink(st._id)}
                  disabled={deletingId === st._id}
                  className="text-red-400 hover:text-red-300 transition-colors shrink-0 disabled:opacity-40"
                  title="Delete this link"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <input
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://example.com/live/stream.m3u8"
              className="flex-1 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white focus:border-brand-500 outline-none"
            />
            <button
              onClick={handleAddLink}
              disabled={addingLink}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-colors disabled:opacity-50 shrink-0"
            >
              {addingLink ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <PlusCircle className="w-3.5 h-3.5" />
              )}
              <span>{addingLink ? "Probing..." : "Add"}</span>
            </button>
          </div>
          <p className="text-[10px] text-slate-500">
            New links are probed before saving. Once a real working link exists, leftover
            placeholder/test links on this channel are purged automatically.
          </p>
        </div>
      </div>
    </div>
  );
}
