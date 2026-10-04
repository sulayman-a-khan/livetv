"use client";

import { Suspense } from "react";
import SportsArenaWatchPage from "./[id]/page";
import { RefreshCw } from "lucide-react";

export default function SportsArenaIndexPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#030712] text-white flex flex-col items-center justify-center space-y-3">
          <RefreshCw className="w-10 h-10 text-emerald-400 animate-spin" />
          <p className="text-xs font-bold text-slate-400">Loading Sports Arena...</p>
        </div>
      }
    >
      <SportsArenaWatchPage />
    </Suspense>
  );
}
