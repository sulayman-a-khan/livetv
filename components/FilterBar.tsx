"use client";

import { Trophy, Globe, Flame, Shield, Radio, Sparkles } from "lucide-react";

interface FilterBarProps {
  selectedCategory: string;
  setSelectedCategory: (cat: string) => void;
  selectedSubCategory: string;
  setSelectedSubCategory: (sub: string) => void;
  selectedCountry: string;
  setSelectedCountry: (country: string) => void;
}

export default function FilterBar({
  selectedCategory,
  setSelectedCategory,
  selectedSubCategory,
  setSelectedSubCategory,
  selectedCountry,
  setSelectedCountry,
}: FilterBarProps) {
  const categories = [
    { id: "All", label: "All Channels", icon: Flame },
    { id: "Live Sports", label: "Live Sports", icon: Trophy, badge: "LIVE" },
    { id: "News", label: "News", icon: Radio },
    { id: "Entertainment", label: "Entertainment", icon: Sparkles },
  ];

  const sportsSubCategories = [
    { id: "All", label: "All Sports" },
    { id: "Cricket", label: "Cricket 🏏" },
    { id: "Football", label: "Football ⚽" },
    { id: "Others", label: "Others 🥊" },
  ];

  const countries = [
    { id: "All", label: "All Regions", flag: "🌐" },
    { id: "Bangladesh", label: "Bangladesh", flag: "🇧🇩" },
    { id: "India", label: "India", flag: "🇮🇳" },
    { id: "Pakistan", label: "Pakistan", flag: "🇵🇰" },
    { id: "Global", label: "Global", flag: "🌍" },
  ];

  return (
    <div className="space-y-3 mb-8">
      {/* Category Pills */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
        {categories.map((cat) => {
          const Icon = cat.icon;
          const isActive = selectedCategory === cat.id;

          return (
            <button
              key={cat.id}
              onClick={() => {
                setSelectedCategory(cat.id);
                if (cat.id !== "Live Sports") {
                  setSelectedSubCategory("All");
                }
              }}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all duration-200 ${
                isActive
                  ? "bg-gradient-to-r from-brand-600 to-indigo-600 text-white shadow-lg shadow-brand-600/30 border border-indigo-400/30"
                  : "bg-slate-900/80 text-slate-400 hover:text-slate-200 hover:bg-slate-800/80 border border-slate-800"
              }`}
            >
              <Icon className={`w-3.5 h-3.5 ${isActive ? "text-white" : "text-slate-400"}`} />
              <span>{cat.label}</span>
              {cat.badge && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-red-500 text-white animate-pulse">
                  {cat.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Sub-category pills if Live Sports selected */}
      {selectedCategory === "Live Sports" && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1 pl-2 border-l-2 border-brand-500/40">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mr-1">
            Sports:
          </span>
          {sportsSubCategories.map((sub) => {
            const isActive = selectedSubCategory === sub.id;
            return (
              <button
                key={sub.id}
                onClick={() => setSelectedSubCategory(sub.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  isActive
                    ? "bg-brand-500/20 text-brand-400 border border-brand-500/40"
                    : "bg-slate-950/60 text-slate-400 hover:text-slate-200 border border-slate-900"
                }`}
              >
                {sub.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Country Filter Pills */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mr-1 flex items-center gap-1">
          <Globe className="w-3 h-3" /> Region:
        </span>
        {countries.map((c) => {
          const isActive = selectedCountry === c.id;
          return (
            <button
              key={c.id}
              onClick={() => setSelectedCountry(c.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                isActive
                  ? "bg-slate-800 text-white border border-slate-600 shadow-sm"
                  : "bg-slate-900/60 text-slate-400 hover:text-slate-200 border border-slate-800/80"
              }`}
            >
              <span>{c.flag}</span>
              <span>{c.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
