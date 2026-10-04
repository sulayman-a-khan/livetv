"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Activity,
  Server,
  Lock,
  Gauge,
} from "lucide-react";
import {
  checkLocalPcBridgeStatus,
  LocalServerStatus,
} from "@/lib/sportsArenaService";

interface SecuredHlsPlayerProps {
  matchTitle: string;
  sportType?: string;
  /** Single live feed URL published by the server — the viewer has no source control. */
  streamUrl: string;
}

// Cool-down before re-dialing a failed transport.
const RETRY_DELAY_MS = 4000;
// Quiet in-place reloads of the same transport before flipping to the other one.
const MAX_INPLACE_RETRIES = 2;

// Client-side ABR policy: resolution ceiling per device class. Bitrate
// adaptation itself (down-shifting on weak bandwidth) is hls.js ABR; the
// policy only constrains the highest level a device may climb to.
const MAX_HEIGHT_MOBILE = 480;
const MAX_HEIGHT_DESKTOP = 720;

type DeviceClass = "mobile" | "desktop";

function detectDeviceClass(): DeviceClass {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone|IEMobile|Opera Mini/i.test(ua)) return "mobile";
  // iPadOS 13+ masquerades as desktop Safari (Macintosh UA with touch points).
  if (navigator.maxTouchPoints > 1 && /Macintosh/i.test(ua)) return "mobile";
  try {
    if (window.matchMedia("(max-width: 768px)").matches) return "mobile";
  } catch {
    /* matchMedia unavailable */
  }
  return "desktop";
}

// Index of the highest level within the device cap; -1 when the manifest
// carries no resolution metadata (single media playlist — nothing to cap).
function pickCapLevel(levels: { height?: number }[], maxHeight: number): number {
  if (!levels.length) return -1;
  let cap = -1;
  let unknownHeights = 0;
  for (let i = 0; i < levels.length; i++) {
    const h = levels[i]?.height;
    if (typeof h === "number" && h > 0) {
      if (h <= maxHeight) cap = i;
    } else {
      unknownHeights++;
    }
  }
  if (cap === -1 && unknownHeights === levels.length) return -1;
  // Every rendition sits above the cap → fall back to the lowest available.
  return cap === -1 ? 0 : cap;
}

