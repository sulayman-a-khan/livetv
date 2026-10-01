"use client";

/**
 * MpegTsPlayer — raw MPEG-TS / Xtream `.ts` live playback.
 *
 * A drop-in sibling of HlsPlayer for channels whose active link is a raw
 * transport stream rather than an HLS `.m3u8` playlist. `.ts` feeds can't be
 * handed straight to a browser <video> (no MSE demuxer for bare TS, and the
 * provider blocks non-IPTV user agents + sends no CORS headers), so:
 *
 *   - the source is routed through our /api/stream proxy (buildStreamProxyUrl),
 *     which adds `User-Agent: IPTVSmartersPlayer` and CORS server-side;
 *   - mpegts.js (dynamically imported, so it never runs during SSR) demuxes the
 *     TS into fMP4 and feeds it to MediaSource.
 *
 * This player mirrors the raw stream 1-to-1 for normal playback: buffering,
 * stalls and a black picture are left to mpegts.js and the <video> element to
 * render natively — there is no frozen-frame overlay and no artificial
 * "Reconnecting…" masking. mpegts keeps a natural live buffer (stash enabled,
 * no latency chasing) so minor chunk delays don't reset the connection.
 *
 * The ONE recovery path is a frozen-progress watchdog: only when the video clock
 * has been continuously stuck for 8s (after having played) does it rebuild the
 * player against a fresh cache-busted URL (`_t=<nonce>`) to re-fetch the LIVE
 * edge — which is how the provider's ~25s session expiry is absorbed without
 * replaying the first buffered clip. Frequent mpegts ERROR events from small
 * buffer shifts are logged and ignored, so they never flash the status bar.
 *
 * The .m3u8 (HlsPlayer) and YouTube (YouTubeLivePlayer) paths are untouched —
 * the watch page picks this component only for `.ts` / proxied sources.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { buildStreamProxyUrl } from "@/lib/streamType";
import type mpegtsNamespace from "mpegts.js";

type MpegtsModule = typeof mpegtsNamespace;
type MpegtsPlayer = mpegtsNamespace.Player;

export interface StreamMirror {
  _id: string;
  url: string;
  priority: number;
  status: "active" | "degraded" | "broken";
  latency: number;
}

interface MpegTsPlayerProps {
  channelName: string;
  streams: StreamMirror[];
  currentStreamIndex?: number;
  onStreamIndexChange?: (index: number) => void;
  onAllServersFailed?: () => void;
  onStreamFailed?: (streamId: string) => void;
  onSwitchFailed?: (attemptedLabel: string) => void;
  onSwitchingChange?: (switching: boolean, label: string | null) => void;
}

/** Recovery only fires after playback is CONTINUOUSLY frozen this long. */
const FROZEN_RELOAD_MS = 8000;
/** How often the frozen-progress watchdog samples the video clock. */
const PROGRESS_POLL_MS = 1000;

