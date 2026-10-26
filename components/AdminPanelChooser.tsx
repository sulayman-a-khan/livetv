"use client";

import { useState } from "react";
import Link from "next/link";
import AdminDashboard from "@/components/AdminDashboard";
import { ArrowRight, CalendarClock, ChevronLeft, Crown, Satellite, Server, ShieldCheck } from "lucide-react";

interface AdminPanelChooserProps {
  secretKey: string;
}

/**
 * The choice shown right after the admin secret is accepted.
 *
 * Option A mounts the existing `AdminDashboard` exactly as the gate did before —
 * same component, same props, same section order, no wrapper that changes its
 * markup. Option B leaves for `/premium-admin`, which is a separate page with its
 * own components, API namespace and collections, so the premium tier can never
 * reach into the Direct HLS panel. Option C leaves for `/proxy-admin`, which is
 * a third such page: the 24/7 proxy control tier, with its own components, its own
 * API namespace and no store of its own at all.
 *
 * The three options share one secret and nothing else.
 */
export default function AdminPanelChooser({ secretKey }: AdminPanelChooserProps) {
  const [panel, setPanel] = useState<"choice" | "direct">("choice");

  if (panel === "direct") {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setPanel("choice")}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold bg-slate-900 text-slate-400 hover:text-white border border-slate-800 hover:border-brand-500/40 transition-all"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            <span>Choose admin panel</span>
          </button>
          <span className="flex items-center gap-1.5 text-[11px] font-bold text-brand-400">
            <Satellite className="w-3.5 h-3.5" />
            Direct HLS Control Panel
          </span>
        </div>
        <AdminDashboard secretKey={secretKey} />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto mt-6">
      <div className="glass-panel rounded-3xl border border-slate-800 p-6 sm:p-8">
        <h1 className="text-xl font-bold text-white text-center">Admin Control Panels</h1>
        <p className="text-xs text-slate-400 text-center mt-1 mb-7">
          All three panels use the same admin secret and stay fully separate: different screens,
          routes and data collections.
        </p>

        <div className="grid sm:grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => setPanel("direct")}
            className="text-left glass-panel rounded-2xl border border-slate-800 hover:border-brand-500/50 p-5 transition-all group"
          >
            <div className="w-10 h-10 rounded-xl border flex items-center justify-center bg-slate-900 border-slate-800 text-brand-400">
              <Satellite className="w-5 h-5" />
            </div>
            <h2 className="text-sm font-bold text-white mt-3">Direct HLS Control Panel</h2>
            <p className="text-[11px] text-slate-400 mt-1">
              M3U ingestion, stream health checks, sources, pinned channels and the channel
              catalogue.
            </p>
            <span className="flex items-center gap-1 text-[11px] font-bold text-brand-400 mt-3">
              Open panel
              <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </button>

          <Link
            href="/premium-admin"
            className="text-left glass-panel rounded-2xl border border-slate-800 hover:border-violet-500/50 p-5 transition-all group"
          >
            <div className="w-10 h-10 rounded-xl border flex items-center justify-center bg-violet-500/10 border-violet-500/30 text-violet-300">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <h2 className="text-sm font-bold text-white mt-3 flex items-center gap-1.5">
              Secure / Premium &amp; Fixtures
              <Crown className="w-3.5 h-3.5 text-violet-300" />
            </h2>
            <p className="text-[11px] text-slate-400 mt-1">
              Premium stream sources and hand-entered match cards, on their own screens and
              collections.
            </p>
            <span className="flex items-center gap-1 text-[11px] font-bold text-violet-300 mt-3">
              <CalendarClock className="w-3.5 h-3.5" />
              Open premium panel
              <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>

          <Link
            href="/proxy-admin"
            className="sm:col-span-2 text-left glass-panel rounded-2xl border border-slate-800 hover:border-cyan-500/50 p-5 transition-all group"
          >
            <div className="w-10 h-10 rounded-xl border flex items-center justify-center bg-cyan-500/10 border-cyan-500/30 text-cyan-300">
              <Server className="w-5 h-5" />
            </div>
            <h2 className="text-sm font-bold text-white mt-3">24/7 Proxy Control Panel</h2>
            <p className="text-[11px] text-slate-400 mt-1">
              The stream box&apos;s own health, ownership mode and counters. Read-only: it reports
              what the box says about itself and changes nothing.
            </p>
            <span className="flex items-center gap-1 text-[11px] font-bold text-cyan-300 mt-3">
              Open proxy panel
              <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        </div>
      </div>
    </div>
  );
}