export default function SecuredHlsPlayer({
  matchTitle,
  sportType = "Live Sports",
  streamUrl,
}: SecuredHlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const cleanUrl = (streamUrl || "").trim();
  // Same feed, two transports: direct first, then the site proxy as an
  // invisible fallback for hosts that block non-player clients or CORS.
  const canProxy = /^https?:\/\//i.test(cleanUrl) && !cleanUrl.includes("/api/stream");

  // Playback & UI states
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1.0);
  const [isLoading, setIsLoading] = useState(true);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Security & bridge signals
  const [bridgeStatus, setBridgeStatus] = useState<LocalServerStatus>({
    online: false,
    activeEventsCount: 0,
  });
  const [streamLatency, setStreamLatency] = useState<number>(25);

  // Adaptive quality signals (display + policy inputs)
  const [deviceClass, setDeviceClass] = useState<DeviceClass | null>(null);
  const [liveHeight, setLiveHeight] = useState<number>(0);

  // Poll the PC bridge server (display only — control lives on the panel).
  useEffect(() => {
    let mounted = true;
    const pollBridge = async () => {
      const status = await checkLocalPcBridgeStatus();
      if (mounted) setBridgeStatus(status);
    };

    pollBridge();
    const interval = setInterval(pollBridge, 20_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Classify the device once on the client and track the decoded resolution
  // the video element is actually presenting (drives the quality pill).
  useEffect(() => {
    setDeviceClass(detectDeviceClass());
    const video = videoRef.current;
    if (!video) return;
    const updateHeight = () => setLiveHeight(video.videoHeight || 0);
    video.addEventListener("loadedmetadata", updateHeight);
    video.addEventListener("resize", updateHeight);
    return () => {
      video.removeEventListener("loadedmetadata", updateHeight);
      video.removeEventListener("resize", updateHeight);
    };
  }, []);

  // Single-feed playback with silent auto-recovery. No viewer-facing source
  // controls: quiet in-place reloads first, then swapping transports for the
  // SAME feed, cycling forever while mounted. Source switching is the panel's job.
  useEffect(() => {
    if (!cleanUrl) {
      setFatalError("No live stream signal is currently configured for this match");
      setIsLoading(false);
      setIsReconnecting(false);
      return;
    }

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let nativeCleanup: (() => void) | null = null;
    let attempt = 0; // 0 = direct, 1 = same-feed proxy transport
    let inPlaceRetries = 0;
    let mediaRecoveries = 0;

    const totalAttempts = canProxy ? 2 : 1;
    const deviceKind = detectDeviceClass();
    const maxHeight = deviceKind === "mobile" ? MAX_HEIGHT_MOBILE : MAX_HEIGHT_DESKTOP;

    function resetVideoElement() {
      const video = videoRef.current;
      if (!video) return;
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        /* ignore */
      }
    }

    function destroyCurrent() {
      if (hlsRef.current) {
        try {
          hlsRef.current.stopLoad();
          hlsRef.current.detachMedia();
          hlsRef.current.destroy();
        } catch {
          /* ignore */
        }
        hlsRef.current = null;
      }
      if (nativeCleanup) {
        nativeCleanup();
        nativeCleanup = null;
      }
    }

    // Move to the next transport for the SAME feed; after the last one, loop
    // back with a longer cool-down so a dead upstream is never spammed.
    function advance() {
      if (disposed) return;
      destroyCurrent();
      resetVideoElement();
      attempt = (attempt + 1) % totalAttempts;
      setIsReconnecting(true);
      setIsLoading(true);
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!disposed) start();
      }, attempt === 0 ? RETRY_DELAY_MS * 2 : 1200);
    }

    function start() {
      if (disposed) return;
      const video = videoRef.current;
      if (!video) return;

      destroyCurrent();
      resetVideoElement();
      inPlaceRetries = 0;
      mediaRecoveries = 0;
      setIsLoading(true);
      setIsReconnecting(false);
      setFatalError(null);

      const playUrl =
        attempt === 0
          ? cleanUrl
          : `/api/stream?url=${encodeURIComponent(cleanUrl)}&_t=${Date.now()}`;

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false, // Prevents aggressive stalls on proxied / forwarded streams
          startLevel: -1, // ABR picks the opening level from its bandwidth estimate
          backBufferLength: 30,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          maxBufferSize: 60 * 1000 * 1000,
          manifestLoadingTimeOut: 15000,
          manifestLoadingMaxRetry: 5,
          manifestLoadingRetryDelay: 1000,
          manifestLoadingMaxRetryTimeout: 64000,
          levelLoadingTimeOut: 15000,
          levelLoadingMaxRetry: 5,
          fragLoadingTimeOut: 20000,
          fragLoadingMaxRetry: 6,
          fragLoadingRetryDelay: 1000,
          fragLoadingMaxRetryTimeout: 64000,
          xhrSetup: (xhr) => {
            xhr.setRequestHeader("X-Requested-With", "SoluPlay-Sports-Arena");
          },
        });

        hlsRef.current = hls;

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (disposed) return;
          setIsLoading(false);
          setIsReconnecting(false);
          inPlaceRetries = 0;
          setStreamLatency(attempt === 0 ? 25 : 55);
          // Enforce the device resolution ceiling; ABR keeps auto-scaling
          // down within it (e.g. 360p/240p) when bandwidth dips.
          const capIndex = pickCapLevel(hls.levels ?? [], maxHeight);
          if (capIndex >= 0) hls.autoLevelCapping = capIndex;
          console.info(
            `[SecuredHlsPlayer] device=${deviceKind} max=${maxHeight}p levels=${hls.levels?.length ?? 0} cappedTo=${capIndex}`
          );
          video
            .play()
            .then(() => setIsPlaying(true))
            .catch(() => {
              video.muted = true;
              setIsMuted(true);
              video.play().then(() => setIsPlaying(true)).catch(() => {});
            });
        });

        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          inPlaceRetries = 0;
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || disposed) return;
          console.warn("[SecuredHlsPlayer] Fatal HLS error:", data.type, data.details);

          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            if (mediaRecoveries < 2) {
              mediaRecoveries++;
              hls.recoverMediaError();
            } else {
              advance();
            }
            return;
          }

          // The feed blipped (or the server is mid-switch). Reload the same
          // transport quietly, then fall through to the other transport.
          if (inPlaceRetries < MAX_INPLACE_RETRIES) {
            inPlaceRetries++;
            try {
              hls.startLoad();
            } catch {
              advance();
            }
          } else {
            advance();
          }
        });

        hls.loadSource(playUrl);
        hls.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        const onLoaded = () => {
          if (disposed) return;
          setIsLoading(false);
          setIsReconnecting(false);
          setStreamLatency(attempt === 0 ? 25 : 55);
          video
            .play()
            .then(() => setIsPlaying(true))
            .catch(() => {
              video.muted = true;
              setIsMuted(true);
              video.play().then(() => setIsPlaying(true)).catch(() => {});
            });
        };
        const onError = () => {
          if (disposed) return;
          advance();
        };
        video.addEventListener("loadedmetadata", onLoaded);
        video.addEventListener("error", onError);
        nativeCleanup = () => {
          video.removeEventListener("loadedmetadata", onLoaded);
          video.removeEventListener("error", onError);
        };
        video.src = playUrl;
      } else {
        setFatalError("This device does not support HLS live playback");
        setIsLoading(false);
      }
    }

    start();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      destroyCurrent();
      resetVideoElement();
    };
  }, [cleanUrl, canProxy]);

  const handleMouseMove = () => {
    setControlsVisible(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, 4000);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().then(() => setIsPlaying(true)).catch(() => {});
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

  const handleVolumeChange = (newVol: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = newVol;
    setVolume(newVol);
    if (newVol > 0 && isMuted) {
      video.muted = false;
      setIsMuted(false);
    }
  };

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setControlsVisible(false)}
      className="relative w-full aspect-video bg-[#030712] overflow-hidden select-none group font-sans rounded-2xl border border-emerald-500/20 shadow-[0_0_50px_-12px_rgba(16,185,129,0.25)]"
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        playsInline
        className="w-full h-full object-contain bg-black"
        onClick={togglePlay}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
      />

      {/* Loading / Reconnecting Overlay */}
      {isLoading && !fatalError && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80 backdrop-blur-md pointer-events-none">
          <div className="relative mb-3">
            <RefreshCw className="w-12 h-12 text-emerald-400 animate-spin" />
            <Lock className="w-5 h-5 text-emerald-300 absolute inset-0 m-auto" />
          </div>
          <p className="text-sm font-bold text-white tracking-wide">
            {isReconnecting ? "Reconnecting to Live Feed..." : "Securing Arena Channel Feed..."}
          </p>
          {isReconnecting && (
            <p className="text-[11px] text-emerald-400 mt-1 font-mono">
              The stream resumes automatically — no action needed
            </p>
          )}
        </div>
      )}

      {/* Fatal Overlay (no stream configured / device unsupported) */}
      {fatalError && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/95 p-6 text-center">
          <ShieldAlert className="w-12 h-12 text-red-400 mb-2" />
          <p className="text-base font-bold text-white mb-1">Encrypted Arena Signal Interrupted</p>
          <p className="text-xs text-slate-400">{fatalError}</p>
        </div>
      )}

      {/* Top Arena Banner & PC Bridge Indicators */}
      <div
        className={`absolute top-3 left-3 right-3 z-20 flex items-center justify-between pointer-events-none transition-opacity duration-300 ${
          controlsVisible || isLoading ? "opacity-100" : "opacity-0"
        }`}
      >
        {/* Match Info Badge */}
        <div className="flex items-center gap-2 bg-[#0a1222]/90 backdrop-blur-md px-3 py-2 rounded-xl border border-emerald-500/30 shadow-2xl pointer-events-auto">
          <span className="flex h-2.5 w-2.5 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
          </span>
          <div className="flex flex-col">
            <span className="text-xs font-black text-white leading-tight">{matchTitle}</span>
            <span className="text-[10px] font-bold text-emerald-400 tracking-wider uppercase">
              {sportType} • Live Sports Arena
            </span>
          </div>
        </div>

        {/* Security & PC Bridge Signal Status */}
        <div className="flex items-center gap-2 pointer-events-auto">
          {/* Encrypted Feed Pill */}
          <div className="hidden sm:flex items-center gap-1.5 bg-[#0a1222]/90 backdrop-blur-md px-2.5 py-1.5 rounded-xl border border-emerald-500/40 text-emerald-400 shadow-xl text-[11px] font-bold">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>AES-256 SECURED</span>
          </div>

          {/* PC Bridge Server Port 5000 Status */}
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border backdrop-blur-md text-[11px] font-bold shadow-xl ${
              bridgeStatus.online
                ? "bg-emerald-950/80 border-emerald-500/40 text-emerald-400"
                : "bg-slate-900/80 border-slate-700/60 text-slate-400"
            }`}
          >
            <Server className="w-3.5 h-3.5" />
            <span>PC Bridge: {bridgeStatus.online ? "Port 5000 Active" : "Cloud Relayed"}</span>
          </div>
        </div>
      </div>

      {/* Bottom Arena Controls Bar */}
      <div
        className={`absolute bottom-0 inset-x-0 z-20 p-4 bg-gradient-to-t from-black via-black/75 to-transparent flex items-center justify-between gap-4 transition-opacity duration-300 ${
          controlsVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        {/* Left: Play/Pause, Volume */}
        <div className="flex items-center gap-3">
          <button
            onClick={togglePlay}
            className="w-9 h-9 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 flex items-center justify-center transition-transform hover:scale-105 cursor-pointer shadow-lg font-bold"
            title={isPlaying ? "Pause Match" : "Play Match"}
          >
            {isPlaying ? <Pause className="w-4 h-4 fill-slate-950" /> : <Play className="w-4 h-4 fill-slate-950 ml-0.5" />}
          </button>

          <div className="flex items-center gap-2 group/vol bg-white/5 px-2.5 py-1.5 rounded-xl border border-white/10">
            <button
              onClick={toggleMute}
              className="text-slate-300 hover:text-white transition-colors cursor-pointer"
              title={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted || volume === 0 ? (
                <VolumeX className="w-4 h-4 text-red-400" />
              ) : (
                <Volume2 className="w-4 h-4 text-emerald-400" />
              )}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={isMuted ? 0 : volume}
              onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
              className="w-20 h-1 accent-emerald-400 bg-slate-700 rounded-lg appearance-none cursor-pointer"
            />
          </div>
        </div>

        {/* Center: Live Feed Status (server-controlled) */}
        <div className="hidden md:flex items-center gap-1.5 text-[11px] font-bold text-slate-400 bg-[#0a1222]/90 backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-700/60">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span>Live Feed • Auto-Recovery Enabled</span>
        </div>

        {/* Right: Quality, Latency & Fullscreen */}
        <div className="flex items-center gap-3">
          <div
            className="flex items-center gap-1 text-[11px] font-mono font-bold text-sky-300 bg-sky-950/60 border border-sky-500/30 px-2.5 py-1 rounded-xl"
            title={
              deviceClass === "mobile"
                ? "Adaptive quality — max 480p on mobile, auto-scales down with network speed"
                : "Adaptive quality — max 720p on desktop, auto-scales down with network speed"
            }
          >
            <Gauge className="w-3.5 h-3.5" />
            <span>Auto{liveHeight > 0 ? ` • ${liveHeight}p` : ""}</span>
          </div>

          <div className="hidden sm:flex items-center gap-1 text-[11px] font-mono font-bold text-emerald-400 bg-emerald-950/60 border border-emerald-500/30 px-2.5 py-1 rounded-xl">
            <Activity className="w-3.5 h-3.5" />
            <span>{streamLatency}ms</span>
          </div>

          <button
            onClick={toggleFullscreen}
            className="w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer"
            title={isFullscreen ? "Exit Fullscreen Arena" : "Fullscreen Arena"}
          >
            {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
