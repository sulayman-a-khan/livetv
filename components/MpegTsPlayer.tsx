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
 * The provider is known to drop the connection roughly every 17-18s. That's
 * absorbed here silently: on an ERROR / early-EOF / stream-complete we tear the
 * player down and reconnect to the SAME feed after a short delay, keeping the
 * last decoded frame on screen (the <video> is never cleared) and showing only
 * a slim "Reconnecting…" bar — no black screen, no error overlay. A link is
 * only declared dead (and failed over to the next server) when it never
 * reaches playback at all after several attempts.
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
  ShieldCheck,
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

/* ---- Resilience timings ---- */
/** Delay before the first silent reconnect after a drop. */
const RECONNECT_BASE_MS = 300;
/** Ceiling for the reconnect backoff while we keep retrying the same feed. */
const RECONNECT_MAX_MS = 3000;
/** Attempts on a link that NEVER reaches playback before we call it dead. */
const MAX_START_ATTEMPTS = 4;
/**
 * The stream must be frozen (video clock not advancing) for this long before we
 * surface ANY buffering UI or force a rebuild. Brief packet stutters and the
 * proxy's ~sub-second reconnect gaps are absorbed by the buffer and never
 * flash an overlay.
 */
const FROZEN_THRESHOLD_MS = 3500;
/** How often the frozen-progress watchdog samples the video clock. */
const PROGRESS_POLL_MS = 700;
/** How long the "all servers down" banner shows before auto-advancing. */
const EXHAUSTED_HOLD_MS = 5000;

const ALL_SERVERS_DOWN_BN = "চ্যানেল সচল নয়";

