"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  AlertTriangle,
  RefreshCw,
  ShieldCheck,
  Zap,
  Gauge,
  Check,
} from "lucide-react";

export interface StreamMirror {
  _id: string;
  url: string;
  priority: number;
  status: "active" | "degraded" | "broken";
  latency: number;
}

/* ------------------------------------------------------------------
   Network-aware adaptive streaming helpers
   ------------------------------------------------------------------ */

interface NetworkInfo {
  /** Estimated downlink bandwidth in bits per second */
  bandwidth: number;
  /** Max video height we allow on this connection (px) */
  maxHeight: number;
  /** Human label e.g. "4G" */
  label: string;
  /** User asked the browser to save data */
  saveData: boolean;
}

type NavigatorConnection = {
  downlink?: number; // Mbps
  effectiveType?: "slow-2g" | "2g" | "3g" | "4g";
  saveData?: boolean;
  addEventListener?: (type: string, cb: () => void) => void;
  removeEventListener?: (type: string, cb: () => void) => void;
};

function getConnection(): NavigatorConnection | undefined {
  if (typeof navigator === "undefined") return undefined;
  const nav = navigator as Navigator & {
    connection?: NavigatorConnection;
    mozConnection?: NavigatorConnection;
    webkitConnection?: NavigatorConnection;
  };
  return nav.connection || nav.mozConnection || nav.webkitConnection;
}

/** Reads the live connection and maps it to a safe bandwidth + resolution ceiling. */
function readNetworkInfo(): NetworkInfo {
  const conn = getConnection();
  const saveData = Boolean(conn?.saveData);
  const effectiveType = conn?.effectiveType;
  // navigator.connection.downlink is in Mbps. Use 80% of it as a safety margin.
  const downlinkMbps = typeof conn?.downlink === "number" && conn.downlink > 0 ? conn.downlink : 0;

  let bandwidth = downlinkMbps > 0 ? downlinkMbps * 1_000_000 * 0.8 : 0;
  let maxHeight = 1080;
  let label = "AUTO";

  switch (effectiveType) {
    case "slow-2g":
      bandwidth = bandwidth || 150_000;
      maxHeight = 240;
      label = "2G";
      break;
    case "2g":
      bandwidth = bandwidth || 350_000;
      maxHeight = 360;
      label = "2G";
      break;
    case "3g":
      bandwidth = bandwidth || 1_200_000;
      maxHeight = 480;
      label = "3G";
      break;
    case "4g":
      bandwidth = bandwidth || 5_000_000;
      maxHeight = downlinkMbps > 0 && downlinkMbps < 2 ? 480 : 1080;
      label = "4G";
      break;
    default:
      // Unknown (Safari / Firefox): assume a decent connection, let ABR measure it.
      bandwidth = bandwidth || 2_500_000;
      maxHeight = 1080;
      label = "AUTO";
  }

  if (saveData) {
    maxHeight = Math.min(maxHeight, 360);
    bandwidth = Math.min(bandwidth, 600_000);
    label = "SAVER";
  }

  return { bandwidth, maxHeight, label, saveData };
}

interface HlsPlayerProps {
  channelName: string;
  streams: StreamMirror[];
  /** Optional controlled active stream index (e.g. driven by an external server switcher). */
  currentStreamIndex?: number;
  /** Called whenever the player switches (manually or via auto-failover) to a different stream index. */
  onStreamIndexChange?: (index: number) => void;
  /**
   * Fired once every server link for this channel has been tried and failed.
   * The Bangla banner has already been shown for `EXHAUSTED_HOLD_MS` by the
   * time this runs — the host page is expected to hide the channel and move to
   * the next one in the playlist.
   */
  onAllServersFailed?: () => void;
  /** Fired the moment a link fails, so the host can report/refresh state early. */
  onStreamFailed?: (streamId: string) => void;
}

/* ------------------------------------------------------------------ *
 * Resilience ladder timings (see `handleStreamFailure`)
 * ------------------------------------------------------------------ */

/** Step 1 — instant in-place retry of the SAME link. */
const INSTANT_RETRY_MS = 1000;
/** Step 2 — cool-off before moving to the next server link. */
const SERVER_SWITCH_MS = 5000;
/** Step 3 — how long the Bangla banner shows before auto-advancing channels. */
const EXHAUSTED_HOLD_MS = 5000;
/** A link must play this long uninterrupted before it counts as healthy. */
const STABLE_PLAYBACK_MS = 8000;
/** Buffering longer than this counts as a failure. */
const STALL_TIMEOUT_MS = 5000;

