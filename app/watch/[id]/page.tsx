"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import Header from "@/components/Header";
import HlsPlayer, { StreamMirror } from "@/components/HlsPlayer";
import Link from "next/link";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { getChannelLogo } from "@/lib/utils";
import {
  getCategoryBySlug,
  isChannelInCategory,
  CATEGORIES,
  CategoryConfig,
  GENRE_FILTERS,
  GenreFilter,
  matchesGenreFilter,
} from "@/lib/categories";
import {
  ArrowLeft,
  AlertCircle,
  RefreshCw,
  Tv,
  Play,
  Radio,
  CheckCircle2,
} from "lucide-react";

interface ChannelDetails {
  _id: string;
  name: string;
  logo: string;
  category: string;
  subCategory?: string;
  country: string;
  streams: StreamMirror[];
}

interface SidebarChannel {
  _id: string;
  name: string;
  logo: string;
  category: string;
  subCategory?: string;
  country: string;
  activeStreamCount: number;
}

export default function WatchPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const channelIdParam = (params?.id as string) || "";
  const [activeChannelId, setActiveChannelId] = useState<string>(channelIdParam);
  const [channel, setChannel] = useState<ChannelDetails | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentStreamIndex, setCurrentStreamIndex] = useState(0);
  const [isTuning, setIsTuning] = useState(false);
  const [tuningLabel, setTuningLabel] = useState<string | null>(null);

  // Sidebar auto-scroll refs (keeps the playing channel visible in the list)
  const listRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);

  // Guards against out-of-order responses: only the response matching the
  // most recently requested channel is allowed to update state. Without this,
  // switching channels quickly (or a slow/stale request resolving late) could
  // overwrite the screen with an error for a channel that isn't even showing
  // anymore, wiping out the player.
  const latestRequestIdRef = useRef(0);

  /**
   * Snapshot of the channel that was actually on screen right before a
   * switch was attempted, plus the URL it lived at. If the channel we're
   * trying to switch to turns out not to work (bad metadata or every stream
   * link dead), we roll the whole page — player, sidebar highlight and URL —
   * back to this instead of leaving the UI pointed at a channel that never
   * actually started playing.
   */
  const previousChannelSnapshotRef = useRef<{
    id: string;
    channel: ChannelDetails | null;
    streamIndex: number;
    url: string;
  } | null>(null);
  /** The channel a switch is currently in flight for; cleared once it either commits or is reverted. */
  const pendingSwitchTargetIdRef = useRef<string | null>(null);

  // Height measurement to equalize left and right columns on desktop
  const leftColRef = useRef<HTMLDivElement>(null);
  const [leftHeight, setLeftHeight] = useState<number | null>(null);
  const [isDesktop, setIsDesktop] = useState(false);

  // All loaded channels for sidebar
  const [allChannels, setAllChannels] = useState<SidebarChannel[]>([]);
  const [sidebarLoading, setSidebarLoading] = useState(true);
  const [sidebarGenre, setSidebarGenre] = useState<GenreFilter>("all");

  /**
   * Channels hidden client-side the instant their last server failed, so the
   * playlist reacts immediately instead of waiting for the next poll. The list
   * is reconciled against the server on every refresh: any channel the backend
   * still returns has working streams again and is restored automatically.
   */
  const [hiddenChannelIds, setHiddenChannelIds] = useState<string[]>([]);

  // Category resolution
  const categoryParamSlug = searchParams.get("category") || "";
  const [activeCategorySlug, setActiveCategorySlug] = useState<string>(categoryParamSlug);

  // Window resize observer
  useEffect(() => {
    const handleResize = () => {
      setIsDesktop(window.innerWidth >= 1024);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Observe left column height
  useEffect(() => {
    const el = leftColRef.current;
    if (!el) return;

    const updateHeight = () => {
      if (leftColRef.current) {
        setLeftHeight(leftColRef.current.offsetHeight);
      }
    };

    updateHeight();
    const observer = new ResizeObserver(() => {
      updateHeight();
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [channel, initialLoading]);

  /**
   * Undoes an in-flight channel switch that didn't pan out, putting the
   * player, sidebar highlight and URL back exactly where they were before
   * the attempt — so a channel that never actually started playing never
   * ends up looking "selected" or "active" while something else is on screen.
   */
  const revertFailedSwitch = useCallback(() => {
    const snapshot = previousChannelSnapshotRef.current;
    if (!snapshot || !pendingSwitchTargetIdRef.current) return;

    // If the viewer has already moved on to a different channel (or gone
    // back) since this attempt started, this callback is stale — don't
    // clobber whatever they're looking at now.
    if (activeChannelId !== pendingSwitchTargetIdRef.current) {
      pendingSwitchTargetIdRef.current = null;
      previousChannelSnapshotRef.current = null;
      return;
    }

    pendingSwitchTargetIdRef.current = null;
    previousChannelSnapshotRef.current = null;

    // Don't revert onto a channel already confirmed dead (e.g. this switch
    // was itself an auto-hop away from a channel whose servers all just
    // failed) — that would just trade one broken channel for another.
    if (hiddenChannelIds.includes(snapshot.id)) {
      setError("No other channels are available in this category right now.");
      return;
    }

    setActiveChannelId(snapshot.id);
    setChannel(snapshot.channel);
    setCurrentStreamIndex(snapshot.streamIndex);
    setError(null);
    window.history.replaceState(null, "", snapshot.url);
  }, [activeChannelId, hiddenChannelIds]);

  // Fetch channel details
  const loadChannelData = useCallback(async (channelId: string, isInitial: boolean = false) => {
    const requestId = ++latestRequestIdRef.current;

    if (isInitial) {
      setInitialLoading(true);
    }
    setError(null);

    try {
      const res = await fetch(`/api/channels/${channelId}`);
      const data = await res.json();

      // A newer channel switch has started since this request went out —
      // discard this response instead of letting it clobber the current screen.
      if (requestId !== latestRequestIdRef.current) return;

      if (data.success && data.channel) {
        setChannel(data.channel);
        setCurrentStreamIndex(0);

        // Auto-detect category if not already specified in URL
        if (!categoryParamSlug) {
          const matched = CATEGORIES.find((cat) => isChannelInCategory(data.channel, cat));
          if (matched) {
            setActiveCategorySlug(matched.slug);
          }
        }
      } else if (!isInitial) {
        // Switching to this channel failed at the metadata level (e.g. it
        // just went offline) — stay on whatever was already playing instead
        // of blanking the whole page out from under the viewer.
        revertFailedSwitch();
      } else {
        setError(data.error || "Channel stream not found");
      }
    } catch {
      if (requestId !== latestRequestIdRef.current) return;
      if (!isInitial) {
        revertFailedSwitch();
      } else {
        setError("Network error fetching stream configuration");
      }
    } finally {
      if (requestId === latestRequestIdRef.current) {
        setInitialLoading(false);
      }
    }
  }, [categoryParamSlug, revertFailedSwitch]);

  /**
   * Loads the playlist. The API only returns channels that currently have at
   * least one ACTIVE stream link, so it doubles as the auto-restoration
   * mechanism: once the backend health check revives a channel's streams, the
   * next refresh brings it back and clears its local hidden flag.
   *
   * @param silent background refresh — don't flash the loading state
   */
  const fetchSidebarChannels = useCallback(async (silent: boolean = false) => {
    if (!silent) setSidebarLoading(true);
    try {
      const res = await fetch("/api/channels", { cache: "no-store" });
      const data = await res.json();
      if (data.success && Array.isArray(data.channels)) {
        setAllChannels(data.channels);

        // Anything the server still lists is healthy again → un-hide it.
        const liveIds = new Set<string>(data.channels.map((c: SidebarChannel) => c._id));
        setHiddenChannelIds((prev) => prev.filter((id) => !liveIds.has(id)));
      }
    } catch {
      console.error("Failed to load sidebar channels");
    } finally {
      if (!silent) setSidebarLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    if (channelIdParam) {
      setActiveChannelId(channelIdParam);
      loadChannelData(channelIdParam, true);
    }
    fetchSidebarChannels();
  }, [channelIdParam, loadChannelData, fetchSidebarChannels]);

  /**
   * Channel switches update the URL with a raw `window.history.replaceState`
   * (see `handleSelectChannel`) so the player never remounts and flipping
   * through channels never piles up browser-history entries — a hardware
   * back press should return to the page the viewer actually came from (e.g.
   * a category list), not step backward through every channel they tuned
   * past. Since replaceState doesn't create history entries, Next's router
   * never sees these URL changes either. This listener only matters for the
   * rare case of a real back/forward navigation that still lands on a
   * `/watch/:id` URL (e.g. forward-navigating into one from history built
   * before this page loaded) and re-syncs the page state to match.
   */
  useEffect(() => {
    const onPopState = () => {
      const match = window.location.pathname.match(/\/watch\/([^/?]+)/);
      const newId = match?.[1];
      if (newId && newId !== activeChannelId) {
        setActiveChannelId(newId);
        loadChannelData(newId, false);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [activeChannelId, loadChannelData]);

  /**
   * Background health poll. Picks up channels the server-side health checker
   * has restored (and drops ones it has taken offline) without a page reload.
   */
  useEffect(() => {
    const interval = setInterval(() => fetchSidebarChannels(true), 60_000);
    return () => clearInterval(interval);
  }, [fetchSidebarChannels]);

  // Active Category Object
  const currentCategoryConfig: CategoryConfig = useMemo(() => {
    if (activeCategorySlug) {
      const found = getCategoryBySlug(activeCategorySlug);
      if (found) return found;
    }
    if (channel) {
      const matched = CATEGORIES.find((cat) => isChannelInCategory(channel, cat));
      if (matched) return matched;
    }
    return CATEGORIES[1]; // Default to Bangladeshi TV
  }, [activeCategorySlug, channel]);

  // Filter sidebar channels strictly to active category & active genre
  const filteredSidebarChannels = useMemo(() => {
    if (!currentCategoryConfig || allChannels.length === 0) return allChannels;
    // Drop channels whose servers just died — they disappear from the playlist
    // instantly and return only when the backend reports them healthy again.
    const visible = allChannels.filter((c) => !hiddenChannelIds.includes(c._id));

    let list = visible.filter((c) => isChannelInCategory(c, currentCategoryConfig));
    if (list.length === 0) list = visible;

    if (sidebarGenre !== "all") {
      list = list.filter((c) => matchesGenreFilter(c, sidebarGenre));
    }
    return list;
  }, [allChannels, currentCategoryConfig, sidebarGenre, hiddenChannelIds]);

  /**
   * Auto-scroll the sidebar so the channel that is currently playing is
   * centered in the list. Runs on first load (arriving from a category page)
   * and again on every channel switch or genre filter change.
   */
  useEffect(() => {
    if (sidebarLoading) return;

    const raf = requestAnimationFrame(() => {
      const container = listRef.current;
      const item = activeItemRef.current;
      if (!container || !item) return;

      // Center the active row inside the scroll container (never the page).
      const target =
        item.offsetTop - container.clientHeight / 2 + item.offsetHeight / 2;
      const maxScroll = container.scrollHeight - container.clientHeight;

      container.scrollTo({
        top: Math.max(0, Math.min(target, maxScroll)),
        behavior: "smooth",
      });
    });

    return () => cancelAnimationFrame(raf);
  }, [activeChannelId, sidebarLoading, filteredSidebarChannels, leftHeight]);

  // Handle instant channel switch without full page reload
  const handleSelectChannel = useCallback(
    (newChannelId: string) => {
      if (newChannelId === activeChannelId) return;

      // Remember what's actually on screen right now so we can restore it if
      // this switch doesn't pan out.
      previousChannelSnapshotRef.current = {
        id: activeChannelId,
        channel,
        streamIndex: currentStreamIndex,
        url: window.location.pathname + window.location.search,
      };
      pendingSwitchTargetIdRef.current = newChannelId;

      setActiveChannelId(newChannelId);
      const catQuery = currentCategoryConfig?.slug ? `?category=${currentCategoryConfig.slug}` : "";
      // replaceState, not pushState: flipping through channels shouldn't pile
      // up browser-history entries. Otherwise the hardware/gesture back button
      // steps backward through every channel the viewer has tuned past
      // instead of returning to the page (e.g. the category list) they
      // actually came from.
      window.history.replaceState(null, "", `/watch/${newChannelId}${catQuery}`);

      loadChannelData(newChannelId, false);
    },
    [activeChannelId, channel, currentStreamIndex, currentCategoryConfig, loadChannelData]
  );

  /**
   * Reflects the player's background-tuning state outside the player itself —
   * used to show "CONNECTING" instead of "PLAYING" on the target channel in
   * the sidebar, and to square off the player frame while it's connecting.
   */
  const handleSwitchingChange = useCallback((switching: boolean, label: string | null) => {
    setIsTuning(switching);
    setTuningLabel(label);
    if (!switching) {
      // The attempt settled — either it committed successfully, or it failed
      // and handleSwitchFailed already reverted the page. Either way there's
      // nothing left to roll back.
      pendingSwitchTargetIdRef.current = null;
      previousChannelSnapshotRef.current = null;
    }
  }, []);

  /**
   * The player tried every stream link for the target channel and none of
   * them would play. The player itself stays on whatever was already on
   * screen (it never commits a switch that didn't work) — this puts the rest
   * of the page (sidebar highlight, URL, channel info) back in sync with it.
   */
  const handleSwitchFailed = useCallback(() => {
    revertFailedSwitch();
  }, [revertFailedSwitch]);

  /**
   * Every server for this channel is dead. The player has already shown the
   * Bangla notice for 5 seconds, so now:
   *   1. hide the channel from the playlist immediately,
   *   2. re-sync with the backend (which has already marked the links broken),
   *   3. hop to the next channel in the visible list.
   */
  const handleAllServersFailed = useCallback(() => {
    const list = filteredSidebarChannels;
    const index = list.findIndex((c) => c._id === activeChannelId);

    // Prefer the next channel down the list; fall back to the previous one.
    const next =
      list.slice(index + 1).find((c) => c._id !== activeChannelId) ||
      list.slice(0, Math.max(index, 0)).reverse().find((c) => c._id !== activeChannelId) ||
      null;

    setHiddenChannelIds((prev) =>
      prev.includes(activeChannelId) ? prev : [...prev, activeChannelId]
    );

    // Pull the authoritative list (the failed links were reported already).
    fetchSidebarChannels(true);

    if (next) {
      handleSelectChannel(next._id);
    } else {
      setError("No other channels are available in this category right now.");
    }
  }, [filteredSidebarChannels, activeChannelId, fetchSidebarChannels, handleSelectChannel]);

  return (
    <div className="h-[100dvh] overflow-hidden lg:h-auto lg:min-h-screen lg:overflow-visible bg-[#060b13] text-slate-100 flex flex-col">
      {/* Navbar hidden on mobile for the player page; visible from sm breakpoint up */}
      <div className="hidden sm:block shrink-0">
        <Header />
      </div>

      <main className="flex-1 min-h-0 flex flex-col overflow-hidden lg:block lg:overflow-visible max-w-[1400px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-3 lg:py-6 lg:space-y-5">
        {/* Top Back Navigation - shown while loading / on error (non-sticky) */}
        {(initialLoading || (!initialLoading && error)) && (
          <div>
            <Link
              href={`/category/${currentCategoryConfig.slug}`}
              className="inline-flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-white transition-colors group"
            >
              <div className="w-7 h-7 rounded-lg bg-[#0d1628] border border-slate-800 flex items-center justify-center group-hover:border-emerald-500 transition-colors">
                <ArrowLeft className="w-4 h-4 text-slate-400 group-hover:text-emerald-400" />
              </div>
              <span>Back to {currentCategoryConfig.title}</span>
            </Link>
          </div>
        )}

        {initialLoading && (
          <div className="rounded-2xl border border-slate-800 bg-[#0a1222] p-16 text-center max-w-md mx-auto my-12 shadow-2xl">
            <RefreshCw className="w-10 h-10 text-emerald-400 animate-spin mx-auto mb-3" />
            <p className="text-sm font-bold text-white">Connecting to Live HD Stream Feed...</p>
          </div>
        )}

        {!initialLoading && error && (
          <div className="rounded-2xl border border-slate-800 bg-[#0a1222] p-8 text-center max-w-md mx-auto my-12 shadow-2xl">
            <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
            <h2 className="text-base font-bold text-white mb-1">Stream Signal Error</h2>
            <p className="text-xs text-slate-400 mb-5">{error}</p>
            <Link
              href={`/category/${currentCategoryConfig.slug}`}
              className="inline-block px-5 py-2.5 bg-[#00c978] hover:bg-[#00e589] text-slate-950 font-bold rounded-xl text-xs transition-colors shadow-lg"
            >
              Return to {currentCategoryConfig.title}
            </Link>
          </div>
        )}

        {!initialLoading && channel && !error && (
          <div className="flex flex-col flex-1 min-h-0 gap-3 lg:grid lg:grid-cols-12 lg:gap-6 lg:items-start lg:flex-none lg:min-h-0">
            {/* ========== LEFT: Player + Channel Info Card (8 cols) ========== */}
            <div ref={leftColRef} className="lg:col-span-8 space-y-4 shrink-0">
              {/* On mobile this block is pinned by the layout itself: the page body
                  never scrolls, so the player stays fixed in place and only the
                  channel list below it scrolls. */}
              <div className="z-20 bg-[#060b13] space-y-2.5 lg:bg-transparent lg:space-y-4">
                {/* Back Navigation + Mobile Server Switch (same line, space-between) */}
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/category/${currentCategoryConfig.slug}`}
                    className="inline-flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-white transition-colors group shrink-0"
                  >
                    <div className="w-7 h-7 rounded-lg bg-[#0d1628] border border-slate-800 flex items-center justify-center group-hover:border-emerald-500 transition-colors">
                      <ArrowLeft className="w-4 h-4 text-slate-400 group-hover:text-emerald-400" />
                    </div>
                    <span className="hidden sm:inline">Back to {currentCategoryConfig.title}</span>
                    <span className="sm:hidden">Back</span>
                  </Link>

                  {/* Compact server switcher - mobile only */}
                  {channel.streams.length > 0 && (
                    <div className="flex lg:hidden items-center gap-1.5 overflow-x-auto scrollbar-none min-w-0">
                      {channel.streams.map((st, idx) => {
                        const isSelected = idx === currentStreamIndex;
                        return (
                          <button
                            key={st._id}
                            onClick={() => setCurrentStreamIndex(idx)}
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all shrink-0 cursor-pointer ${
                              isSelected
                                ? "bg-[#00c978] text-slate-950 shadow-sm"
                                : "bg-[#0d1628] text-slate-300 border border-slate-800"
                            }`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${
                                isSelected ? "bg-slate-950" : "bg-emerald-400"
                              }`}
                            />
                            <span>Server {idx + 1}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* TV Player Box */}
                <div className="relative overflow-hidden border-0 rounded-none bg-black shadow-2xl">
                  <HlsPlayer
                    channelName={channel.name}
                    streams={channel.streams}
                    currentStreamIndex={currentStreamIndex}
                    onStreamIndexChange={setCurrentStreamIndex}
                    onAllServersFailed={handleAllServersFailed}
                    onSwitchingChange={handleSwitchingChange}
                    onSwitchFailed={handleSwitchFailed}
                  />
                </div>
              </div>

              {/* Bottom Channel Info Banner - Hidden on Mobile */}
              <div className="hidden lg:flex rounded-2xl border border-slate-800/80 bg-[#0a1222] p-4 sm:p-5 items-center gap-4 shadow-xl">
                {/* White Logo Container */}
                <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl bg-white p-2.5 flex items-center justify-center shrink-0 shadow-md">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={getChannelLogo(channel.name, channel.logo)}
                    alt={channel.name}
                    className="max-w-full max-h-full object-contain"
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      if (!target.dataset.fallback) {
                        target.dataset.fallback = "true";
                        const initials = channel.name.substring(0, 2).toUpperCase();
                        target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=0284c7&color=ffffff&size=200&bold=true`;
                      }
                    }}
                  />
                </div>

                {/* Channel Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <h1 className="text-base sm:text-lg font-black text-white tracking-tight">
                      {channel.name}
                    </h1>
                    {/* Category Pill */}
                    <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                      {currentCategoryConfig.title}
                    </span>
                    {/* Live Pill */}
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500/15 text-red-400 border border-red-500/30">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                      <span>LIVE</span>
                    </span>
                  </div>

                  <p className="text-xs text-slate-400">
                    {channel.subCategory && channel.subCategory !== "Others"
                      ? channel.subCategory
                      : channel.category || "General Broadcast"} • HD Quality Stream
                  </p>
                </div>
              </div>
            </div>

            {/* ========== RIGHT: Category Channels Sidebar (4 cols) ========== */}
            <div className="lg:col-span-4 flex flex-col w-full flex-1 min-h-0 lg:flex-none">
              <div
                className="rounded-2xl border border-slate-800/80 bg-[#0a1222] overflow-hidden flex flex-col w-full shadow-2xl h-full lg:h-auto"
                style={{
                  height: isDesktop && leftHeight ? `${leftHeight}px` : undefined,
                  maxHeight: isDesktop && leftHeight ? `${leftHeight}px` : undefined,
                }}
              >
                {/* Sidebar Header */}
                <div className="p-3.5 border-b border-slate-800/80 flex items-center justify-between shrink-0 bg-[#0d1628]">
                  <h2 className="text-sm font-black text-white tracking-tight flex items-center gap-2">
                    <span>{currentCategoryConfig.title} Channels</span>
                  </h2>
                  <span className="text-[10px] font-bold text-emerald-400 bg-[#070d18] border border-emerald-500/30 px-2.5 py-0.5 rounded-full">
                    {filteredSidebarChannels.length} Live
                  </span>
                </div>

                {/* Mini Genre Filter Pills in Sidebar */}
                <div className="p-2 border-b border-slate-800/60 bg-[#080e1b] flex items-center gap-1.5 overflow-x-auto scrollbar-none shrink-0">
                  {GENRE_FILTERS.map((f) => {
                    const isActive = sidebarGenre === f.id;
                    return (
                      <button
                        key={f.id}
                        onClick={() => setSidebarGenre(f.id)}
                        className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all shrink-0 cursor-pointer ${
                          isActive
                            ? "bg-[#00c978] text-slate-950 shadow-sm"
                            : "bg-[#0d1628] text-slate-400 hover:text-white hover:bg-slate-800 border border-slate-800"
                        }`}
                      >
                        {f.label === "All Channels" ? "All" : f.label}
                      </button>
                    );
                  })}
                </div>

                {/* Scrollable Channel List */}
                <div
                  ref={listRef}
                  className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin [-webkit-overflow-scrolling:touch]"
                >
                  {sidebarLoading ? (
                    <div className="p-8 text-center">
                      <RefreshCw className="w-6 h-6 text-emerald-400 animate-spin mx-auto mb-2" />
                      <p className="text-xs text-slate-400">Loading channels...</p>
                    </div>
                  ) : filteredSidebarChannels.length === 0 ? (
                    <div className="p-8 text-center">
                      <Tv className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                      <p className="text-xs text-slate-400">No channels under &quot;{sidebarGenre}&quot;</p>
                      <button
                        onClick={() => setSidebarGenre("all")}
                        className="mt-2 text-[10px] text-emerald-400 hover:underline"
                      >
                        Show All Channels
                      </button>
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-800/60 p-2 space-y-1">
                      {filteredSidebarChannels.map((ch) => {
                        const isActive = ch._id === activeChannelId;
                        const chLogo = getChannelLogo(ch.name, ch.logo);

                        return (
                          <button
                            key={ch._id}
                            ref={isActive ? activeItemRef : undefined}
                            onClick={() => handleSelectChannel(ch._id)}
                            className={`w-full flex items-center gap-3 p-2.5 rounded-xl transition-all text-left group border ${
                              isActive
                                ? "bg-[#0d1f33] border-emerald-500 shadow-md shadow-emerald-500/10"
                                : "border-transparent bg-transparent hover:bg-slate-800/50"
                            }`}
                          >
                            {/* Logo Box */}
                            <div
                              className={`w-11 h-11 shrink-0 rounded-lg p-1.5 flex items-center justify-center transition-colors overflow-hidden ${
                                isActive
                                  ? "bg-white border border-emerald-400 ring-2 ring-emerald-500/30"
                                  : "bg-white/95 border border-slate-700 group-hover:border-slate-500"
                              }`}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={chLogo}
                                alt={ch.name}
                                className="max-w-full max-h-full object-contain"
                                onError={(e) => {
                                  const target = e.target as HTMLImageElement;
                                  if (!target.dataset.fallback) {
                                    target.dataset.fallback = "true";
                                    const initials = ch.name.substring(0, 2).toUpperCase();
                                    target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=0284c7&color=ffffff&size=200&bold=true`;
                                  }
                                }}
                              />
                            </div>

                            {/* Channel Info */}
                            <div className="flex-1 min-w-0">
                              <h3
                                className={`text-xs truncate ${
                                  isActive
                                    ? "font-black text-emerald-300"
                                    : "font-bold text-slate-200 group-hover:text-white"
                                }`}
                              >
                                {ch.name}
                              </h3>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                                <span className="text-[10px] font-semibold text-slate-400">
                                  LIVE
                                </span>
                              </div>
                            </div>

                            {/* Right Status Tag */}
                            <div className="shrink-0">
                              {isActive ? (
                                isTuning ? (
                                  <div
                                    className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/40"
                                    title={tuningLabel ? `Tuning into ${tuningLabel}...` : undefined}
                                  >
                                    <RefreshCw className="w-2.5 h-2.5 text-amber-300 animate-spin" />
                                    <span className="text-[9px] font-black text-amber-300">
                                      CONNECTING
                                    </span>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/20 border border-emerald-500/40">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                    <span className="text-[9px] font-black text-emerald-300">
                                      PLAYING
                                    </span>
                                  </div>
                                )
                              ) : (
                                <div className="w-6 h-6 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center group-hover:bg-[#00c978] group-hover:text-slate-950 transition-all">
                                  <Play className="w-3 h-3 fill-current ml-0.5" />
                                </div>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="hidden lg:block border-t border-slate-800/80 bg-[#070d18] py-4 text-center text-xs text-slate-400 mt-8">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>SoluPlay • {currentCategoryConfig.title} Stream</span>
          <div className="flex items-center gap-4 text-slate-400">
            {CATEGORIES.map((c) => (
              <Link
                key={c.slug}
                href={`/category/${c.slug}`}
                className={c.slug === currentCategoryConfig.slug ? "text-emerald-400 font-bold" : "hover:text-white"}
              >
                {c.name}
              </Link>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
