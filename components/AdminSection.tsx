"use client";

import { type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

type SectionTone = "slate" | "amber";

interface AdminSectionProps {
  title: string;
  icon: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Shown on the header row — different sentence for each state so a closed row still explains itself. */
  collapsedHint: string;
  expandedHint?: string;
  badge?: ReactNode;
  /** Buttons that stay clickable while the section is closed. */
  actions?: ReactNode;
  tone?: SectionTone;
  children: ReactNode;
}

const TONES: Record<SectionTone, { shell: string; tile: string }> = {
  slate: {
    shell: "glass-panel rounded-2xl border border-slate-800",
    tile: "bg-slate-900 border-slate-800 text-brand-400",
  },
  amber: {
    shell:
      "glass-panel rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/5 via-slate-900/40 to-slate-950",
    tile: "bg-amber-500/10 border-amber-500/30 text-amber-400",
  },
};

/** The count pill a section header carries, so a closed row still reports its size. */
export function SectionBadge({ text, tone = "slate" }: { text: string; tone?: SectionTone }) {
  const classes =
    tone === "amber"
      ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
      : "bg-slate-900 border-slate-800 text-brand-400";
  return (
    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${classes}`}>
      {text}
    </span>
  );
}

export default function AdminSection({
  title,
  icon,
  open,
  onToggle,
  collapsedHint,
  expandedHint,
  badge,
  actions,
  tone = "slate",
  children,
}: AdminSectionProps) {
  const t = TONES[tone];

  return (
    <section className={t.shell}>
      <div className="flex flex-wrap items-center justify-between gap-3 p-5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex items-center gap-2.5 min-w-0 flex-1 text-left group"
        >
          <div className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${t.tile}`}>
            {icon}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-white truncate">{title}</h2>
              {badge}
            </div>
            <p className="text-xs text-slate-400 mt-0.5 truncate">
              {open ? expandedHint ?? collapsedHint : collapsedHint}
            </p>
          </div>
        </button>

        <div className="flex items-center gap-2 shrink-0">
          {actions}
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
            className="w-8 h-8 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 hover:text-white transition-all"
          >
            <ChevronDown className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      {open && <div className="px-5 pb-5 space-y-4">{children}</div>}
    </section>
  );
}
