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
            className="flex-1 min-w-[132px] sm:max-w-[260px] flex items-center gap-2 rounded-xl border border-[#d4af37]/35 bg-gradient-to-br from-[#16130a] via-[#0b0a08] to-[#07070c] px-2 py-1.5 shadow-[0_0_20px_-10px_rgba(212,175,55,0.55)] hover:border-[#d4af37]/70 hover:shadow-[0_0_26px_-8px_rgba(212,175,55,0.65)] transition-all"
          >
            {/* A gold pinstripe down the edge, the way a plaque is marked. */}
            <span className="w-0.5 h-7 rounded-full bg-gradient-to-b from-[#f2dc9a] via-[#d4af37] to-[#7a5f18] shrink-0" />
            <span className="w-9 h-9 shrink-0 rounded-lg bg-white/95 border border-[#d4af37]/45 p-1 flex items-center justify-center overflow-hidden">
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
            <span className="min-w-0 text-[11px] font-bold text-[#f2e6c4] truncate">
              {channel.name}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
