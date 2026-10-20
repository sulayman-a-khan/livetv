"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { AlertTriangle, Gauge, Maximize, Minimize, Pause, Play, RefreshCw, Volume2, VolumeX, Wifi } from "lucide-react";

interface Sports247HlsPlayerProps {
  /** Opaque proxy channel key — the only identifier the browser is allowed to know. */
  channelKey: string;
  title: string;
  category?: string;
  /** Already-signed entry URL from the server. Nothing is fetched or minted before play. */
  entryUrl: string;
  /** Epoch ms when that URL stops being accepted. */
  expiresAt: number;
}

/**
 * Latency target: two segments behind the live edge, and never more than four.
 * `liveSyncDurationCount` is where the player starts, `liveMaxLatencyDurationCount`
 * is the point hls.js itself gives up catching up — the watchdog below owns the
 * window in between, because a 1-connection upstream relay drifts slowly and
 * hls.js's own recovery is tuned for a CDN, not for one account.
 */
const LIVE_SYNC_SEGMENTS = 2;
const LIVE_MAX_LATENCY_SEGMENTS = 4;
/** How often the watchdog measures, and the drift it will not tolerate. */
const DRIFT_CHECK_MS = 2000;
/** No new segment buffered for this long means the picture is frozen, not slow. */
const STALL_AFTER_MS = 6000;
/** Re-mint this far ahead of expiry so a match never dies on a signing window. */
const REMINT_LEAD_MS = 120000;
const REMINT_POLL_MS = 30000;
/** A restart costs a hitch, so renewals are capped against a runaway 403 loop. */
const MAX_REMINTS = 6;
const RESTART_DELAY_MS = 800;