export default function MpegTsPlayer({
  channelName,
  streams,
  currentStreamIndex: controlledStreamIndex,
  onStreamIndexChange,
  onSwitchingChange,
}: MpegTsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<MpegtsPlayer | null>(null);
  const mpegtsRef = useRef<MpegtsModule | null>(null);

  // ---- Index handling (controlled or internal, mirrors HlsPlayer) ----
  const [internalStreamIndex, setInternalStreamIndex] = useState(0);
  const isControlled = controlledStreamIndex !== undefined;
  const currentStreamIndex = isControlled ? (controlledStreamIndex as number) : internalStreamIndex;

  const setCurrentStreamIndex = useCallback(
    (index: number) => {
      if (!isControlled) setInternalStreamIndex(index);
      onStreamIndexChange?.(index);
    },
    [isControlled, onStreamIndexChange]
  );

  // ---- Chrome state ----
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1.0);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [displayedChannelName, setDisplayedChannelName] = useState(channelName);
  const [displayedIndex, setDisplayedIndex] = useState(currentStreamIndex);
  const [controlsVisible, setControlsVisible] = useState(false);

  // ---- Switching state ----
  const [switching, setSwitching] = useState(false);
  const [pendingChannelLabel, setPendingChannelLabel] = useState<string | null>(null);

  // ---- Refs for stable access inside handlers ----
  const streamsRef = useRef<StreamMirror[]>(streams || []);
  streamsRef.current = streams || [];
  const indexRef = useRef(currentStreamIndex);
  const lastAppliedIdRef = useRef<string | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  const hasLoadedOnceRef = useRef(false);
  const mountedRef = useRef(true);

  // ---- Fullscreen state (parity with HlsPlayer) ----
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cssFullscreen, setCssFullscreen] = useState(false);
  const cssFullscreenRef = useRef(false);
  cssFullscreenRef.current = cssFullscreen;
  const [portraitPhone, setPortraitPhone] = useState(false);
  const fsGuardPushedRef = useRef(false);
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);

  /** Lazily import mpegts.js (client-only) and quiet its logging. */
  const ensureModule = useCallback(async (): Promise<MpegtsModule | null> => {
    if (mpegtsRef.current) return mpegtsRef.current;
    try {
      const mod = await import("mpegts.js");
      const mpegts = (mod as unknown as { default: MpegtsModule }).default || (mod as unknown as MpegtsModule);
      try {
        mpegts.LoggingControl.applyConfig({
          enableAll: false,
          enableError: true,
          enableWarn: false,
          enableInfo: false,
        });
      } catch {
        /* logging control is best-effort */
      }
      mpegtsRef.current = mpegts;
      return mpegts;
    } catch (err) {
      console.error("[MpegTsPlayer] failed to load mpegts.js", err);
      return null;
    }
  }, []);

  const destroyPlayer = useCallback(() => {
    const p = playerRef.current;
    playerRef.current = null;
    if (!p) return;
    try {
      p.pause();
    } catch {
      /* ignore */
    }
    try {
      p.unload();
    } catch {
      /* ignore */
    }
    try {
      p.detachMediaElement();
    } catch {
      /* ignore */
    }
    try {
      p.destroy();
    } catch {
      /* ignore */
    }
  }, []);

  /** Late-bound so the switch effect (and reload) can call it. */
  const createAndLoadRef = useRef<((rawUrl: string) => void) | null>(null);
  /** Late-bound so the frozen watchdog / user Play can trigger a live reload. */
  const reloadLiveRef = useRef<(() => void) | null>(null);
  // ---- Frozen-progress watchdog (the ONLY automatic recovery trigger) ----
  const progressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastClockRef = useRef(0); // last observed video.currentTime
  const frozenSinceRef = useRef(0); // when the clock last stopped advancing
  const hasPlayedRef = useRef(false); // reached playback at least once

  /**
   * Appends a per-load nonce to the proxied URL so every (re)connect is a
   * brand-new request that hits the live edge — never a browser/edge-cached
   * copy of the first ~25s. buildStreamProxyUrl already yields `?url=…`, so we
   * add `&_t=…`; for a bare proxy path we add `?_t=…`.
   */
  const buildLiveUrl = useCallback((rawUrl: string) => {
    const base = buildStreamProxyUrl(rawUrl);
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}_t=${Date.now()}`;
  }, []);

  /** Build the mpegts.js player for a raw feed URL and start playback. */
  const createAndLoad = useCallback(
    (rawUrl: string) => {
      if (!mountedRef.current) return;
      const video = videoRef.current;
      if (!video) return;

      destroyPlayer();
      // Flush any stale MediaSource/blob so a reload can't resume old buffered
      // bytes — the next attach creates a fresh, empty source buffer.
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        /* ignore */
      }
      setIsLoading(true);
      setErrorMsg(null);

      void (async () => {
        const mpegts = await ensureModule();
        if (!mountedRef.current) return;
        if (!mpegts) {
          setErrorMsg("Playback engine failed to load.");
          setIsLoading(false);
          return;
        }
        if (!mpegts.isSupported()) {
          setErrorMsg("This browser can't play raw MPEG-TS streams (no MediaSource support).");
          setIsLoading(false);
          return;
        }

        const proxied = buildLiveUrl(rawUrl);
        let player: MpegtsPlayer;
        try {
          player = mpegts.createPlayer(
            // Pure, non-seekable live source.
            { type: "mpegts", isLive: true, cors: true, url: proxied },
            {
              // Natural live buffer: hold an initial stash before playback so a
              // minor chunk delay doesn't underrun and force an instant drop.
              enableStashBuffer: true,
              stashInitialSize: 384,
              // Do NOT chase the live edge by rate/seek — that constant nudging
              // is what kept resetting the connection. Let it buffer naturally.
              liveBufferLatencyChasing: false,
              // Wipe old chunks from the SourceBuffer for memory health.
              autoCleanupSourceBuffer: true,
            }
          );
        } catch (err) {
          console.error("[MpegTsPlayer] createPlayer failed", err);
          setErrorMsg("Could not initialise the transport-stream player.");
          setIsLoading(false);
          return;
        }

        playerRef.current = player;

        // Minor network/buffer hiccups fire ERROR frequently on a live feed.
        // We deliberately do NOT reload here — recovery is driven solely by the
        // frozen-progress watchdog, and only after FROZEN_RELOAD_MS of a truly
        // stuck clock. Brief shifts never tear down the player or flash the
        // "Connecting…" bar.
        player.on(mpegts.Events.ERROR, (type: string, detail: string) => {
          console.warn("[MpegTsPlayer] stream error (watchdog recovers if frozen)", type, detail);
        });
        player.on(mpegts.Events.LOADING_COMPLETE, () => {
          console.warn("[MpegTsPlayer] feed ended (watchdog recovers if frozen)");
        });

        try {
          player.attachMediaElement(video);
          player.load();
        } catch (err) {
          console.error("[MpegTsPlayer] attach/load failed", err);
          setErrorMsg("Could not start the transport stream.");
          setIsLoading(false);
          return;
        }

        // Apply the user's volume/mute choice (first load = sensible defaults).
        if (!hasLoadedOnceRef.current) {
          hasLoadedOnceRef.current = true;
          video.muted = false;
          video.volume = 1.0;
          setIsMuted(false);
          setVolume(1.0);
        } else {
          video.muted = isMutedRef.current;
          video.volume = volumeRef.current;
        }

        const playPromise = player.play();
        if (playPromise && typeof (playPromise as Promise<void>).catch === "function") {
          (playPromise as Promise<void>).catch((err) => {
            // Autoplay may be blocked until the user interacts — not fatal.
            console.warn("[MpegTsPlayer] autoplay deferred", err);
          });
        }
      })();
    },
    [destroyPlayer, ensureModule, buildLiveUrl]
  );
  createAndLoadRef.current = createAndLoad;

  /**
   * Reload the CURRENT feed from the live edge: tears down the player (purging
   * the SourceBuffer) and rebuilds against a fresh-nonce URL. Called ONLY by the
   * frozen watchdog (after FROZEN_RELOAD_MS) or an explicit user Play on an
   * ended feed — never on a minor buffer shift.
   */
  const reloadLive = useCallback(() => {
    if (!mountedRef.current) return;
    const url = streamsRef.current[indexRef.current]?.url;
    if (!url) return;
    // Reset the freeze baseline so the watchdog waits a full FROZEN_RELOAD_MS
    // before it would consider another reload.
    frozenSinceRef.current = Date.now();
    lastClockRef.current = 0;
    createAndLoadRef.current?.(url);
  }, []);
  reloadLiveRef.current = reloadLive;

  // ---- Initial load + channel/mirror switches driven by props ----
  useEffect(() => {
    mountedRef.current = true;
    if (!streams || streams.length === 0) return;
    const targetIdx = Math.min(Math.max(0, currentStreamIndex), streams.length - 1);
    const target = streams[targetIdx] || streams[0];
    if (!target) return;
    if (target._id === lastAppliedIdRef.current) return;

    lastAppliedIdRef.current = target._id;
    indexRef.current = targetIdx;
    setDisplayedIndex(targetIdx);
    // Re-arm the frozen watchdog for the fresh connection.
    hasPlayedRef.current = false;
    lastClockRef.current = 0;
    frozenSinceRef.current = Date.now();

    if (hasLoadedOnceRef.current) {
      setSwitching(true);
      setPendingChannelLabel(channelName);
    }
    setDisplayedChannelName(channelName);
    createAndLoad(target.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams, currentStreamIndex, channelName]);

  // ---- Full teardown on unmount ----
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      destroyPlayer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Reflect the "tuning into next channel" state to the host ----
  useEffect(() => {
    onSwitchingChange?.(switching, pendingChannelLabel);
  }, [switching, pendingChannelLabel, onSwitchingChange]);

  // ---- <video> element event handlers ----
  const handlePlaying = useCallback(() => {
    setIsPlaying(true);
    setIsLoading(false);
    setSwitching(false);
    setPendingChannelLabel(null);
    // Playback reached the live edge — mark healthy and re-baseline the watchdog.
    hasPlayedRef.current = true;
    const v = videoRef.current;
    lastClockRef.current = v ? v.currentTime : 0;
    frozenSinceRef.current = Date.now();
  }, []);

  const handlePause = useCallback(() => setIsPlaying(false), []);

  /**
   * Frozen-progress watchdog — the ONLY automatic recovery trigger. It samples
   * the video clock once a second and reloads the live edge ONLY when playback
   * has been continuously frozen for FROZEN_RELOAD_MS (8s) after having played.
   * A user pause never counts as frozen, and the frequent mpegts ERROR events
   * from minor buffer shifts are ignored here — so no more 3s reconnect loop.
   */
  useEffect(() => {
    frozenSinceRef.current = Date.now();
    progressTimerRef.current = setInterval(() => {
      const video = videoRef.current;
      if (!video || !mountedRef.current) return;

      const now = Date.now();
      const clock = video.currentTime;

      // User paused (not ended) — keep the baseline fresh, never reload.
      if (video.paused && !video.ended) {
        lastClockRef.current = clock;
        frozenSinceRef.current = now;
        return;
      }

      // Healthy: the clock is advancing.
      if (clock > lastClockRef.current + 0.05) {
        lastClockRef.current = clock;
        frozenSinceRef.current = now;
        hasPlayedRef.current = true;
        return;
      }

      // Genuinely frozen. Recover at most once per FROZEN_RELOAD_MS window, and
      // only for a stream that had already started playing.
      const frozenFor = now - (frozenSinceRef.current || now);
      if (frozenFor >= FROZEN_RELOAD_MS && hasPlayedRef.current) {
        reloadLiveRef.current?.(); // reloadLive resets the freeze baseline
      }
    }, PROGRESS_POLL_MS);

    return () => {
      if (progressTimerRef.current) {
        clearInterval(progressTimerRef.current);
        progressTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Controls ----
  const scheduleControlsHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
      return;
    }
    // If the live feed ended (session dropped), "Play" must fetch the LIVE
    // edge again — not resume the stale buffered clip from ~25s ago.
    if (video.ended || !playerRef.current) {
      reloadLive();
      return;
    }
    video.play().catch(console.error);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    const video = videoRef.current;
    if (video) {
      video.volume = val;
      video.muted = val === 0;
      setIsMuted(val === 0);
    }
  };

  const handleManualServerSelect = (idx: number) => {
    if (idx === indexRef.current) return;
    const target = streamsRef.current[idx];
    if (!target) return;
    indexRef.current = idx;
    setDisplayedIndex(idx);
    lastAppliedIdRef.current = target._id;
    setCurrentStreamIndex(idx);
    setSwitching(true);
    setPendingChannelLabel(channelName);
    createAndLoad(target.url);
  };

  // ---- Fullscreen (native API + rotate frame + CSS fallback, parity w/ HlsPlayer) ----
  useEffect(() => {
    const onFsChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      if (!active) {
        fsGuardPushedRef.current = false;
        const so = screen.orientation as ScreenOrientation & { unlock?: () => void };
        so?.unlock?.();
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, []);

  const exitFullscreenMode = useCallback((consumeGuard: boolean) => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setIsFullscreen(false);
    if (cssFullscreenRef.current) setCssFullscreen(false);
    const so = screen.orientation as ScreenOrientation & { unlock?: () => void };
    so?.unlock?.();
    if (consumeGuard && fsGuardPushedRef.current) {
      fsGuardPushedRef.current = false;
      window.history.back();
    } else {
      fsGuardPushedRef.current = false;
    }
  }, []);

  useEffect(() => {
    const onPopState = () => exitFullscreenMode(false);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [exitFullscreenMode]);

  useEffect(() => {
    const update = () => {
      const hasMatchMedia = typeof window.matchMedia === "function";
      const portrait = hasMatchMedia
        ? window.matchMedia("(orientation: portrait)").matches
        : window.innerHeight >= window.innerWidth;
      setPortraitPhone(window.innerWidth < 1024 && portrait);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  const toggleFullscreen = () => {
    const target = containerRef.current;
    const video = videoRef.current as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitSupportsFullscreen?: boolean })
      | null;
    if (!target) return;

    if (document.fullscreenElement || cssFullscreen) {
      exitFullscreenMode(true);
      return;
    }

    const afterEnter = () => {
      if (!fsGuardPushedRef.current) {
        fsGuardPushedRef.current = true;
        window.history.pushState({ __fsGuard: true }, "");
      }
      const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      so?.lock?.("landscape").catch(() => {});
    };

    const requestFs =
      target.requestFullscreen ||
      (target as HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen;

    if (requestFs) {
      Promise.resolve(requestFs.call(target))
        .then(afterEnter)
        .catch(() => {
          if (video?.webkitSupportsFullscreen && video.webkitEnterFullscreen) video.webkitEnterFullscreen();
          else {
            setCssFullscreen(true);
            afterEnter();
          }
        });
    } else if (video?.webkitSupportsFullscreen && video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    } else {
      setCssFullscreen(true);
      afterEnter();
    }
  };

  // ---- Status bar (initial connect + channel switch only) ----
  let topBarText = "";
  if (switching) {
    topBarText = `Tuning into ${pendingChannelLabel || "next channel"}…`;
  } else if (isLoading) {
    topBarText = "Connecting to live stream…";
  }
  const topBarActive = switching || isLoading;

  const mirrors = streams || [];

  return (
    <div className="w-full space-y-3">
      <div
        ref={containerRef}
        className={`relative bg-black overflow-hidden group rounded-none border-0 ${
          isFullscreen || cssFullscreen
            ? portraitPhone
              ? "fixed top-1/2 left-1/2 z-[999] w-[100dvh] h-[100dvw] -translate-x-1/2 -translate-y-1/2 rotate-90 max-w-none"
              : "fixed inset-0 z-[999] w-screen h-screen max-w-none"
            : "aspect-video w-full mx-auto max-w-[calc(52dvh*16/9)] lg:max-w-none shadow-2xl"
        }`}
        onMouseMove={revealControls}
        onMouseLeave={() => {
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
          setControlsVisible(false);
        }}
        onTouchStart={revealControls}
      >
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-contain cursor-pointer"
          onClick={revealControls}
          onPlaying={handlePlaying}
          onPause={handlePause}
          playsInline
        />

        {/* Hard error overlay — only for genuinely unsupported browsers. */}
        {errorMsg && (
          <div className="absolute inset-0 bg-slate-950/90 flex flex-col items-center justify-center p-6 text-center z-30">
            <AlertTriangle className="w-12 h-12 text-red-500 mb-2" />
            <h3 className="text-base font-bold text-white mb-1">Stream Unavailable</h3>
            <p className="text-xs text-slate-400 max-w-md mb-4">{errorMsg}</p>
            <div className="flex gap-2">
              <button
                onClick={() => createAndLoad(streamsRef.current[indexRef.current]?.url || "")}
                className="px-4 py-2 bg-[#00c978] hover:bg-[#00db84] text-slate-950 rounded-xl text-xs font-bold transition-colors shadow-lg"
              >
                Retry Link
              </button>
            </div>
          </div>
        )}

        {/* Status bar */}
        <div
          className={`absolute top-0 inset-x-0 z-40 transition-all duration-300 ease-out ${
            topBarActive ? "translate-y-0 opacity-100" : "-translate-y-full opacity-0"
          }`}
        >
          <div className="relative flex items-center gap-2.5 px-4 sm:px-5 py-2.5 border-b overflow-hidden bg-gradient-to-b from-emerald-950/80 via-slate-950/90 to-slate-950/60 border-emerald-500/30">
            <RefreshCw className="w-4 h-4 shrink-0 animate-spin text-emerald-400" />
            <span className="text-xs sm:text-[13px] font-semibold text-slate-100 tracking-wide truncate">
              {topBarText}
            </span>
            <div className="absolute bottom-0 inset-x-0 h-[2px] bg-white/5 overflow-hidden">
              <div
                className={`h-full w-1/3 rounded-full bg-emerald-400 ${
                  topBarActive ? "animate-[solu-ts-sweep_1.4s_ease-in-out_infinite]" : ""
                }`}
              />
            </div>
          </div>
        </div>
        <style>{`
          @keyframes solu-ts-sweep {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(400%); }
          }
        `}</style>

        {/* Title bar */}
        <div
          className={`absolute top-0 inset-x-0 p-2.5 sm:p-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent transition-opacity duration-300 flex items-center justify-between gap-2 z-10 ${
            controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-xs sm:text-sm font-bold text-white tracking-tight truncate">
              {displayedChannelName}
            </h2>
          </div>
          <span className="px-2 py-1 rounded-full text-[9px] sm:text-[10px] font-bold bg-slate-900/80 text-sky-300 border border-sky-500/30">
            LIVE • TS
          </span>
        </div>

        {/* Bottom controls */}
        <div
          className={`absolute bottom-0 inset-x-0 p-2.5 sm:p-4 bg-gradient-to-t from-black/90 via-black/50 to-transparent transition-opacity duration-300 flex items-center justify-between gap-3 sm:gap-4 z-10 ${
            controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
            >
              {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
            </button>
            <div className="flex items-center gap-2">
              <button onClick={toggleMute} className="text-slate-300 hover:text-white transition-colors">
                {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="w-16 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
              />
            </div>
          </div>
          <div className="flex items-center gap-2.5 sm:gap-3">
            <span className="hidden lg:inline text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              Server {displayedIndex + 1}
            </span>
            <button onClick={toggleFullscreen} className="text-slate-300 hover:text-white transition-colors">
              <Maximize className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Server selector (desktop) */}
      {mirrors.length > 1 && (
        <div className="hidden lg:flex flex-wrap items-center gap-2 pt-0.5">
          {mirrors.map((st, idx) => {
            const isSelected = idx === displayedIndex;
            return (
              <button
                key={st._id}
                onClick={() => handleManualServerSelect(idx)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  isSelected
                    ? "bg-[#00c978] text-slate-950 shadow-md shadow-emerald-500/20 ring-1 ring-emerald-400/50"
                    : "bg-[#0d1628] text-slate-300 hover:text-white hover:bg-slate-800/80 border border-slate-800"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${isSelected ? "bg-slate-950" : "bg-emerald-400"}`} />
                <span>Server {idx + 1}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
