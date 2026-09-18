"use client";

import { useEffect, useState } from "react";
import ChannelCard from "./ChannelCard";
import FilterBar from "./FilterBar";
import { Tv, RefreshCw, AlertCircle } from "lucide-react";

interface ChannelData {
  _id: string;
  name: string;
  logo: string;
  category: string;
  subCategory?: string;
  country: string;
  activeStreamCount: number;
}

interface ChannelGridProps {
  initialSearch?: string;
}

export default function ChannelGrid({ initialSearch = "" }: ChannelGridProps) {
  const [channels, setChannels] = useState<ChannelData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedCategory, setSelectedCategory] = useState("All");
  const [selectedSubCategory, setSelectedSubCategory] = useState("All");
  const [selectedCountry, setSelectedCountry] = useState("All");
  const [searchQuery, setSearchQuery] = useState(initialSearch);

  const fetchChannels = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (selectedCategory !== "All") params.append("category", selectedCategory);
      if (selectedSubCategory !== "All") params.append("subCategory", selectedSubCategory);
      if (selectedCountry !== "All") params.append("country", selectedCountry);
      if (searchQuery) params.append("search", searchQuery);

      const res = await fetch(`/api/channels?${params.toString()}`);
      const data = await res.json();

      if (data.success) {
        setChannels(data.channels);
      } else {
        setError(data.error || "Failed to load channels");
      }
    } catch {
      setError("Network error while connecting to server");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchChannels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategory, selectedSubCategory, selectedCountry, searchQuery]);

  return (
    <div>
      {/* Category & Region Filter */}
      <FilterBar
        selectedCategory={selectedCategory}
        setSelectedCategory={setSelectedCategory}
        selectedSubCategory={selectedSubCategory}
        setSelectedSubCategory={setSelectedSubCategory}
        selectedCountry={selectedCountry}
        setSelectedCountry={setSelectedCountry}
      />

      {/* Grid Content Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Tv className="w-5 h-5 text-brand-500" />
          <h2 className="text-lg font-bold text-white tracking-tight">
            {selectedCategory === "All" ? "Live Channels" : selectedCategory}
          </h2>
          <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-slate-800 text-slate-400 border border-slate-700/80">
            {channels.length} Available
          </span>
        </div>

        <button
          onClick={fetchChannels}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-slate-400 hover:text-white bg-slate-900 border border-slate-800 hover:border-slate-700 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Skeleton Loading State */}
      {loading && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {[...Array(12)].map((_, i) => (
            <div key={i} className="glass-card rounded-2xl p-5 h-36 animate-pulse flex flex-col items-center justify-center gap-3">
              <div className="w-16 h-16 bg-slate-800 rounded-2xl" />
              <div className="w-24 h-3 bg-slate-800 rounded" />
            </div>
          ))}
        </div>
      )}

      {/* Error Message */}
      {!loading && error && (
        <div className="glass-card rounded-2xl p-8 text-center max-w-md mx-auto my-8">
          <AlertCircle className="w-10 h-10 text-red-500 mx-auto mb-3" />
          <h3 className="text-base font-bold text-white mb-1">Failed to Load Live Streams</h3>
          <p className="text-xs text-slate-400 mb-4">{error}</p>
          <button
            onClick={fetchChannels}
            className="px-4 py-2 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-xs font-bold transition-colors shadow-lg shadow-brand-600/30"
          >
            Try Again
          </button>
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && channels.length === 0 && (
        <div className="glass-card rounded-2xl p-12 text-center max-w-lg mx-auto my-8">
          <div className="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center mx-auto mb-4">
            <Tv className="w-8 h-8 text-slate-600" />
          </div>
          <h3 className="text-base font-bold text-white mb-1">No Active Live Streams Found</h3>
          <p className="text-xs text-slate-400 mb-6">
            There are no channels with verified active stream links matching your filters right now.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={() => {
                setSelectedCategory("All");
                setSelectedSubCategory("All");
                setSelectedCountry("All");
                setSearchQuery("");
              }}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold transition-colors border border-slate-700"
            >
              Clear All Filters
            </button>
          </div>
        </div>
      )}

      {/* Channel Cards Grid */}
      {!loading && !error && channels.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {channels.map((ch) => (
            <ChannelCard
              key={ch._id}
              id={ch._id}
              name={ch.name}
              logo={ch.logo}
            />
          ))}
        </div>
      )}
    </div>
  );
}
