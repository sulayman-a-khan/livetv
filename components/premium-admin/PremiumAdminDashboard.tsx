"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Database, Loader2, ShieldCheck } from "lucide-react";
import FixturePanel from "./FixturePanel";
import PremiumChannelPanel from "./PremiumChannelPanel";

interface PremiumAdminDashboardProps {
  secretKey: string;
}

const OPEN_KEY = "freetv_premium_admin_open_sections";

const DEFAULT_OPEN = { channels: true, fixtures: true };

type OpenSections = typeof DEFAULT_OPEN;

/**
 * The Secure / Premium & Fixtures control panel.
 *
 * This is the second admin surface, deliberately built beside the Direct HLS
 * dashboard rather than inside it: it has its own page, its own components, its
 * own API namespace (`/api/admin/premium/*`, `/api/admin/fixtures/*`) and its own
 * collections. It renders no Direct HLS section and calls no Direct HLS endpoint,
 * so nothing here can change how the existing panel looks or behaves.
 */
export default function PremiumAdminDashboard({ secretKey }: PremiumAdminDashboardProps) {
  const [openSections, setOpenSections] = useState<OpenSections>(DEFAULT_OPEN);
  const [store, setStore] = useState<string | null>(null);

  // Remember which sections were left open, the same way the other panel does.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(OPEN_KEY);
      if (raw) setOpenSections({ ...DEFAULT_OPEN, ...JSON.parse(raw) });
    } catch {
      // A damaged preference is not worth an error banner: fall back to defaults.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(openSections));
    } catch {
      // Private mode can refuse storage; the panel still works for this visit.
    }
  }, [openSections]);

  /**
   * Which store the tier is writing to. Asked once through this panel's own
   * endpoint, because the admin should never have to trust that a save landed in
   * the database he thinks he is using.
   */
  const loadStore = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/premium/session", {
        headers: { "x-admin-secret": secretKey.trim() },
        cache: "no-store",
      });
      const data = await res.json();
      setStore(data.success ? (data.dbMode === "mongodb" ? "MongoDB" : "local file") : null);
    } catch {
      setStore(null);
    }
  }, [secretKey]);

  useEffect(() => {
    loadStore();
  }, [loadStore]);

  const toggle = (key: keyof OpenSections) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="space-y-4">
      <div className="glass-panel rounded-2xl border border-slate-800 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-9 h-9 rounded-xl border bg-violet-500/10 border-violet-500/30 text-violet-300 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold text-white">
              Secure / Premium &amp; Fixtures Control Panel
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Admin-supplied premium sources and hand-entered match cards. Separate from the Direct
              HLS panel: its own collections, routes and screens.
            </p>
          </div>
          <Link
            href="/admin-secret-gate"
            className="text-[11px] font-bold px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:border-brand-500/40 transition-all shrink-0"
          >
            Open Direct HLS Control Panel
          </Link>
        </div>

        <div className="flex items-center gap-2 mt-3 text-[11px] text-slate-400">
          <Database className="w-3.5 h-3.5 shrink-0" />
          {store === null ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Checking which store this panel writes to
            </span>
          ) : (
            <span>
              Saving to <span className="font-bold text-slate-200">{store}</span>
            </span>
          )}
        </div>
      </div>

      <PremiumChannelPanel
        secretKey={secretKey}
        open={openSections.channels}
        onToggle={() => toggle("channels")}
      />

      <FixturePanel
        secretKey={secretKey}
        open={openSections.fixtures}
        onToggle={() => toggle("fixtures")}
      />
    </div>
  );
}
