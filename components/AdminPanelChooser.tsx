"use client";

import { useState } from "react";
import AdminDashboard from "@/components/AdminDashboard";
import { ArrowRight, ChevronLeft, Satellite } from "lucide-react";

interface AdminPanelChooserProps {
  secretKey: string;
}

/**
 * The choice shown right after the admin secret is accepted.
 *
 * Direct HLS is the only streaming control panel that is still live, so it is the only
 * option here. The other tiers this screen used to offer — the secure/premium panel and
 * the 24/7 proxy control panel — are gone from this repository, together with the
 * routes and navigation that reached them, so nothing links to them any more.
 *
 * The Direct HLS panel mounts `AdminDashboard` exactly as the gate did before: same
 * component, same props, same section order, no wrapper that changes its markup.
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
          Direct HLS is the only streaming panel that is live. It uses the same admin secret.
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
              M3U ingestion, stream health checks, sources, pinned channels, the channel
              catalogue and the match fixtures the homepage shows.
            </p>
            <span className="flex items-center gap-1 text-[11px] font-bold text-brand-400 mt-3">
              Open panel
              <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
