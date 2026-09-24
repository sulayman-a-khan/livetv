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

/** Which of the two ping-ponged <video>/Hls instances is doing what. */
type Slot = "A" | "B";

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
  /**
   * Fired when a requested channel switch could not be completed — every
   * stream link for the target channel failed to preload, so the player is
   * staying on whatever was already on screen. Lets the host page (sidebar
   * highlight, URL, channel info panel) roll back in sync with what the
   * player actually did instead of what it was asked to do.
   */
  onSwitchFailed?: (attemptedLabel: string) => void;
  /**
   * Fired whenever the background "tuning into the next channel" state
   * changes, with the channel label being tuned into (or null once settled).
   * Lets the host page reflect this outside the player itself — e.g. a
   * "CONNECTING" badge in a channel list instead of "PLAYING" until the
   * swap actually completes.
   */
  onSwitchingChange?: (switching: boolean, label: string | null) => void;
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
/** How long we give ONE mirror to start playing in the background before trying the next mirror for the channel we're tuning into. */
const PRELOAD_MIRROR_TIMEOUT_MS = 8000;

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
  onSwitchingChange,
  onSwitchFailed,
}: HlsPlayerProps) {
  /* ------------------------------------------------------------------
   * Dual-buffer playback: two <video>/Hls.js instances are ping-ponged.
   * Whichever one is "front" is the one on screen and driving all of the
   * controls / resilience-ladder state below. Switching channels loads the
   * new stream into the hidden "back" instance; only once it is actually
   * playing do we flip which one is on top — so the channel that's already
   * playing never stops, and there is no black frame / spinner gap.
   * ------------------------------------------------------------------ */
  const videoRefA = useRef<HTMLVideoElement>(null);
  const videoRefB = useRef<HTMLVideoElement>(null);
  const hlsRefA = useRef<Hls | null>(null);
  const hlsRefB = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // ---- Player chrome state (always describes whichever slot is FRONT) ----
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1.0);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [failoverToast, setFailoverToast] = useState<string | null>(null);

  // ---- Adaptive quality state (front slot only) ----
  const [levels, setLevels] = useState<{ index: number; height: number; bitrate: number }[]>([]);
  /** -1 = AUTO (network adaptive), otherwise a manually pinned level index */
  const [selectedLevel, setSelectedLevel] = useState(-1);
  const [activeLevelHeight, setActiveLevelHeight] = useState<number | null>(null);
  const [netLabel, setNetLabel] = useState("AUTO");
  const [showQualityMenu, setShowQualityMenu] = useState(false);

  // ---- Auto-hiding overlay controls ----
  const [controlsVisible, setControlsVisible] = useState(false);
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);

  // ---- Resilience ladder state (front slot only) ----
  /** idle → retrying (1s) → switching (5s) → exhausted (all servers dead) */
  const [recoveryPhase, setRecoveryPhase] = useState<
    "idle" | "retrying" | "switching" | "exhausted"
  >("idle");
  const stallTimerRef = useRef<NodeJS.Timeout | null>(null);
  const recoveryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const stableTimerRef = useRef<NodeJS.Timeout | null>(null);

  /** Server indexes (within `displayedMirrors`) already proven dead for the on-screen channel. */
  const deadServersRef = useRef<Set<number>>(new Set());
  /** Whether the instant 1s retry has been spent on the current server. */
  const retriedCurrentRef = useRef(false);
  /** Guards against two failure handlers firing for the same breakage. */
  const recoveringRef = useRef(false);

  /** Latest volume/mute so loaders can apply them without needing to be
   *  recreated (and thus re-triggering a reload) every time they change. */
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  /** True once the very first stream (of this player's lifetime) has loaded —
   *  only then do we apply the user's own volume/mute choice on every
   *  subsequent channel switch instead of the initial sensible defaults. */
  const hasLoadedOnceRef = useRef(false);

  // ---- Which slot is on screen right now, and what it's actually playing ----
  const [frontSlot, setFrontSlot] = useState<Slot>("A");
  const frontSlotRef = useRef<Slot>("A");
  const [displayedMirrors, setDisplayedMirrors] = useState<StreamMirror[]>([]);
  const displayedMirrorsRef = useRef<StreamMirror[]>([]);
  const [displayedIndex, setDisplayedIndex] = useState(0);
  const displayedIndexRef = useRef(0);
  /** Name of the channel actually on screen right now — only updated once a
   *  switch really commits, so the title overlay never jumps ahead to a
   *  channel that hasn't (or won't) actually start playing. */
  const [displayedChannelName, setDisplayedChannelName] = useState(channelName);
  /** The mirror _id currently applied to the front slot — the single source of
   *  truth used to decide whether an incoming `streams`/`currentStreamIndex`
   *  change is a real switch or just a redundant re-render. */
  const lastAppliedStreamIdRef = useRef<string | null>(null);
  const frontEverLoadedRef = useRef(false);
  const activeDisplayedStream = displayedMirrors[displayedIndex] || null;

  // ---- Background "tuning into the next channel" state ----
  const [switching, setSwitching] = useState(false);
  const [pendingChannelLabel, setPendingChannelLabel] = useState<string | null>(null);
  const [switchFailedMsg, setSwitchFailedMsg] = useState<string | null>(null);
  const switchGenerationRef = useRef(0);
  const pendingStreamsRef = useRef<StreamMirror[]>([]);
  const pendingChannelNameRef = useRef<string>("");
  const pendingMirrorOrderRef = useRef<StreamMirror[]>([]);
  const preloadAttemptIndexRef = useRef(0);
  const preloadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const switchFailTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // ---- Fullscreen state ----
  const [isFullscreen, setIsFullscreen] = useState(false);
  /**
   * CSS-driven fullscreen used when the browser Fullscreen API is unavailable
   * or refuses (notably iOS Safari, which only allows the raw <video> to go
   * fullscreen). The container is pinned to the viewport with fixed positioning
   * so a full-screen view still works everywhere.
   */
  const [cssFullscreen, setCssFullscreen] = useState(false);
  const fsGuardPushedRef = useRef(false);

  /** Late-bound refs so functions declared earlier can call ones declared
   *  later without circular useCallback dependencies (same pattern the
   *  resilience ladder already relies on). */
  const loadIntoSlotRef = useRef<
    ((slot: Slot, url: string, opts: { front: boolean; generation?: number }) => void) | null
  >(null);
  const attemptPreloadRef = useRef<((generation: number) => void) | null>(null);
  const commitSwapRef = useRef<((slot: Slot) => void) | null>(null);
  const failPreloadAttemptRef = useRef<((slot: Slot) => void) | null>(null);

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

  const getVideoEl = useCallback(
    (slot: Slot) => (slot === "A" ? videoRefA.current : videoRefB.current),
    []
  );
  const getHlsRefObj = useCallback((slot: Slot) => (slot === "A" ? hlsRefA : hlsRefB), []);

  /** Tears down whatever a slot is doing — used both to retire the old front
   *  after a successful swap and to abandon a failed preload attempt. */
  const cleanupSlot = useCallback(
    (slot: Slot) => {
      const hlsRefObj = getHlsRefObj(slot);
      if (hlsRefObj.current) {
        hlsRefObj.current.destroy();
        hlsRefObj.current = null;
      }
      const video = getVideoEl(slot);
      if (video) {
        try {
          video.pause();
          video.removeAttribute("src");
          video.load();
        } catch {
          /* ignore */
        }
      }
    },
    [getHlsRefObj, getVideoEl]
  );

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

  /** Reloads the CURRENT front link in place — step 1 of the ladder. */
  const reloadCurrentStream = useCallback(() => {
    const url = displayedMirrorsRef.current[displayedIndexRef.current]?.url;
    if (url) loadIntoSlotRef.current?.(frontSlotRef.current, url, { front: true });
  }, []);

  /**
   * Moves the FRONT slot to the next link that hasn't already proven dead —
   * step 2. Returns false when every server has been exhausted.
   */
  const advanceToNextServer = useCallback((): boolean => {
    const mirrors = displayedMirrorsRef.current;
    const total = mirrors.length;
    for (let offset = 1; offset <= total; offset++) {
      const candidate = (displayedIndexRef.current + offset) % total;
      if (!deadServersRef.current.has(candidate)) {
        console.warn(`[Resilience] Switching to Server ${candidate + 1}`);
        retriedCurrentRef.current = false;
        recoveringRef.current = false;
        setRecoveryPhase("idle");
        setFailoverToast(`Switching to Server ${candidate + 1}...`);
        setTimeout(() => setFailoverToast(null), 4000);
        displayedIndexRef.current = candidate;
        setDisplayedIndex(candidate);
        lastAppliedStreamIdRef.current = mirrors[candidate]?._id || lastAppliedStreamIdRef.current;
        setCurrentStreamIndex(candidate);
        loadIntoSlotRef.current?.(frontSlotRef.current, mirrors[candidate].url, { front: true });
        return true;
      }
    }
    return false;
  }, [setCurrentStreamIndex]);

  /**
   * The resilience ladder. Every playback breakage on the FRONT (on-screen)
   * slot funnels through here:
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

      const index = displayedIndexRef.current;
      const mirrors = displayedMirrorsRef.current;
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
      reportBrokenStream(mirrors[index]?._id);

      const hasUntriedServer = mirrors.some((_, i) => !deadServersRef.current.has(i));

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
    [reloadCurrentStream, advanceToNextServer, reportBrokenStream]
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
      const hls = getHlsRefObj(frontSlotRef.current).current;
      if (hls && selectedLevel === -1) applyNetworkCap(hls);
      else setNetLabel(readNetworkInfo().label);
    };

    conn.addEventListener("change", onChange);
    return () => conn.removeEventListener?.("change", onChange);
  }, [applyNetworkCap, selectedLevel, getHlsRefObj]);

  /** Manual quality override from the picker (acts on the FRONT slot). */
  const handleSelectQuality = (levelIndex: number) => {
    const hls = getHlsRefObj(frontSlotRef.current).current;
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

  /**
   * Unified loader for EITHER slot. `opts.front` decides how events are
   * handled: the front slot drives all the visible player chrome and the
   * full resilience ladder; the back slot is a silent, muted, low-quality
   * pre-buffer whose only job is to prove a mirror works before it's shown.
   */
  const loadIntoSlot = useCallback(
    (slot: Slot, url: string, opts: { front: boolean; generation?: number }) => {
      const video = getVideoEl(slot);
      if (!video) return;

      const hlsRefObj = getHlsRefObj(slot);
      if (hlsRefObj.current) {
        hlsRefObj.current.destroy();
        hlsRefObj.current = null;
      }

      if (opts.front) {
        clearStallTimer();
        setIsLoading(true);
        setErrorMsg(null);
      }

      if (Hls.isSupported()) {
        // Seed the ABR controller with what the browser knows about the
        // current connection so the very first segment is already the right size.
        const net = readNetworkInfo();
        if (opts.front) setNetLabel(net.label);
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

        hlsRefObj.current = hls;
        hls.loadSource(url);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (opts.front) {
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
          } else {
            // Pre-buffering in the background: always muted (never audible
            // until it's promoted), and capped to the lowest rendition so it
            // doesn't compete for bandwidth with the channel actually on screen.
            video.muted = true;
            if (hls.levels.length > 0) {
              const lowest = hls.levels.reduce(
                (best, l, i) => ((l.height || 0) < (hls.levels[best].height || 0) ? i : best),
                0
              );
              hls.autoLevelCapping = lowest;
              hls.currentLevel = lowest;
            }
          }

          video.play().catch((err) => {
            if (opts.front) {
              console.warn("[Autoplay warning]", err);
            } else {
              failPreloadAttemptRef.current?.(slot);
            }
          });
        });

        // Keep the on-screen quality badge in sync with what ABR picked
        hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
          if (slot !== frontSlotRef.current) return;
          const lvl = hls.levels[data.level];
          if (lvl) setActiveLevelHeight(lvl.height || null);
        });

        // Smart Auto-Failover on Network/Media Error
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          console.warn("[HLS Event Error]:", data.type, data.details);
          if (opts.front) {
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
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            failPreloadAttemptRef.current?.(slot);
          }
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Native Safari HLS support
        video.muted = opts.front ? isMutedRef.current : true;
        video.src = url;
        video
          .play()
          .then(() => {
            if (opts.front) setIsPlaying(true);
          })
          .catch(() => {
            if (!opts.front) failPreloadAttemptRef.current?.(slot);
          });
        if (opts.front) setIsLoading(false);
      } else if (opts.front) {
        setErrorMsg("HLS streaming is not supported in your browser.");
        setIsLoading(false);
      } else {
        failPreloadAttemptRef.current?.(slot);
      }
    },
    [applyNetworkCap, handleStreamFailure, getVideoEl, getHlsRefObj]
  );
  loadIntoSlotRef.current = loadIntoSlot;

  /** A background mirror attempt failed — try the next mirror in the queue. */
  const failPreloadAttempt = useCallback(
    (slot: Slot) => {
      if (slot === frontSlotRef.current) return; // safety: never abandon a live front this way
      cleanupSlot(slot);
      preloadAttemptIndexRef.current += 1;
      attemptPreloadRef.current?.(switchGenerationRef.current);
    },
    [cleanupSlot]
  );
  failPreloadAttemptRef.current = failPreloadAttempt;

  /** Tries the next candidate mirror for the channel we're tuning into. */
  const attemptPreload = useCallback(
    (generation: number) => {
      if (generation !== switchGenerationRef.current) return; // superseded by a newer switch

      const order = pendingMirrorOrderRef.current;
      const idx = preloadAttemptIndexRef.current;
      const mirror = order[idx];
      const backSlot: Slot = frontSlotRef.current === "A" ? "B" : "A";

      if (!mirror) {
        // Every mirror for the target channel failed — abandon the switch and
        // stay on whatever is already playing.
        cleanupSlot(backSlot);
        setSwitching(false);
        setPendingChannelLabel(null);
        setSwitchFailedMsg(
          `Couldn't tune into ${pendingChannelNameRef.current || "that channel"} right now`
        );
        if (switchFailTimeoutRef.current) clearTimeout(switchFailTimeoutRef.current);
        switchFailTimeoutRef.current = setTimeout(() => setSwitchFailedMsg(null), 3500);
        // The player is staying put on whatever is already showing — tell the
        // host so it can un-do any optimistic UI (sidebar highlight, URL,
        // channel info) that already jumped ahead to the target channel.
        onSwitchFailed?.(pendingChannelNameRef.current || "");
        return;
      }

      if (preloadTimeoutRef.current) clearTimeout(preloadTimeoutRef.current);
      loadIntoSlot(backSlot, mirror.url, { front: false, generation });

      // Don't let one hung mirror stall the switch forever.
      preloadTimeoutRef.current = setTimeout(() => {
        if (generation !== switchGenerationRef.current) return;
        preloadAttemptIndexRef.current += 1;
        cleanupSlot(backSlot);
        attemptPreloadRef.current?.(generation);
      }, PRELOAD_MIRROR_TIMEOUT_MS);
    },
    [loadIntoSlot, cleanupSlot, onSwitchFailed]
  );
  attemptPreloadRef.current = attemptPreload;

  /** The back slot is confirmed playing — flip it to the front, instantly and invisibly. */
  const commitSwap = useCallback(
    (slot: Slot) => {
      if (preloadTimeoutRef.current) {
        clearTimeout(preloadTimeoutRef.current);
        preloadTimeoutRef.current = null;
      }

      const video = getVideoEl(slot);
      if (video) {
        video.muted = isMutedRef.current;
        video.volume = volumeRef.current;
      }

      const oldFront = frontSlotRef.current;
      const mirrors = pendingStreamsRef.current;
      const appliedMirror = pendingMirrorOrderRef.current[preloadAttemptIndexRef.current];
      const appliedIndex = Math.max(
        0,
        mirrors.findIndex((m) => m._id === appliedMirror?._id)
      );

      frontSlotRef.current = slot;
      setFrontSlot(slot);

      displayedMirrorsRef.current = mirrors;
      setDisplayedMirrors(mirrors);
      displayedIndexRef.current = appliedIndex;
      setDisplayedIndex(appliedIndex);
      lastAppliedStreamIdRef.current = appliedMirror?._id || lastAppliedStreamIdRef.current;

      // Fresh resilience ladder for the channel that's now on screen.
      deadServersRef.current = new Set();
      retriedCurrentRef.current = false;
      recoveringRef.current = false;
      clearStallTimer();
      clearRecoveryTimers();
      setRecoveryPhase("idle");
      setFailoverToast(null);
      setShowQualityMenu(false);

      const hls = getHlsRefObj(slot).current;
      if (hls) {
        const parsed = hls.levels.map((l, i) => ({
          index: i,
          height: l.height || Math.round((l.bitrate || 0) / 3000),
          bitrate: l.bitrate || 0,
        }));
        setLevels(parsed);
        setSelectedLevel(-1);
        hls.currentLevel = -1;
        applyNetworkCap(hls); // lift the "cheap preload" cap now that it's front
        setActiveLevelHeight(hls.levels[hls.currentLevel]?.height || null);
      }

      setIsPlaying(true);
      setIsLoading(false);
      setSwitching(false);
      setPendingChannelLabel(null);
      setSwitchFailedMsg(null);
      setDisplayedChannelName(pendingChannelNameRef.current || channelName);

      setCurrentStreamIndex(appliedIndex);

      // The old front is no longer needed — free it up as the next back slot.
      cleanupSlot(oldFront);
    },
    [getVideoEl, getHlsRefObj, cleanupSlot, applyNetworkCap, setCurrentStreamIndex, channelName]
  );
  commitSwapRef.current = commitSwap;

  /**
   * Single entry point for "the stream that should be showing changed" —
   * whether that's a brand-new channel from the sidebar or a manual mirror
   * pick within the same channel. The very first stream this player ever
   * shows loads directly (nothing to preserve); every switch after that
   * pre-buffers in the background and crossfades in once ready.
   */
  const requestSwitch = useCallback(
    (target: StreamMirror, fullMirrors: StreamMirror[], label: string) => {
      const generation = ++switchGenerationRef.current;

      if (!frontEverLoadedRef.current) {
        frontEverLoadedRef.current = true;
        lastAppliedStreamIdRef.current = target._id;
        setDisplayedChannelName(label);
        displayedMirrorsRef.current = fullMirrors;
        setDisplayedMirrors(fullMirrors);
        const idx = Math.max(
          0,
          fullMirrors.findIndex((m) => m._id === target._id)
        );
        displayedIndexRef.current = idx;
        setDisplayedIndex(idx);
        deadServersRef.current = new Set();
        retriedCurrentRef.current = false;
        recoveringRef.current = false;
        setRecoveryPhase("idle");
        loadIntoSlot(frontSlotRef.current, target.url, { front: true, generation });
        return;
      }

      setSwitching(true);
      setPendingChannelLabel(label);
      setSwitchFailedMsg(null);
      pendingStreamsRef.current = fullMirrors;
      pendingChannelNameRef.current = label;
      pendingMirrorOrderRef.current = [target, ...fullMirrors.filter((m) => m._id !== target._id)];
      preloadAttemptIndexRef.current = 0;
      attemptPreloadRef.current?.(generation);
    },
    [loadIntoSlot]
  );

  // Fires whenever the parent asks for a different channel/mirror. Guarded so
  // it only acts on genuine changes — not re-renders, and not the ladder's own
  // internal index updates (those already applied directly to the front slot).
  useEffect(() => {
    if (!streams || streams.length === 0) return;
    const target = streams[currentStreamIndex] || streams[0];
    if (!target) return;
    if (target._id === lastAppliedStreamIdRef.current) return;
    requestSwitch(target, streams, channelName);
  }, [streams, currentStreamIndex, channelName, requestSwitch]);

  // Full teardown on unmount only.
  useEffect(() => {
    return () => {
      clearStallTimer();
      clearRecoveryTimers();
      if (preloadTimeoutRef.current) clearTimeout(preloadTimeoutRef.current);
      if (switchFailTimeoutRef.current) clearTimeout(switchFailTimeoutRef.current);
      cleanupSlot("A");
      cleanupSlot("B");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Buffering longer than STALL_TIMEOUT_MS is treated as a failure and enters
   * the resilience ladder — but only for the FRONT slot. A back slot buffering
   * while it warms up is completely normal.
   */
  const handleSlotWaiting = (slot: Slot) => {
    if (slot !== frontSlotRef.current) return;
    if (recoveryPhase === "exhausted") return;
    setIsLoading(true);
    clearStallTimer();
    stallTimerRef.current = setTimeout(() => {
      handleStreamFailure("stalled/buffering for > 5s");
    }, STALL_TIMEOUT_MS);
  };

  /**
   * Playback resumed. If this is the front slot, the ladder is only fully
   * reset once the link has run uninterrupted for STABLE_PLAYBACK_MS. If this
   * is the BACK slot, "playing" is exactly the signal we've been waiting for —
   * commit the swap right now, instantly and invisibly.
   */
  const handleSlotPlaying = (slot: Slot) => {
    if (slot === frontSlotRef.current) {
      setIsLoading(false);
      setIsPlaying(true);
      clearStallTimer();
      clearRecoveryTimers();
      recoveringRef.current = false;
      setFailoverToast(null);
      if (recoveryPhase !== "idle") setRecoveryPhase("idle");

      stableTimerRef.current = setTimeout(() => {
        retriedCurrentRef.current = false;
        deadServersRef.current.delete(displayedIndexRef.current);
      }, STABLE_PLAYBACK_MS);
    } else {
      commitSwapRef.current?.(slot);
    }
  };

  const handleSlotPause = (slot: Slot) => {
    if (slot !== frontSlotRef.current) return;
    setIsPlaying(false);
    clearStallTimer();
  };

  const handleSlotNativeError = (slot: Slot) => {
    if (slot === frontSlotRef.current) {
      handleStreamFailure("media stream error");
    } else {
      failPreloadAttemptRef.current?.(slot);
    }
  };

  /** Manual mirror pick from the on-player server list (desktop). */
  const handleManualServerSelect = (idx: number) => {
    const mirrors = displayedMirrorsRef.current;
    if (idx === displayedIndexRef.current) return;
    const target = mirrors[idx];
    if (!target) return;
    requestSwitch(target, mirrors, channelName);
  };

  // Let the host page know we're tuning into something (e.g. to show
  // "CONNECTING" instead of "PLAYING" in a channel list).
  useEffect(() => {
    onSwitchingChange?.(switching, pendingChannelLabel);
  }, [switching, pendingChannelLabel, onSwitchingChange]);

  /** Starts the 3s countdown after which the overlay controls fade out. */
  const scheduleControlsHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);

  /** Shows the controls and restarts the auto-hide countdown. Controls are
   *  NEVER shown on their own (not on play/pause, not while loading or
   *  erroring, not across a channel switch) — this is the only path that
   *  reveals them, wired to hover (desktop) and touch (mobile) on the player. */
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide]);

  const togglePlay = () => {
    const video = getVideoEl(frontSlotRef.current);
    if (!video) return;
    if (isPlaying) {
      video.pause();
    } else {
      video.play().catch(console.error);
    }
  };

  /**
   * Tapping the video only brings the controls back. Play/pause is triggered
   * exclusively by the dedicated play/pause button — never by tapping the
   * picture (on mobile an accidental tap used to pause the stream).
   */
  const handleVideoClick = () => {
    revealControls();
  };

  const toggleMute = () => {
    const video = getVideoEl(frontSlotRef.current);
    if (!video) return;
    video.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    const video = getVideoEl(frontSlotRef.current);
    if (video) {
      video.volume = val;
      video.muted = val === 0;
      setIsMuted(val === 0);
    }
  };

  // ------------------------------------------------------------------
  // Fullscreen: keep `isFullscreen` in sync with the real browser state,
  // release the orientation lock on exit, and let a hardware/gesture back
  // press close fullscreen first instead of leaving the page.
  // ------------------------------------------------------------------
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

  useEffect(() => {
    // A throwaway history entry is pushed the moment fullscreen opens (see
    // toggleFullscreen). This means the first back-press just exits
    // fullscreen — the same "back closes the overlay first" behaviour users
    // expect from every native video app — instead of navigating away.
    const onPopState = () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // On phones/tablets, rotating to landscape is the universal "go widescreen"
  // gesture for a video app — mirror that instead of requiring a button tap.
  useEffect(() => {
    const handleOrientation = () => {
      if (window.innerWidth >= 1024) return; // desktop already shows the full player
      const isLandscape = window.matchMedia("(orientation: landscape)").matches;
      if (isLandscape && !document.fullscreenElement) {
        toggleFullscreen();
      } else if (!isLandscape && document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    };
    window.addEventListener("orientationchange", handleOrientation);
    return () => window.removeEventListener("orientationchange", handleOrientation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFullscreen = () => {
    // Fullscreen the whole frame (not just the <video>) so the custom
    // controls and quality picker stay usable on mobile.
    const target = containerRef.current;
    const video = getVideoEl(frontSlotRef.current) as
      | (HTMLVideoElement & {
          webkitEnterFullscreen?: () => void;
          webkitSupportsFullscreen?: boolean;
        })
      | null;
    if (!target) return;

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(console.error);
      return;
    }
    if (cssFullscreen) {
      setCssFullscreen(false);
      return;
    }

    const afterEnter = () => {
      if (!fsGuardPushedRef.current) {
        fsGuardPushedRef.current = true;
        window.history.pushState({ __fsGuard: true }, "");
      }
      const so = screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      };
      so?.lock?.("landscape").catch(() => {
        /* not supported on this device (e.g. iOS Safari) — ignore */
      });
    };

    // Prefer the real Fullscreen API (with the webkit prefix for older
    // Safari), then iOS's video-only fullscreen, then the CSS fallback.
    const requestFs =
      target.requestFullscreen ||
      (target as HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> })
        .webkitRequestFullscreen;

    if (requestFs) {
      Promise.resolve(requestFs.call(target))
        .then(afterEnter)
        .catch(() => {
          if (video?.webkitSupportsFullscreen && video.webkitEnterFullscreen) {
            video.webkitEnterFullscreen();
          } else {
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

  // ------------------------------------------------------------------
  // The one "status bar" shown for every connecting/reconnecting/tuning
  // moment — see the JSX below for how it's rendered as a navbar-style
  // dropdown from the top edge of the player.
  // ------------------------------------------------------------------
  let topBarText = "";
  let topBarTone: "emerald" | "amber" = "emerald";
  let topBarIcon: "spin" | "shield" = "spin";

  if (switching) {
    topBarText = `Tuning into ${pendingChannelLabel || "next channel"}…`;
    topBarTone = "emerald";
    topBarIcon = "spin";
  } else if (failoverToast) {
    topBarText = failoverToast;
    topBarTone = "amber";
    topBarIcon = recoveryPhase === "switching" ? "shield" : "spin";
  } else if (isLoading) {
    topBarText = "Connecting to live stream…";
    topBarTone = "emerald";
    topBarIcon = "spin";
  }
  const topBarActive = switching || isLoading || Boolean(failoverToast);

  return (
    <div className="w-full space-y-3">
      {/* Video Container Frame */}
      <div
        ref={containerRef}
        className={`relative bg-black overflow-hidden group rounded-none border-0 ${
          isFullscreen || cssFullscreen
            ? "fixed inset-0 z-[999] w-screen h-screen max-w-none"
            : "aspect-video w-full mx-auto max-w-[calc(52dvh*16/9)] lg:max-w-none shadow-2xl"
        }`}
        onMouseMove={revealControls}
        onMouseLeave={() => {
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
          setControlsVisible(false);
        }}
        onTouchStart={revealControls}
      >
        {/* Slot A */}
        <video
          ref={videoRefA}
          className={`absolute inset-0 w-full h-full object-contain cursor-pointer transition-opacity duration-200 ${
            frontSlot === "A" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
          }`}
          onClick={frontSlot === "A" ? handleVideoClick : undefined}
          onWaiting={() => handleSlotWaiting("A")}
          onPlaying={() => handleSlotPlaying("A")}
          onPause={() => handleSlotPause("A")}
          onError={() => handleSlotNativeError("A")}
          playsInline
        />
        {/* Slot B */}
        <video
          ref={videoRefB}
          className={`absolute inset-0 w-full h-full object-contain cursor-pointer transition-opacity duration-200 ${
            frontSlot === "B" ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"
          }`}
          onClick={frontSlot === "B" ? handleVideoClick : undefined}
          onWaiting={() => handleSlotWaiting("B")}
          onPlaying={() => handleSlotPlaying("B")}
          onPause={() => handleSlotPause("B")}
          onError={() => handleSlotNativeError("B")}
          playsInline
        />

        {/* A light dim while connecting/reconnecting keeps focus on the status
            bar above without fully hiding a still-frozen frame underneath. */}
        {isLoading && <div className="absolute inset-0 bg-black/25 z-20 pointer-events-none" />}

        {/* Error Overlay */}
        {errorMsg && recoveryPhase !== "exhausted" && (
          <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center z-30">
            <AlertTriangle className="w-12 h-12 text-red-500 mb-2" />
            <h3 className="text-base font-bold text-white mb-1">Stream Unavailable</h3>
            <p className="text-xs text-slate-400 max-w-md mb-4">{errorMsg}</p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const m = displayedMirrorsRef.current[displayedIndexRef.current];
                  if (m) loadIntoSlot(frontSlotRef.current, m.url, { front: true });
                }}
                className="px-4 py-2 bg-[#00c978] hover:bg-[#00db84] text-slate-950 rounded-xl text-xs font-bold transition-colors shadow-lg"
              >
                Retry Link
              </button>
              {displayedMirrors.length > 1 && (
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

        {/* ===== Unified status bar: connecting, reconnecting/failover, and
            tuning into the next channel all drop down from here, navbar-style.
            The channel underneath (if any) stays fully visible the whole time. ===== */}
        <div
          className={`absolute top-0 inset-x-0 z-40 transition-all duration-300 ease-out ${
            topBarActive ? "translate-y-0 opacity-100" : "-translate-y-full opacity-0"
          }`}
        >
          <div
            className={`relative flex items-center gap-2.5 px-4 sm:px-5 py-2.5 backdrop-blur-md border-b overflow-hidden ${
              topBarTone === "amber"
                ? "bg-gradient-to-b from-amber-950/90 via-slate-950/90 to-slate-950/60 border-amber-500/30"
                : "bg-gradient-to-b from-emerald-950/80 via-slate-950/90 to-slate-950/60 border-emerald-500/30"
            }`}
          >
            {topBarIcon === "shield" ? (
              <ShieldCheck className={`w-4 h-4 shrink-0 ${topBarTone === "amber" ? "text-amber-400" : "text-emerald-400"}`} />
            ) : (
              <RefreshCw
                className={`w-4 h-4 shrink-0 animate-spin ${topBarTone === "amber" ? "text-amber-400" : "text-emerald-400"}`}
              />
            )}
            <span className="text-xs sm:text-[13px] font-semibold text-slate-100 tracking-wide truncate">
              {topBarText}
            </span>
            {/* Indeterminate progress sweep along the bottom edge of the bar */}
            <div className="absolute bottom-0 inset-x-0 h-[2px] bg-white/5 overflow-hidden">
              <div
                className={`h-full w-1/3 rounded-full ${
                  topBarActive ? "animate-[solu-status-sweep_1.4s_ease-in-out_infinite]" : ""
                } ${topBarTone === "amber" ? "bg-amber-400" : "bg-emerald-400"}`}
              />
            </div>
          </div>
        </div>
        <style>{`
          @keyframes solu-status-sweep {
            0% {
              transform: translateX(-100%);
            }
            100% {
              transform: translateX(400%);
            }
          }
        `}</style>
        {switchFailedMsg && (
          <div className="absolute top-14 left-1/2 -translate-x-1/2 z-40 bg-red-950/95 text-red-200 text-xs font-bold px-4 py-2 rounded-xl shadow-2xl border border-red-500/40">
            {switchFailedMsg}
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
              {displayedChannelName}
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
              Server {displayedIndex + 1} ({activeDisplayedStream?.latency || 120}ms)
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
      {displayedMirrors.length > 0 && (
        <div className="hidden lg:flex flex-wrap items-center gap-2 pt-0.5">
          {displayedMirrors.map((st, idx) => {
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