export default function Sports247HlsPlayer({
  channelKey,
  title,
  category = "24/7 Live",
  entryUrl,
  expiresAt,
}: Sports247HlsPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const nativeCleanupRef = useRef<(() => void) | null>(null);

  /** The player's live view of its own capability, so a renewal never re-runs the effect. */
  const urlRef = useRef(entryUrl);
  const expiresAtRef = useRef(expiresAt);
  const remintsRef = useRef(0);
  const lastBufferedAtRef = useRef(Date.now());
  const targetDurationRef = useRef(4000);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [statusLine, setStatusLine] = useState("Connecting to the cloud relay…");
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [driftSec, setDriftSec] = useState(0);
  const [corrections, setCorrections] = useState(0);
  const [liveHeight, setLiveHeight] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fsGuardPushed, setFsGuardPushed] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the refs in step with whatever the section handed this player.
  useEffect(() => {
    urlRef.current = entryUrl;
    expiresAtRef.current = expiresAt;
  }, [entryUrl, expiresAt]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const video: HTMLVideoElement = element;

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let inplaceRetries = 0;
    let mediaRecoveries = 0;

    /** One door for every hard stop, so the renewal clock can see it was shut. */
    const fail = (message: string) => {
      stopped = true;
      setFatalError(message);
      setIsLoading(false);
    };

    const destroy = () => {
      if (hlsRef.current) {
        try {
          hlsRef.current.stopLoad();
          hlsRef.current.detachMedia();
          hlsRef.current.destroy();
        } catch {
          /* already gone */
        }
        hlsRef.current = null;
      }
      if (nativeCleanupRef.current) {
        nativeCleanupRef.current();
        nativeCleanupRef.current = null;
      }
    };

    const resetElement = () => {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        /* ignore */
      }
    };

    const attemptAutoplay = () => {
      video
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => {
          // Blocked until the viewer interacts, exactly as every browser now demands.
          video.muted = true;
          setIsMuted(true);
          video
            .play()
            .then(() => setIsPlaying(true))
            .catch(() => {});
        });
    };

    /**
     * Restart the whole pipeline. Only two things reach for this: a playlist URL the
     * proxy has stopped accepting, and a feed that will not produce a first frame.
     */
    const restart = (why: string, delayMs = RESTART_DELAY_MS) => {
      if (disposed) return;
      destroy();
      resetElement();
      inplaceRetries = 0;
      mediaRecoveries = 0;
      setIsLoading(true);
      setStatusLine(why);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!disposed) start();
      }, delayMs);
    };

    /** Ask the app's own server for a fresh URL, then re-attach. Server-to-server signing. */
    const renewAndRestart = (why: string) => {
      if (disposed || stopped) return;
      if (remintsRef.current >= MAX_REMINTS) {
        fail("This channel's play permission could not be renewed. Pick it again to retry.");
        return;
      }
      remintsRef.current++;
      void (async () => {
        try {
          const res = await fetch(`/api/sports-247/token?channelKey=${encodeURIComponent(channelKey)}`, {
            cache: "no-store",
            signal: AbortSignal.timeout(8000),
          });
          const data = await res.json();
          if (!res.ok || typeof data?.entryUrl !== "string") throw new Error("renewal refused");
          urlRef.current = data.entryUrl;
          expiresAtRef.current = Number(data.expiresAt) || Date.now() + REMINT_LEAD_MS;
        } catch {
          // No new URL: retry the same one shortly rather than going dark on a blip.
          expiresAtRef.current = Date.now() + 20000;
        }
        if (!disposed) restart(why, 400);
      })();
    };

    function start() {
      if (disposed) return;
      const url = urlRef.current;
      if (!url) {
        fail("This channel has no cloud relay URL right now.");
        return;
      }

      destroy();
      resetElement();
      stopped = false;
      setIsLoading(true);
      setFatalError(null);
      lastBufferedAtRef.current = Date.now();

      if (!Hls.isSupported()) {
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Safari plays the URL itself; the same 403-on-expiry path is handled by 'error'.
          const onLoaded = () => {
            if (disposed) return;
            setIsLoading(false);
            attemptAutoplay();
          };
          const onError = () => {
            if (disposed) return;
            renewAndRestart("Retrying the relay…");
          };
          video.addEventListener("loadedmetadata", onLoaded);
          video.addEventListener("error", onError);
          nativeCleanupRef.current = () => {
            video.removeEventListener("loadedmetadata", onLoaded);
            video.removeEventListener("error", onError);
          };
          video.src = url;
          return;
        }
        fail("This device cannot play HLS video.");
        return;
      }

      const hls = new Hls({
        enableWorker: true,
        // The proxy serves a tight rolling window, so a low-latency profile is the
        // point of it: start 2 segments back, and treat 4 as the ceiling.
        lowLatencyMode: true,
        liveSyncDurationCount: LIVE_SYNC_SEGMENTS,
        liveMaxLatencyDurationCount: LIVE_MAX_LATENCY_SEGMENTS,
        // Buffers sized for a live match, not for catch-up viewing.
        maxBufferLength: 12,
        maxMaxBufferLength: 20,
        maxBufferSize: 24 * 1000 * 1000,
        backBufferLength: 10,
        startLevel: -1,
        // Resolution follows the box, so a phone never pulls the top rendition.
        capLevelToPlayerSize: true,
        highBufferWatchdogPeriod: 1,
        nudgeOffset: 0.25,
        nudgeMaxRetry: 4,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 2,
        manifestLoadingRetryDelay: 400,
        manifestLoadingMaxRetryTimeout: 3000,
        levelLoadingTimeOut: 10000,
        levelLoadingMaxRetry: 3,
        levelLoadingMaxRetryTimeout: 6000,
        fragLoadingTimeOut: 15000,
        fragLoadingMaxRetry: 3,
        fragLoadingRetryDelay: 300,
        fragLoadingMaxRetryTimeout: 8000,
        // No custom headers: hls.js then sends plain GETs, which the proxy's CORS
        // allow-list accepts without a preflight. A preflight is a round trip in
        // front of the first segment, and on a 24/7 channel it is paid every time.
      });
      hlsRef.current = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (disposed) return;
        setIsLoading(false);
        setStatusLine("Live");
        inplaceRetries = 0;
        attemptAutoplay();
      });

      hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
        const target = Number(data?.details?.targetduration);
        if (Number.isFinite(target) && target > 0) targetDurationRef.current = target * 1000;
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        lastBufferedAtRef.current = Date.now();
        inplaceRetries = 0;
        if (!disposed) setIsLoading(false);
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (disposed || !data.fatal) return;
        // `response` only rides on network errors; the union does not advertise it.
        const code = (data as { response?: { code?: number } }).response?.code ?? 0;

        // 403 = the signature stopped being accepted, 410 = the window rolled past it.
        // Both mean the same thing to a player: this URL is spent, get another one.
        if (code === 403 || code === 410) {
          renewAndRestart("Renewing your seat on this channel…");
          return;
        }

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (mediaRecoveries < 2) {
            mediaRecoveries++;
            hls.recoverMediaError();
          } else {
            restart("Rebuilding the picture…");
          }
          return;
        }

        if (inplaceRetries < 2) {
          inplaceRetries++;
          try {
            hls.startLoad();
          } catch {
            restart("Reconnecting to the relay…");
          }
          return;
        }
        restart("Reconnecting to the relay…", 1500);
      });

      hls.loadSource(url);
      hls.attachMedia(video);
    }

    start();

    /**
     * The drift watchdog. hls.js will not correct a feed that slowly slides away from
     * the live edge while it keeps buffering happily, and a single-connection relay
     * drifts: every upstream hiccup costs the window a little more distance. So the
     * distance is measured on a clock and corrected on purpose.
     */
    const driftTimer = setInterval(() => {
      if (disposed) return;
      const hls = hlsRef.current;
      const media = videoRef.current;
      if (!hls || !media || media.paused || media.readyState < 3) return;

      const targetSec = targetDurationRef.current / 1000 || 4;
      const liveSync = typeof hls.liveSyncPosition === "number" && Number.isFinite(hls.liveSyncPosition) ? hls.liveSyncPosition : NaN;
      const reported = Number.isFinite(hls.latency) && hls.latency >= 0 ? hls.latency : NaN;
      const drift = Number.isFinite(reported) ? reported : liveSync - media.currentTime;
      if (!Number.isFinite(drift)) return;

      setDriftSec((previous) => (Math.abs(previous - drift) > 0.4 ? drift : previous));

      const limit = targetSec * LIVE_MAX_LATENCY_SEGMENTS;
      if (drift > limit) {
        const edge = Number.isFinite(liveSync) ? liveSync : media.duration;
        let seekTo = edge - targetSec * 0.5;
        const seekable = media.seekable;
        if (seekable.length > 0) {
          const lo = seekable.start(0);
          const hi = seekable.end(seekable.length - 1);
          seekTo = Math.min(Math.max(seekTo, lo + 0.2), Math.max(hi - 0.2, lo));
        }
        if (Number.isFinite(seekTo) && seekTo > media.currentTime) {
          try {
            media.currentTime = seekTo;
            setCorrections((n) => n + 1);
            void media.play().catch(() => {});
          } catch {
            /* not seekable in this instant; the next tick re-measures */
          }
        }
        return;
      }

      // Frozen, not slow: no fresh bytes for a while, so restart the loader alone.
      // A full restart would throw the buffer away for nothing.
      if (Date.now() - lastBufferedAtRef.current > STALL_AFTER_MS) {
        lastBufferedAtRef.current = Date.now();
        try {
          hls.startLoad();
        } catch {
          restart("Reconnecting to the relay…");
        }
      }
    }, DRIFT_CHECK_MS);

    /**
     * Proactive renewal. A session that outlives its signing window would otherwise
     * discover that at the moment the proxy refuses a playlist — mid-play, with the
     * viewer watching a freeze. Asking early moves the same hitch to a moment where
     * the buffer can hide it.
     */
    const renewTimer = setInterval(() => {
      if (disposed || stopped) return;
      if (Date.now() > expiresAtRef.current - REMINT_LEAD_MS) {
        renewAndRestart("Renewing your seat on this channel…");
      }
    }, REMINT_POLL_MS);

    const onResize = () => setLiveHeight(videoRef.current?.videoHeight || 0);
    const media = videoRef.current;
    media?.addEventListener("loadedmetadata", onResize);
    media?.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(driftTimer);
      clearInterval(renewTimer);
      media?.removeEventListener("loadedmetadata", onResize);
      media?.removeEventListener("resize", onResize);
      destroy();
      resetElement();
    };
    // The pipeline is rebuilt only when the channel changes: a renewal swaps the URL
    // inside this same instance, so the viewer never loses the element they are watching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelKey]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => {});
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  };

  const exitFullscreen = () => {
    const done = () => setIsFullscreen(false);
    if (document.fullscreenElement) {
      document.exitFullscreen().then(done).catch(() => {});
    } else {
      done();
    }
    // The guard entry is only ours to spend when the viewer leaves fullscreen
    // deliberately; a back-press already consumed it (see the popstate handler).
    if (fsGuardPushed) setFsGuardPushed(false);
  };

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement || fsGuardPushed) {
      exitFullscreen();
      return;
    }
    const afterEnter = () => {
      setIsFullscreen(true);
      setFsGuardPushed(true);
      // One throwaway history entry: the first back-press leaves fullscreen instead
      // of leaving the page, which is what every native video app does.
      window.history.pushState({ __fsGuard247: true }, "");
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      orientation?.lock?.("landscape").catch(() => {
        /* iOS Safari and older devices refuse the lock; fullscreen still works */
      });
    };
    const request =
      container.requestFullscreen ||
      (container as HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen;
    if (request) {
      Promise.resolve(request.call(container)).then(afterEnter).catch(() => {});
    }
  };

  useEffect(() => {
    const onFsChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      if (!active) {
        setFsGuardPushed(false);
        const orientation = screen.orientation as ScreenOrientation & { unlock?: () => void };
        orientation?.unlock?.();
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
    // The browser has already popped the guard entry by the time this fires, so
    // nothing is pushed or popped here — only the fullscreen state is unwound.
    const onPopState = () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      setFsGuardPushed(false);
      setIsFullscreen(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const showControls = () => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 4000);
  };

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      onMouseMove={showControls}
      onMouseLeave={() => setControlsVisible(false)}
      className="relative w-full aspect-video bg-black overflow-hidden select-none rounded-2xl border border-cyan-400/20 font-sans"
    >
      <video
        ref={videoRef}
        playsInline
        className="h-full w-full object-contain bg-black"
        onClick={togglePlay}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
      />

      {isLoading && !fatalError && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm pointer-events-none">
          <RefreshCw className="h-10 w-10 animate-spin text-cyan-400" />
          <p className="mt-3 text-sm font-bold text-white">{statusLine}</p>
        </div>
      )}

      {fatalError && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/95 p-6 text-center">
          <AlertTriangle className="h-10 w-10 text-red-400" />
          <p className="mt-2 text-base font-bold text-white">Cloud relay unavailable</p>
          <p className="mt-1 text-xs text-slate-400">{fatalError}</p>
        </div>
      )}

      <div
        className={`pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start justify-between gap-2 transition-opacity duration-300 ${
          controlsVisible || isLoading ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="flex min-w-0 items-center gap-2 rounded-xl border border-cyan-400/30 bg-[#04121c]/90 px-3 py-2 backdrop-blur-md">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-xs font-black text-white">{title}</span>
            <span className="truncate text-[10px] font-bold uppercase tracking-wider text-cyan-300">{category}</span>
          </span>
        </div>

        {/* Drift read-out: the number that says whether this is live or merely playing. */}
        <div className="flex shrink-0 items-center gap-1.5 rounded-xl border border-cyan-400/20 bg-[#04121c]/90 px-2.5 py-1.5 text-[11px] font-bold text-cyan-300 backdrop-blur-md">
          <Wifi className="h-3.5 w-3.5" />
          <span className="font-mono">
            {driftSec > 0 ? `${driftSec.toFixed(1)}s behind` : "at live edge"}
            {corrections > 0 ? ` · ${corrections}` : ""}
          </span>
        </div>
      </div>

      <div
        className={`absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 bg-gradient-to-t from-black via-black/70 to-transparent p-3 transition-opacity duration-300 ${
          controlsVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="flex items-center gap-2">
          <button
            onClick={togglePlay}
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl bg-cyan-400 text-slate-950 transition-transform hover:scale-105"
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause className="h-4 w-4 fill-slate-950" /> : <Play className="ml-0.5 h-4 w-4 fill-slate-950" />}
          </button>
          <button
            onClick={toggleMute}
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl bg-white/10 text-white transition-colors hover:bg-white/20"
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? <VolumeX className="h-4 w-4 text-red-400" /> : <Volume2 className="h-4 w-4 text-cyan-300" />}
          </button>
        </div>

        <div className="flex items-center gap-2">
          {liveHeight > 0 && (
            <span className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-mono font-bold text-slate-300">
              <Gauge className="h-3.5 w-3.5" />
              {liveHeight}p
            </span>
          )}
          <button
            onClick={toggleFullscreen}
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl bg-white/10 text-white transition-colors hover:bg-white/20"
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