/** Overlay text shown when every server for a channel is down. */
const ALL_SERVERS_DOWN_BN =
  "দুঃখিত! এই মুহূর্তে চ্যানেলটির সম্প্রচার সম্ভব হচ্ছে না। আমরা দ্রুত সমস্যাটি সমাধানের চেষ্টা করছি। ততক্ষণ অনুগ্রহ করে অন্য যেকোনো চ্যানেল উপভোগ করুন।";

export default function HlsPlayer({
  channelName,
  streams,
  currentStreamIndex: controlledStreamIndex,
  onStreamIndexChange,
  onAllServersFailed,
  onStreamFailed,
}: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);

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

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1.0);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [failoverToast, setFailoverToast] = useState<string | null>(null);

  // ---- Adaptive quality state ----
  const [levels, setLevels] = useState<{ index: number; height: number; bitrate: number }[]>([]);
  /** -1 = AUTO (network adaptive), otherwise a manually pinned level index */
  const [selectedLevel, setSelectedLevel] = useState(-1);
  const [activeLevelHeight, setActiveLevelHeight] = useState<number | null>(null);
  const [netLabel, setNetLabel] = useState("AUTO");
  const [showQualityMenu, setShowQualityMenu] = useState(false);

  // ---- Auto-hiding overlay controls ----
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);

  // ---- Resilience ladder state ----
  /** idle → retrying (1s) → switching (5s) → exhausted (all servers dead) */
  const [recoveryPhase, setRecoveryPhase] = useState<
    "idle" | "retrying" | "switching" | "exhausted"
  >("idle");

  const stallTimerRef = useRef<NodeJS.Timeout | null>(null);
  const recoveryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const stableTimerRef = useRef<NodeJS.Timeout | null>(null);

  /** Server indexes already proven dead for this channel. */
  const deadServersRef = useRef<Set<number>>(new Set());
  /** Whether the instant 1s retry has been spent on the current server. */
  const retriedCurrentRef = useRef(false);
  /** Guards against two failure handlers firing for the same breakage. */
  const recoveringRef = useRef(false);
  /** Latest values for use inside timers without re-creating them. */
  const currentIndexRef = useRef(currentStreamIndex);
  currentIndexRef.current = currentStreamIndex;

  /** Late-bound reference to `loadStream`, which is declared further down. */
  const loadStreamRef = useRef<((url: string) => void) | null>(null);

  /** Latest volume/mute so `loadStream` can apply them without needing to be
   *  recreated (and thus re-triggering a reload) every time they change. */
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  /** True once the very first stream (of this player's lifetime) has loaded —
   *  only then do we apply the user's own volume/mute choice on every
   *  subsequent channel switch instead of the initial sensible defaults. */
  const hasLoadedOnceRef = useRef(false);

  const activeStream = streams[currentStreamIndex] || null;

  // Clear 5-second stall timer helper
  const clearStallTimer = () => {
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  };

  const clearRecoveryTimers = () => {
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    if (stableTimerRef.current) {
      clearTimeout(stableTimerRef.current);
      stableTimerRef.current = null;
    }
  };

  // A fresh channel means a fresh set of servers to try. (Volume/mute are
  // deliberately NOT reset here — they should carry over like a real remote,
  // now that the player survives a channel switch instead of remounting.)
  useEffect(() => {
    deadServersRef.current = new Set();
    retriedCurrentRef.current = false;
    recoveringRef.current = false;
    setRecoveryPhase("idle");
    setFailoverToast(null);
    setShowQualityMenu(false);
    return () => {
      clearStallTimer();
      clearRecoveryTimers();
    };
  }, [streams]);

  /** Tells the backend a link is down so it can be hidden from the catalogue. */
  const reportBrokenStream = useCallback(
    (streamId?: string) => {
      if (!streamId) return;
      onStreamFailed?.(streamId);
      fetch("/api/streams/report-broken", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamId }),
      }).catch(console.error);
    },
    [onStreamFailed]
  );

  /** Reloads the CURRENT link in place — step 1 of the ladder. */
  const reloadCurrentStream = useCallback(() => {
    const url = streams[currentIndexRef.current]?.url;
    if (url) loadStreamRef.current?.(url);
  }, [streams]);

  /**
   * Moves to the next link that hasn't already proven dead — step 2. Returns
   * false when every server has been exhausted.
   */
  const advanceToNextServer = useCallback((): boolean => {
    const total = streams.length;
    for (let offset = 1; offset <= total; offset++) {
      const candidate = (currentIndexRef.current + offset) % total;
      if (!deadServersRef.current.has(candidate)) {
        console.warn(`[Resilience] Switching to Server ${candidate + 1}`);
        retriedCurrentRef.current = false;
        recoveringRef.current = false;
        setRecoveryPhase("idle");
        setFailoverToast(`Switching to Server ${candidate + 1}...`);
        setTimeout(() => setFailoverToast(null), 4000);
        setCurrentStreamIndex(candidate);
        return true;
      }
    }
    return false;
  }, [streams, setCurrentStreamIndex]);

  /**
   * The resilience ladder. Every playback breakage funnels through here:
   *
   *   1. INSTANT RETRY  — reload the same link after 1s (covers transient CDN
   *                       hiccups, token refreshes and brief network drops).
   *   2. SERVER SWITCH  — if the retry also fails, mark the link dead, wait 5s,
   *                       then move to the next untried server. Playback stays
   *                       on that server for good once it starts playing.
   *   3. EXHAUSTED      — when no server is left, show the Bangla banner, hold
   *                       it for 5s, then hand control back so the page can hide
   *                       the channel and advance to the next one.
   */
  const handleStreamFailure = useCallback(
    (reason: string) => {
      if (recoveringRef.current) return; // a recovery is already in flight
      recoveringRef.current = true;

      clearStallTimer();
      clearRecoveryTimers();

      const index = currentIndexRef.current;
      console.warn(`[Resilience] Server ${index + 1} failed: ${reason}`);

      // ---- Step 1: instant retry of the same link ----
      if (!retriedCurrentRef.current) {
        retriedCurrentRef.current = true;
        setRecoveryPhase("retrying");
        setFailoverToast("Connection lost. Reconnecting...");
        setIsLoading(true);

        recoveryTimerRef.current = setTimeout(() => {
          recoveringRef.current = false;
          setFailoverToast(null);
          reloadCurrentStream();
        }, INSTANT_RETRY_MS);
        return;
      }

      // ---- The retry failed too: this server is dead ----
      deadServersRef.current.add(index);
      reportBrokenStream(streams[index]?._id);

      const hasUntriedServer = streams.some((_, i) => !deadServersRef.current.has(i));

      if (hasUntriedServer) {
        // ---- Step 2: cool off, then switch servers ----
        setRecoveryPhase("switching");
        setFailoverToast(`Server ${index + 1} is down. Trying the next server...`);
        setIsLoading(true);

        recoveryTimerRef.current = setTimeout(() => {
          if (!advanceToNextServer()) {
            setRecoveryPhase("exhausted");
          }
        }, SERVER_SWITCH_MS);
        return;
      }

      // ---- Step 3: every server is dead ----
      setRecoveryPhase("exhausted");
      setFailoverToast(null);
      setIsLoading(false);
    },
    [streams, reloadCurrentStream, advanceToNextServer, reportBrokenStream]
  );

  /**
   * Once all servers are exhausted, hold the Bangla banner for 5 seconds and
   * then let the host page hide this channel and move to the next one.
   */
  useEffect(() => {
    if (recoveryPhase !== "exhausted") return;

    const timer = setTimeout(() => {
      onAllServersFailed?.();
    }, EXHAUSTED_HOLD_MS);

    return () => clearTimeout(timer);
  }, [recoveryPhase, onAllServersFailed]);

  /**
   * Caps the highest quality ABR is allowed to pick, based on the *current*
   * connection. Runs on manifest load and again whenever the network changes
   * (e.g. Wi-Fi -> mobile data), so playback stays smooth instead of stalling.
   */
  const applyNetworkCap = useCallback((hls: Hls) => {
    const net = readNetworkInfo();
    setNetLabel(net.label);

    if (!hls.levels || hls.levels.length === 0) return;

    // Highest level whose height fits under the ceiling for this connection.
    let cap = -1; // -1 = no cap, allow everything
    if (net.maxHeight < 1080) {
      let best = -1;
      hls.levels.forEach((l, i) => {
        const h = l.height || 0;
        if (h <= net.maxHeight && (best === -1 || h > (hls.levels[best].height || 0))) {
          best = i;
        }
      });
      // If every rendition is above the ceiling, fall back to the smallest one.
      if (best === -1) {
        best = hls.levels.reduce(
          (lowest, l, i) => ((l.height || 0) < (hls.levels[lowest].height || 0) ? i : lowest),
          0
        );
      }
      cap = best;
    }

    hls.autoLevelCapping = cap;
    // Re-seed the bandwidth estimate so ABR reacts immediately instead of
    // waiting for several segments to re-measure. (Setter is a no-op on
    // older hls.js builds, so keep it defensive.)
    try {
      hls.bandwidthEstimate = net.bandwidth;
    } catch {
      /* ignore */
    }
  }, []);

  // Re-evaluate the quality ceiling whenever the connection type changes
  useEffect(() => {
    const conn = getConnection();
    if (!conn?.addEventListener) return;

    const onChange = () => {
      const hls = hlsRef.current;
      if (hls && selectedLevel === -1) applyNetworkCap(hls);
      else setNetLabel(readNetworkInfo().label);
    };

    conn.addEventListener("change", onChange);
    return () => conn.removeEventListener?.("change", onChange);
  }, [applyNetworkCap, selectedLevel]);

  /** Manual quality override from the picker. -1 puts it back on AUTO. */
  const handleSelectQuality = (levelIndex: number) => {
    const hls = hlsRef.current;
    setSelectedLevel(levelIndex);
    setShowQualityMenu(false);
    if (!hls) return;

    if (levelIndex === -1) {
      hls.currentLevel = -1;
      applyNetworkCap(hls);
    } else {
      hls.autoLevelCapping = -1;
      hls.currentLevel = levelIndex;
      setActiveLevelHeight(hls.levels[levelIndex]?.height || null);
    }
  };

  // Initialize HLS.js or native HTML5 video player
  const loadStream = useCallback(
    (streamUrl: string) => {
      clearStallTimer();
      setIsLoading(true);
      setErrorMsg(null);

      const video = videoRef.current;
      if (!video) return;

      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      if (Hls.isSupported()) {
        // Seed the ABR controller with what the browser knows about the
        // current connection so the very first segment is already the right size.
        const net = readNetworkInfo();
        setNetLabel(net.label);
        const isSlow = net.bandwidth < 1_500_000;

        const hls = new Hls({
          enableWorker: true,
          // Low-latency mode keeps the buffer tiny, which is great on fast Wi-Fi
          // but causes constant stalls on mobile data. Enable it only when fast.
          lowLatencyMode: !isSlow,

          // ---- Adaptive bitrate (auto resolution by network speed) ----
          startLevel: -1, // let ABR pick the opening quality
          capLevelToPlayerSize: true, // never download more pixels than the <video> shows
          capLevelOnFPSDrop: true, // step down if the device can't decode smoothly
          abrEwmaDefaultEstimate: net.bandwidth, // seed with the real connection speed
          abrEwmaFastVoD: 2.0,
          abrEwmaSlowVoD: 8.0,
          abrEwmaFastLive: 2.0,
          abrEwmaSlowLive: 6.0,
          abrBandWidthFactor: 0.9, // only use 90% of measured bandwidth
          abrBandWidthUpFactor: 0.65, // be conservative before upgrading quality
          abrMaxWithRealBitrate: true,

          // ---- Buffer strategy: bigger cushion on slow links ----
          maxBufferLength: isSlow ? 45 : 20,
          maxMaxBufferLength: isSlow ? 90 : 60,
          backBufferLength: 30,
          maxBufferHole: 0.5,
          highBufferWatchdogPeriod: 2,
          nudgeMaxRetry: 6,
          // Start fetching the next fragment before the current one finishes
          // decoding, so a fragment boundary doesn't cause a visible micro-stall.
          startFragPrefetch: true,

          // ---- Loader timeouts / retries ----
          manifestLoadingTimeOut: 10000,
          manifestLoadingMaxRetry: 3,
          levelLoadingTimeOut: 10000,
          levelLoadingMaxRetry: 4,
          fragLoadingTimeOut: isSlow ? 30000 : 20000,
          fragLoadingMaxRetry: 6,
        });

        hlsRef.current = hls;
        hls.loadSource(streamUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // Build the quality ladder for the manual picker
          const parsed = hls.levels.map((l, i) => ({
            index: i,
            height: l.height || Math.round((l.bitrate || 0) / 3000),
            bitrate: l.bitrate || 0,
          }));
          setLevels(parsed);
          setSelectedLevel(-1);
          hls.currentLevel = -1; // AUTO
          applyNetworkCap(hls);

          setIsLoading(false);
          // First-ever load on this player: start unmuted at full volume.
          // Every subsequent channel switch keeps whatever the user last set,
          // instead of snapping back to defaults like a fresh remote battery.
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
          video
            .play()
            .then(() => setIsPlaying(true))
            .catch((err) => {
              console.warn("[Autoplay warning]", err);
            });
        });

        // Keep the on-screen quality badge in sync with what ABR picked
        hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
          const lvl = hls.levels[data.level];
          if (lvl) setActiveLevelHeight(lvl.height || null);
        });

        // 5-second Smart Auto-Failover on Network/Media Error
        hls.on(Hls.Events.ERROR, (_event, data) => {
          console.warn("[HLS Event Error]:", data.type, data.details);
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                handleStreamFailure("network error / link offline");
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                hls.recoverMediaError();
                break;
              default:
                handleStreamFailure("fatal video playback error");
                break;
            }
          }
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Native Safari HLS support
        video.src = streamUrl;
        video.play().then(() => setIsPlaying(true));
      } else {
        setErrorMsg("HLS streaming is not supported in your browser.");
        setIsLoading(false);
      }
    },
    [handleStreamFailure, applyNetworkCap]
  );

  // Publish loadStream so the resilience ladder (declared above it) can reload
  // the current link without a circular dependency between the two callbacks.
  loadStreamRef.current = loadStream;

  useEffect(() => {
    if (activeStream?.url) {
      loadStream(activeStream.url);
    }

    return () => {
      clearStallTimer();
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [activeStream, loadStream]);

  /**
   * Buffering longer than STALL_TIMEOUT_MS is treated as a failure and enters
   * the resilience ladder (instant retry first, server switch second).
   */
  const handleWaiting = () => {
    if (recoveryPhase === "exhausted") return;
    setIsLoading(true);
    clearStallTimer();

    stallTimerRef.current = setTimeout(() => {
      handleStreamFailure("stalled/buffering for > 5s");
    }, STALL_TIMEOUT_MS);
  };

  /**
   * Playback resumed. The ladder is only fully reset once the link has run
   * uninterrupted for STABLE_PLAYBACK_MS — that is what makes the player
   * "stay on the new server once playing" instead of drifting back.
   */
  const handlePlaying = () => {
    setIsLoading(false);
    setIsPlaying(true);
    clearStallTimer();
    clearRecoveryTimers();
    recoveringRef.current = false;
    setFailoverToast(null);
    if (recoveryPhase !== "idle") setRecoveryPhase("idle");

    stableTimerRef.current = setTimeout(() => {
      // Proven healthy: give this server a fresh instant-retry allowance and
      // forget it was ever marked dead.
      retriedCurrentRef.current = false;
      deadServersRef.current.delete(currentIndexRef.current);
    }, STABLE_PLAYBACK_MS);
  };

  const handlePause = () => {
    setIsPlaying(false);
    clearStallTimer();
  };

  /** Starts the 3s countdown after which the overlay controls fade out. */
  const scheduleControlsHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);

  /** Shows the controls and restarts the auto-hide countdown. */
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide]);

  // Controls stay pinned while paused / loading / errored / quality menu open,
  // and fade away on their own once playback is actually running.
  useEffect(() => {
    const shouldPin = !isPlaying || isLoading || Boolean(errorMsg) || showQualityMenu;

    if (shouldPin) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setControlsVisible(true);
      return;
    }

    scheduleControlsHide();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [isPlaying, isLoading, errorMsg, showQualityMenu, scheduleControlsHide]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
    } else {
      video.play().catch(console.error);
    }
  };

  /**
   * First tap on a playing video just brings the controls back (standard
   * mobile player behaviour); a tap while they are already visible plays/pauses.
   */
  const handleVideoClick = () => {
    if (!controlsVisible) {
      revealControls();
      return;
    }
    togglePlay();
    revealControls();
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
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = val === 0;
      setIsMuted(val === 0);
    }
  };

  const toggleFullscreen = () => {
    // Fullscreen the whole frame (not just the <video>) so the custom
    // controls and quality picker stay usable on mobile.
    const target = containerRef.current || videoRef.current;
    const video = videoRef.current as (HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
    }) | null;
    if (!target) return;

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(console.error);
      return;
    }

    if (target.requestFullscreen) {
      target.requestFullscreen().catch(() => {
        // iOS Safari only allows fullscreen on the video element itself
        video?.webkitEnterFullscreen?.();
      });
    } else {
      video?.webkitEnterFullscreen?.();
    }
  };

  return (
    <div className="w-full space-y-3">
      {/* Video Container Frame */}
      <div
        ref={containerRef}
        className="relative aspect-video w-full mx-auto max-w-[calc(52dvh*16/9)] lg:max-w-none rounded-2xl bg-black overflow-hidden border border-slate-800 shadow-2xl group"
        onMouseMove={revealControls}
        onMouseLeave={() => {
          if (isPlaying && !isLoading && !errorMsg && !showQualityMenu) setControlsVisible(false);
        }}
        onTouchStart={revealControls}
      >
        <video
          ref={videoRef}
          className="w-full h-full object-contain cursor-pointer"
          onClick={handleVideoClick}
          onWaiting={handleWaiting}
          onPlaying={handlePlaying}
          onPause={handlePause}
          onError={() => handleStreamFailure("media stream error")}
          playsInline
        />

        {/* Loading Overlay */}
        {isLoading && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center gap-3 z-20">
            <RefreshCw className="w-10 h-10 text-emerald-400 animate-spin" />
            <span className="text-xs font-bold text-slate-200 tracking-wide uppercase">
              Connecting to Live Stream...
            </span>
          </div>
        )}

        {/* Error Overlay */}
        {errorMsg && recoveryPhase !== "exhausted" && (
          <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center z-30">
            <AlertTriangle className="w-12 h-12 text-red-500 mb-2" />
            <h3 className="text-base font-bold text-white mb-1">Stream Unavailable</h3>
            <p className="text-xs text-slate-400 max-w-md mb-4">{errorMsg}</p>
            <div className="flex gap-2">
              <button
                onClick={() => activeStream && loadStream(activeStream.url)}
                className="px-4 py-2 bg-[#00c978] hover:bg-[#00db84] text-slate-950 rounded-xl text-xs font-bold transition-colors shadow-lg"
              >
                Retry Link
              </button>
              {streams.length > 1 && (
                <button
                  onClick={() => {
                    retriedCurrentRef.current = true;
                    recoveringRef.current = false;
                    handleStreamFailure("manual switch");
                  }}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-bold transition-colors border border-slate-700"
                >
                  Switch to Next Server
                </button>
              )}
            </div>
          </div>
        )}

        {/* ===== All servers down: Bangla notice, then auto-advance ===== */}
        {recoveryPhase === "exhausted" && (
          <div className="absolute inset-0 bg-slate-950/95 backdrop-blur-md flex flex-col items-center justify-center p-5 sm:p-8 text-center z-40">
            <AlertTriangle className="w-9 h-9 sm:w-11 sm:h-11 text-amber-400 mb-3" />
            <p
              lang="bn"
              className="text-[13px] sm:text-base font-bold text-white leading-relaxed max-w-lg"
            >
              {ALL_SERVERS_DOWN_BN}
            </p>
            <div className="mt-4 flex items-center gap-2 text-[11px] sm:text-xs font-bold text-emerald-400">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>পরবর্তী চ্যানেলে যাওয়া হচ্ছে...</span>
            </div>
            {/* 5-second progress bar mirroring EXHAUSTED_HOLD_MS */}
            <div className="mt-3 h-1 w-40 rounded-full bg-slate-800 overflow-hidden">
              <div className="h-full bg-emerald-500 animate-[shrink_5s_linear_forwards]" />
            </div>
          </div>
        )}

        {/* Auto-Failover Toast Overlay Notification */}
        {failoverToast && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 bg-slate-900/95 text-white text-xs font-bold px-4 py-2 rounded-xl shadow-2xl flex items-center gap-2 border border-emerald-500/40 animate-bounce">
            {recoveryPhase === "retrying" ? (
              <RefreshCw className="w-4 h-4 text-emerald-400 animate-spin" />
            ) : (
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
            )}
            <span>{failoverToast}</span>
          </div>
        )}

        {/* Top Channel Title Bar Overlay */}
        <div
          className={`absolute top-0 inset-x-0 p-2.5 sm:p-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent transition-opacity duration-300 flex items-center justify-between gap-2 z-10 ${
            controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-xs sm:text-sm font-bold text-white tracking-tight truncate">
              {channelName}
            </h2>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Live adaptive quality badge */}
            <span className="px-2 py-1 rounded-full text-[9px] sm:text-[10px] font-bold bg-slate-900/80 text-sky-300 border border-sky-500/30">
              <Gauge className="w-2.5 h-2.5 inline mr-1" />
              {selectedLevel === -1 ? netLabel : "MANUAL"}
              {activeLevelHeight ? ` • ${activeLevelHeight}p` : ""}
            </span>
            <span className="hidden sm:inline px-2.5 py-1 rounded-full text-[10px] font-bold bg-slate-900/80 text-emerald-400 border border-emerald-500/30">
              <Zap className="w-2.5 h-2.5 inline mr-1" />
              Server {currentStreamIndex + 1} ({activeStream?.latency || 120}ms)
            </span>
          </div>
        </div>

        {/* Bottom Custom Player Controls Overlay */}
        <div
          className={`absolute bottom-0 inset-x-0 p-2.5 sm:p-4 bg-gradient-to-t from-black/90 via-black/50 to-transparent transition-opacity duration-300 flex items-center justify-between gap-3 sm:gap-4 z-10 ${
            controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors backdrop-blur-sm"
            >
              {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
            </button>

            <div className="flex items-center gap-2">
              <button
                onClick={toggleMute}
                className="text-slate-300 hover:text-white transition-colors"
              >
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
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest hidden lg:inline">
              Smart Auto-Failover
            </span>

            {/* Quality picker (AUTO = adapts to network speed) */}
            {levels.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowQualityMenu((v) => !v)}
                  className="px-2 py-1 rounded-lg text-[10px] font-black text-slate-200 bg-white/10 hover:bg-white/20 border border-white/10 transition-colors"
                >
                  {selectedLevel === -1
                    ? `AUTO${activeLevelHeight ? ` ${activeLevelHeight}p` : ""}`
                    : `${levels[selectedLevel]?.height || "?"}p`}
                </button>

                {showQualityMenu && (
                  <div className="absolute bottom-full right-0 mb-2 w-36 rounded-xl bg-slate-950/95 backdrop-blur-md border border-slate-700 shadow-2xl overflow-hidden z-50">
                    <button
                      onClick={() => handleSelectQuality(-1)}
                      className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-bold text-slate-200 hover:bg-slate-800 transition-colors"
                    >
                      <span>Auto (network)</span>
                      {selectedLevel === -1 && <Check className="w-3 h-3 text-emerald-400" />}
                    </button>
                    <div className="max-h-44 overflow-y-auto scrollbar-thin">
                      {[...levels]
                        .sort((a, b) => b.height - a.height)
                        .map((l) => (
                          <button
                            key={l.index}
                            onClick={() => handleSelectQuality(l.index)}
                            className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-bold text-slate-300 hover:bg-slate-800 transition-colors border-t border-slate-800/70"
                          >
                            <span>{l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)}k`}</span>
                            {selectedLevel === l.index && (
                              <Check className="w-3 h-3 text-emerald-400" />
                            )}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={toggleFullscreen}
              className="text-slate-300 hover:text-white transition-colors"
            >
              <Maximize className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Minimal Server Link Selector Tags Directly Below Player (hidden on mobile; shown next to the back button instead) */}
      {streams.length > 0 && (
        <div className="hidden lg:flex flex-wrap items-center gap-2 pt-0.5">
          {streams.map((st, idx) => {
            const isSelected = idx === currentStreamIndex;
            return (
              <button
                key={st._id}
                onClick={() => setCurrentStreamIndex(idx)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  isSelected
                    ? "bg-[#00c978] text-slate-950 shadow-md shadow-emerald-500/20 ring-1 ring-emerald-400/50"
                    : "bg-[#0d1628] text-slate-300 hover:text-white hover:bg-slate-800/80 border border-slate-800"
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
  );
}
