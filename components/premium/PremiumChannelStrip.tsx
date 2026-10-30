"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getChannelLogo } from "@/lib/utils";

interface PremiumChannel {
  id: string;
  name: string;
  logoUrl: string;
  category: string;
}

/**
 * The premium channels, in one line above the channel grid.
 *
 * Each channel is a rectangle with the logo on the left and the name on the right, and the line
 * is as wide as the page: the channels share the width between them, and more than the width can
 * hold scroll sideways rather than wrap into a second row.
 *
 * A tile opens `/premium/<id>`, the tier's own watch page, which asks the box for a signed
 * playlist. Nothing about the stream is in this list — a name, a picture and an id.
 */
export default function PremiumChannelStrip() {
  const [channels, setChannels] = useState<PremiumChannel[]>([]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const res = await fetch("/api/premium/channels", { cache: "no-store" });
        const data = await res.json();
        if (!active || !res.ok || data?.success !== true) return;
        setChannels(Array.isArray(data?.channels) ? data.channels : []);
      } catch {
        // No premium list this visit; the page carries on without the row.
      }
    };

    load();
    return () => {
      active = false;
    };
  }, []);

  if (channels.length === 0) return null;

  return (
    <section className="mb-3">
      <div className="flex gap-2 overflow-x-auto scrollbar-none pb-1">
        {channels.map((channel) => (
          <Link
            key={channel.id}
            href={`/premium/${channel.id}`}
            className="flex-1 min-w-[132px] sm:max-w-[260px] flex items-center gap-2 rounded-xl border border-amber-500/30 bg-gradient-to-r from-[#1b1408] via-[#120e07] to-[#0a1222] px-2 py-1.5 hover:border-amber-400/60 transition-colors"
          >
            <span className="w-9 h-9 shrink-0 rounded-lg bg-white/95 border border-amber-500/40 p-1 flex items-center justify-center overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={getChannelLogo(channel.name, channel.logoUrl)}
                alt=""
                loading="lazy"
                className="max-w-full max-h-full object-contain"
                onError={(e) => {
                  const target = e.target as HTMLImageElement;
                  if (target.dataset.fallback) return;
                  target.dataset.fallback = "true";
                  const initials = channel.name.substring(0, 2).toUpperCase();
                  target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(
                    initials
                  )}&background=0284c7&color=ffffff&size=200&bold=true`;
                }}
              />
            </span>
            <span className="min-w-0 text-[11px] font-bold text-amber-100 truncate">
              {channel.name}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