export default function MpegTsPlayer({
  channelName,
  streams,
  currentStreamIndex: controlledStreamIndex,
  onStreamIndexChange,
  onAllServersFailed,
  onStreamFailed,
  onSwitchFailed,
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
  const [statusToast, setStatusToast] = useState<string | null>(null);
  const [displayedChannelName, setDisplayedChannelName] = useState(channelName);
  const [displayedIndex, setDisplayedIndex] = useState(currentStreamIndex);
  const [recoveryPhase, setRecoveryPhase] = useState<"idle" | "retrying" | "exhausted">("idle");
  const [controlsVisible, setControlsVisible] = useState(false);

  // ---- Switching state ----
  const [switching, setSwitching] = useState(false);
  const [pendingChannelLabel, setPendingChannelLabel] = useState<string | null>(null);

  // ---- Refs for stable access inside timers/handlers ----
  const streamsRef = useRef<StreamMirror[]>(streams || []);
  streamsRef.current = streams || [];
  const indexRef = useRef(currentStreamIndex);
  const lastAppliedIdRef = useRef<string | null>(null);
  const deadServersRef = useRef<Set<number>>(new Set());
  const attemptsRef = useRef(0);
  const hasPlayedRef = useRef(false);
  const reconnectingRef = useRef(false);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const stallTimerRef = useRef<NodeJS.Timeout | null>(null);
  const statusTimerRef = useRef<NodeJS.Timeout | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  const hasLoadedOnceRef = useRef(false);
  const mountedRef = useRef(true);

  // ---- Freeze-frame + frozen-progress watchdog ----
  // A canvas snapshot of the last decoded frame is layered over the <video>
  // during any teardown/reconnect gap, so the picture never flickers to black.
  const frozenCanvasRef = useRef<HTMLCanvasElement>(null);
  const [showFrozenFrame, setShowFrozenFrame] = useState(false);
  const progressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastClockRef = useRef(0); // last observed video.currentTime
  const lastAdvanceStampRef = useRef(0); // Date.now() when the clock last moved
  const frozenShownRef = useRef(false); // overlay currently surfaced
  const recoveryPhaseRef = useRef<"idle" | "retrying" | "exhausted">("idle");
  recoveryPhaseRef.current = recoveryPhase;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;

  // ---- Fullscreen state (parity with HlsPlayer) ----
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cssFullscreen, setCssFullscreen] = useState(false);
  const cssFullscreenRef = useRef(false);
  cssFullscreenRef.current = cssFullscreen;
  const [portraitPhone, setPortraitPhone] = useState(false);
  const fsGuardPushedRef = useRef(false);
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }, []);

  const showStatus = useCallback((msg: string) => {
    setStatusToast(msg);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatusToast(null), 3500);
  }, []);

  /** Snapshots the current video frame onto the overlay canvas so the picture
   *  stays frozen (never black) across a player teardown/reconnect. Returns
   *  false when there's no frame to capture yet. */
  const captureFreezeFrame = useCallback((): boolean => {
    const video = videoRef.current;
    const canvas = frozenCanvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) return false;
    try {
      if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
      if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      setShowFrozenFrame(true);
      return true;
    } catch {
      // A cross-origin/tainted frame can't be read — just skip the snapshot.
      return false;
    }
  }, []);

  const clearFreezeFrame = useCallback(() => {
    frozenShownRef.current = false;
    setShowFrozenFrame(false);
  }, []);

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

  /** Late-bound so failure handlers declared below can call it. */
  const createAndLoadRef = useRef<((rawUrl: string) => void) | null>(null);
  const failCurrentServerRef = useRef<(() => void) | null>(null);
  const scheduleReconnectRef = useRef<((reason: string) => void) | null>(null);

  /**
   * Reconnect to the SAME feed. This runs SILENTLY: it freezes the last frame
   * on the overlay canvas, rebuilds the player, and resumes — no toast, no
   * dimmer. The frozen-progress watchdog (not this function) decides whether a
   * "Reconnecting…" overlay is ever shown, and only once the picture has been
   * genuinely stuck for FROZEN_THRESHOLD_MS. Because the proxy already absorbs
   * the provider's 17-18s drops server-side, this rarely even fires.
   */
  const scheduleReconnect = useCallback(
    (reason: string) => {
      if (!mountedRef.current) return;
      if (reconnectingRef.current) return;
      reconnectingRef.current = true;
      clearTimers();

      const idx = indexRef.current;
      const stream = streamsRef.current[idx];
      if (!stream) {
        reconnectingRef.current = false;
        return;
      }

      // A link that HAS played is just dropping — keep retrying it (fast).
      // A link that has NEVER played counts toward the dead-server threshold.
      if (!hasPlayedRef.current) attemptsRef.current += 1;

      if (!hasPlayedRef.current && attemptsRef.current > MAX_START_ATTEMPTS) {
        reconnectingRef.current = false;
        failCurrentServerRef.current?.();
        return;
      }

      const delay = hasPlayedRef.current
        ? RECONNECT_BASE_MS
        : Math.min(RECONNECT_BASE_MS * attemptsRef.current, RECONNECT_MAX_MS);

      setRecoveryPhase("retrying");
      // Hold the last decoded frame on screen across the rebuild — the <video>
      // goes blank the instant we detach MediaSource, so the canvas covers it.
      captureFreezeFrame();
      destroyPlayer();

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        reconnectingRef.current = false;
        createAndLoadRef.current?.(stream.url);
      }, delay);
    },
    [clearTimers, destroyPlayer, captureFreezeFrame]
  );
  scheduleReconnectRef.current = scheduleReconnect;

  /** Advance to the next server that hasn't already proven dead. */
  const advanceToNextServer = useCallback((): boolean => {
    const mirrors = streamsRef.current;
    const total = mirrors.length;
    for (let offset = 1; offset <= total; offset++) {
      const candidate = (indexRef.current + offset) % total;
      if (!deadServersRef.current.has(candidate)) {
        indexRef.current = candidate;
        setDisplayedIndex(candidate);
        attemptsRef.current = 0;
        hasPlayedRef.current = false;
        lastAppliedIdRef.current = mirrors[candidate]?._id || lastAppliedIdRef.current;
        setRecoveryPhase("idle");
        setCurrentStreamIndex(candidate);
        showStatus(`Switching to Server ${candidate + 1}...`);
        createAndLoadRef.current?.(mirrors[candidate].url);
        return true;
      }
    }
    return false;
  }, [setCurrentStreamIndex, showStatus]);

  /** The current server is dead — report it and fail over, or give up. */
  const failCurrentServer = useCallback(() => {
    clearTimers();
    const idx = indexRef.current;
    const mirrors = streamsRef.current;
    deadServersRef.current.add(idx);
    const deadId = mirrors[idx]?._id;
    if (deadId) {
      onStreamFailed?.(deadId);
      fetch("/api/streams/report-broken", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamId: deadId }),
      }).catch(() => {});
    }

    if (advanceToNextServer()) return;

    // Every server is dead.
    setRecoveryPhase("exhausted");
    setIsLoading(false);
    setStatusToast(null);
  }, [advanceToNextServer, clearTimers, onStreamFailed]);
  failCurrentServerRef.current = failCurrentServer;

  /** Build the mpegts.js player for a raw feed URL and start playback. */
  const createAndLoad = useCallback(
    (rawUrl: string) => {
      if (!mountedRef.current) return;
      const video = videoRef.current;
      if (!video) return;

      destroyPlayer();
      setIsLoading(true);
      setErrorMsg(null);
      // Re-arm the frozen-progress watchdog for this fresh connection attempt.
      lastClockRef.current = 0;
      lastAdvanceStampRef.current = Date.now();

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

        const proxied = buildStreamProxyUrl(rawUrl);
        let player: MpegtsPlayer;
        try {
          player = mpegts.createPlayer(
            { type: "mpegts", isLive: true, cors: true, url: proxied },
            {
              enableWorker: false,
              // A larger IO stash rides out brief chunk delays / the proxy's
              // sub-second reconnect gaps without underrunning the <video>.
              enableStashBuffer: true,
              stashInitialSize: 384,
              // Chase the live edge, but tolerate a few seconds of latency so a
              // minor delay doesn't force an immediate playback re-init.
              liveBufferLatencyChasing: true,
              liveBufferLatencyMaxLatency: 4.0,
              liveBufferLatencyMinRemain: 1.0,
              // Never stop pulling on a live feed.
              lazyLoad: false,
              lazyLoadMaxDuration: 0,
              deferLoadAfterSourceOpen: true,
              // Keep the SourceBuffer from growing without bound.
              autoCleanupSourceBuffer: true,
              autoCleanupMaxBackwardDuration: 60,
              autoCleanupMinBackwardDuration: 30,
              fixAudioTimestampGap: true,
              reuseRedirectedURL: true,
            }
          );
        } catch (err) {
          console.error("[MpegTsPlayer] createPlayer failed", err);
          setErrorMsg("Could not initialise the transport-stream player.");
          setIsLoading(false);
          return;
        }

        playerRef.current = player;

        player.on(mpegts.Events.ERROR, (type: string, detail: string) => {
          // The proxy reconnects server-side, so a fatal error reaching the
          // client is rare (platform maxDuration, or a real network blip).
          // Rebuild quietly and hold the last frame — no overlay unless the
          // picture is still stuck after FROZEN_THRESHOLD_MS (the watchdog).
          console.warn("[MpegTsPlayer] ERROR", type, detail);
          if (type === mpegts.ErrorTypes.MEDIA_ERROR) {
            scheduleReconnect("media");
          } else {
            // NETWORK_ERROR (chunk drop / reset) and anything else.
            scheduleReconnect("network");
          }
        });

        // The proxy closes the stream when the platform ends the connection
        // (maxDuration) — for a live feed this is our cue to silently resume.
        player.on(mpegts.Events.LOADING_COMPLETE, () => {
          scheduleReconnect("eof");
        });

        // mpegts recovered from an early EOF on its own — nothing to surface.
        player.on(mpegts.Events.RECOVERED_EARLY_EOF, () => {
          /* absorbed silently */
        });

        try {
          player.attachMediaElement(video);
          player.load();
        } catch (err) {
          console.error("[MpegTsPlayer] attach/load failed", err);
          scheduleReconnect("attach");
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
    [destroyPlayer, ensureModule, scheduleReconnect, showStatus]
  );
  createAndLoadRef.current = createAndLoad;

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
    deadServersRef.current = new Set();
    attemptsRef.current = 0;
    hasPlayedRef.current = false;
    reconnectingRef.current = false;
    clearTimers();
    setRecoveryPhase("idle");
    setStatusToast(null);
    // Don't carry the previous channel's frozen frame into the new one.
    frozenShownRef.current = false;
    clearFreezeFrame();
    lastClockRef.current = 0;
    lastAdvanceStampRef.current = Date.now();

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
      clearTimers();
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      destroyPlayer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Exhausted: hold the banner, then let the host auto-advance ----
  useEffect(() => {
    if (recoveryPhase !== "exhausted") return;
    const timer = setTimeout(() => onAllServersFailed?.(), EXHAUSTED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [recoveryPhase, onAllServersFailed]);

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
    if (recoveryPhase !== "idle") setRecoveryPhase("idle");
    // Playback resumed — drop the frozen-frame overlay and re-arm the watchdog.
    clearFreezeFrame();
    const v = videoRef.current;
    lastClockRef.current = v ? v.currentTime : 0;
    lastAdvanceStampRef.current = Date.now();
    // It reached playback — this server is alive; reset the drop counters so a
    // later provider drop is absorbed silently instead of failing over.
    if (!hasPlayedRef.current) {
      hasPlayedRef.current = true;
      attemptsRef.current = 0;
    }
    if (reconnectingRef.current) reconnectingRef.current = false;
  }, [recoveryPhase, clearFreezeFrame]);

  /**
   * `waiting` is a hint, not a verdict. Minor packet stutters and the proxy's
   * sub-second reconnect gaps resolve on their own, so we deliberately do
   * NOTHING here — no dimmer, no toast. The frozen-progress watchdog below is
   * the single arbiter of whether the picture is genuinely stuck.
   */
  const handleWaiting = useCallback(() => {
    /* intentionally passive — see the progress watchdog */
  }, []);

  const handlePause = useCallback(() => setIsPlaying(false), []);

  const handleNativeError = useCallback(() => {
    // A <video>-level error (e.g. the SourceBuffer was torn down mid-drop).
    scheduleReconnect("native");
  }, [scheduleReconnect]);

  /**
   * Frozen-progress watchdog — the ONLY thing that surfaces buffering UI.
   * It samples the video clock; only when playback has genuinely not advanced
   * for FROZEN_THRESHOLD_MS (mid-stream) does it freeze the last frame, show a
   * slim "Reconnecting…" bar, and kick a silent rebuild. A user pause never
   * counts as frozen.
   */
  useEffect(() => {
    lastAdvanceStampRef.current = Date.now();
    progressTimerRef.current = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      if (recoveryPhaseRef.current === "exhausted") return;

      const now = Date.now();

      // User paused — don't treat as a freeze; keep the baseline fresh.
      if (video.paused || video.ended) {
        lastAdvanceStampRef.current = now;
        lastClockRef.current = video.currentTime;
        return;
      }

      const clock = video.currentTime;
      if (clock > lastClockRef.current + 0.05) {
        // Healthy: the clock is moving. Clear any frozen overlay.
        lastClockRef.current = clock;
        lastAdvanceStampRef.current = now;
        if (!hasPlayedRef.current) {
          hasPlayedRef.current = true;
          attemptsRef.current = 0;
        }
        if (frozenShownRef.current) {
          frozenShownRef.current = false;
          clearFreezeFrame();
          setIsLoading(false);
          setStatusToast(null);
          if (reconnectingRef.current) reconnectingRef.current = false;
        }
        return;
      }

      // Clock is stuck. Only act once it's been frozen past the threshold and
      // we had previously reached playback (a slow FIRST connect is handled by
      // createAndLoad + mpegts' own network timeouts, not by this watchdog).
      const frozenFor = now - (lastAdvanceStampRef.current || now);
      if (frozenFor >= FROZEN_THRESHOLD_MS && hasPlayedRef.current) {
        if (!frozenShownRef.current) {
          frozenShownRef.current = true;
          captureFreezeFrame();
          setIsLoading(true);
          showStatus("Reconnecting...");
        }
        if (!reconnectingRef.current) scheduleReconnectRef.current?.("frozen");
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
    if (isPlaying) video.pause();
    else video.play().catch(console.error);
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
    attemptsRef.current = 0;
    hasPlayedRef.current = false;
    lastAppliedIdRef.current = target._id;
    setRecoveryPhase("idle");
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

  // ---- Unified status bar ----
  let topBarText = "";
  let topBarTone: "emerald" | "amber" = "emerald";
  if (switching) {
    topBarText = `Tuning into ${pendingChannelLabel || "next channel"}…`;
    topBarTone = "emerald";
  } else if (statusToast) {
    topBarText = statusToast;
    topBarTone = "amber";
  } else if (isLoading) {
    topBarText = "Connecting to live stream…";
    topBarTone = "emerald";
  }
  const topBarActive = switching || isLoading || Boolean(statusToast);

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
          onWaiting={handleWaiting}
          onPause={handlePause}
          onError={handleNativeError}
          playsInline
        />

        {/* Frozen last-frame: covers the <video> during any teardown/reconnect
            gap so the picture holds steady instead of flashing black. Hidden
            the instant the clock advances again. */}
        <canvas
          ref={frozenCanvasRef}
          className={`absolute inset-0 w-full h-full object-contain pointer-events-none z-10 transition-opacity duration-150 ${
            showFrozenFrame ? "opacity-100" : "opacity-0"
          }`}
        />

        {/* A light dim only while connecting with no frame yet — never over a
            held freeze-frame, so buffering UI stays out of the way. */}
        {isLoading && !showFrozenFrame && recoveryPhase !== "exhausted" && (
          <div className="absolute inset-0 bg-black/25 z-20 pointer-events-none" />
        )}

        {/* Hard error overlay — only for genuinely unsupported browsers. */}
        {errorMsg && recoveryPhase !== "exhausted" && (
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
              {mirrors.length > 1 && (
                <button
                  onClick={() => failCurrentServer()}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-bold transition-colors border border-slate-700"
                >
                  Switch to Next Server
                </button>
              )}
            </div>
          </div>
        )}

        {/* All servers down */}
        {recoveryPhase === "exhausted" && (
          <div className="absolute inset-0 bg-slate-950/95 flex flex-col items-center justify-center p-5 sm:p-8 text-center z-40">
            <AlertTriangle className="w-9 h-9 sm:w-11 sm:h-11 text-amber-400 mb-3" />
            <p lang="bn" className="text-base sm:text-xl font-black text-white leading-relaxed">
              {ALL_SERVERS_DOWN_BN}
            </p>
            <p className="mt-1 text-[11px] sm:text-xs font-bold uppercase tracking-wider text-amber-400/80">
              Weak signal
            </p>
            <div className="mt-4 flex items-center gap-2 text-[11px] sm:text-xs font-bold text-emerald-400">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>পরবর্তী চ্যানেলে যাওয়া হচ্ছে...</span>
            </div>
            <div className="mt-3 h-1 w-40 rounded-full bg-slate-800 overflow-hidden">
              <div className="h-full bg-emerald-500 animate-[shrink_5s_linear_forwards]" />
            </div>
          </div>
        )}

        {/* Unified status bar */}
        <div
          className={`absolute top-0 inset-x-0 z-40 transition-all duration-300 ease-out ${
            topBarActive ? "translate-y-0 opacity-100" : "-translate-y-full opacity-0"
          }`}
        >
          <div
            className={`relative flex items-center gap-2.5 px-4 sm:px-5 py-2.5 border-b overflow-hidden ${
              topBarTone === "amber"
                ? "bg-gradient-to-b from-amber-950/90 via-slate-950/90 to-slate-950/60 border-amber-500/30"
                : "bg-gradient-to-b from-emerald-950/80 via-slate-950/90 to-slate-950/60 border-emerald-500/30"
            }`}
          >
            {recoveryPhase === "retrying" ? (
              <ShieldCheck
                className={`w-4 h-4 shrink-0 ${topBarTone === "amber" ? "text-amber-400" : "text-emerald-400"}`}
              />
            ) : (
              <RefreshCw
                className={`w-4 h-4 shrink-0 animate-spin ${topBarTone === "amber" ? "text-amber-400" : "text-emerald-400"}`}
              />
            )}
            <span className="text-xs sm:text-[13px] font-semibold text-slate-100 tracking-wide truncate">
              {topBarText}
            </span>
            <div className="absolute bottom-0 inset-x-0 h-[2px] bg-white/5 overflow-hidden">
              <div
                className={`h-full w-1/3 rounded-full ${
                  topBarActive ? "animate-[solu-ts-sweep_1.4s_ease-in-out_infinite]" : ""
                } ${topBarTone === "amber" ? "bg-amber-400" : "bg-emerald-400"}`}
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
