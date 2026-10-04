"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import Hls from "hls.js";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  AlertTriangle,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Zap,
  Activity,
  Server,
  Lock,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import {
  SecuredStreamCandidate,
  refreshSecuredStreamToken,
  checkLocalPcBridgeStatus,
  LocalServerStatus,
} from "@/lib/sportsArenaService";

interface SecuredHlsPlayerProps {
  matchTitle: string;
  sportType?: string;
  eventId?: string;
  streams: SecuredStreamCandidate[];
  currentStreamIndex?: number;
  onStreamIndexChange?: (index: number) => void;
  onAllServersFailed?: () => void;
  onStreamFailed?: (streamId: string) => void;
  onCloseArena?: () => void;
}

export default function SecuredHlsPlayer({
  matchTitle,
  sportType = "Live Sports",
  eventId,
  streams,
  currentStreamIndex: controlledIndex,
  onStreamIndexChange,
  onAllServersFailed,
  onStreamFailed,
  onCloseArena,
}: SecuredHlsPlayerProps) {
  const [internalIndex, setInternalIndex] = useState(0);
  const activeIndex = controlledIndex !== undefined ? controlledIndex : internalIndex;

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Playback & UI states
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1.0);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Security & Bridge signals
  const [bridgeStatus, setBridgeStatus] = useState<LocalServerStatus>({
    online: false,
    activeEventsCount: 0,
  });
  const [tokenRefreshing, setTokenRefreshing] = useState(false);
  const [streamLatency, setStreamLatency] = useState<number>(25);

  const activeStream = useMemo(() => {
    return streams[activeIndex] || streams[0] || null;
  }, [streams, activeIndex]);

  // Clean teardown helper
  const purgeAndDestroyPlayer = useCallback(() => {
    if (hlsRef.current) {
      try {
        hlsRef.current.stopLoad();
        hlsRef.current.detachMedia();
        hlsRef.current.destroy();
      } catch (err) {
        console.warn("[SecuredHlsPlayer] HLS destroy warning:", err);
      }
      hlsRef.current = null;
    }

    if (videoRef.current) {
      try {
        videoRef.current.pause();
        videoRef.current.removeAttribute("src");
        videoRef.current.load();
      } catch (err) {
        console.warn("[SecuredHlsPlayer] Video element cleanup warning:", err);
      }
    }
  }, []);

  // Poll PC bridge server (Port 5000) control signals
  useEffect(() => {
    let mounted = true;
    const pollBridge = async () => {
      const status = await checkLocalPcBridgeStatus();
      if (mounted) {
        setBridgeStatus(status);
      }
    };

    pollBridge();
    const interval = setInterval(pollBridge, 20_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const handleNextServer = useCallback(() => {
    if (streams.length <= 1) {
      onAllServersFailed?.();
      return;
    }

    const nextIdx = (activeIndex + 1) % streams.length;
    if (nextIdx === 0) {
      onAllServersFailed?.();
    } else {
      if (controlledIndex === undefined) {
        setInternalIndex(nextIdx);
      }
      onStreamIndexChange?.(nextIdx);
    }
  }, [streams, activeIndex, controlledIndex, onStreamIndexChange, onAllServersFailed]);

  // Stream load with AES proxy and dynamic token re-handshakes
  useEffect(() => {
    if (!activeStream) {
      purgeAndDestroyPlayer();
      setIsLoading(false);
      return;
    }

    let isSubscribed = true;
    purgeAndDestroyPlayer();
    setIsLoading(true);
    setErrorMsg(null);

    const initSecuredPlayback = async () => {
      let finalPlayUrl = activeStream.url;

      // Re-handshake token if needed
      if (activeStream.isProxied) {
        setTokenRefreshing(true);
        finalPlayUrl = await refreshSecuredStreamToken(activeStream);
        if (isSubscribed) setTokenRefreshing(false);
      }

      if (!isSubscribed) return;

      const video = videoRef.current;
      if (!video) return;

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false, // Prevents aggressive stalls on proxied / forwarded streams
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
        let retryCount = 0;

        hls.loadSource(finalPlayUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!isSubscribed) return;
          setIsLoading(false);
          setErrorMsg(null);
          retryCount = 0;
          setStreamLatency(activeStream.latency || 25);
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
          retryCount = 0;
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            console.warn("[SecuredHlsPlayer] Fatal Secured HLS error:", data.type, data.details);

            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                retryCount++;
                if (retryCount <= 3) {
                  // Silent keep-alive retry without flashing UI
                  hls.startLoad();
                } else {
                  onStreamFailed?.(activeStream._id);
                  handleNextServer();
                }
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                hls.recoverMediaError();
                break;
              default:
                onStreamFailed?.(activeStream._id);
                handleNextServer();
                break;
            }
          }
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = finalPlayUrl;
        video.addEventListener("loadedmetadata", () => {
          setIsLoading(false);
          video.play().then(() => setIsPlaying(true)).catch(() => {});
        });
        video.addEventListener("error", () => {
          onStreamFailed?.(activeStream._id);
          handleNextServer();
        });
      } else {
        setErrorMsg("Device does not support secure HLS stream decoding");
        setIsLoading(false);
      }
    };

    initSecuredPlayback();

    return () => {
      isSubscribed = false;
      purgeAndDestroyPlayer();
    };
  }, [activeStream, handleNextServer, onStreamFailed, purgeAndDestroyPlayer]);

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

      {/* Loading Overlay */}
      {isLoading && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/80 backdrop-blur-md pointer-events-none">
          <div className="relative mb-3">
            <RefreshCw className="w-12 h-12 text-emerald-400 animate-spin" />
            <Lock className="w-5 h-5 text-emerald-300 absolute inset-0 m-auto" />
          </div>
          <p className="text-sm font-bold text-white tracking-wide flex items-center gap-2">
            <span>Securing Arena Channel Feed...</span>
          </p>
          {tokenRefreshing && (
            <p className="text-[11px] text-emerald-400 mt-1 font-mono">Dynamic Token Re-handshake in progress</p>
          )}
        </div>
      )}

      {/* Error Overlay */}
      {errorMsg && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/95 p-6 text-center">
          <ShieldAlert className="w-12 h-12 text-red-400 mb-2" />
          <p className="text-base font-bold text-white mb-1">Encrypted Arena Signal Interrupted</p>
          <p className="text-xs text-slate-400 mb-4">{errorMsg}</p>
          <button
            onClick={() => handleNextServer()}
            className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black rounded-xl text-xs flex items-center gap-2 cursor-pointer transition-all shadow-xl"
          >
            <RotateCcw className="w-4 h-4" />
            <span>Engage Secure Fallback Mirror</span>
          </button>
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
          {/* AES Security Pill */}
          <div className="hidden sm:flex items-center gap-1.5 bg-[#0a1222]/90 backdrop-blur-md px-2.5 py-1.5 rounded-xl border border-emerald-500/40 text-emerald-400 shadow-xl text-[11px] font-bold">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>AES-256 PROXIED</span>
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

        {/* Center: Live Server Mirrors Switcher */}
        {streams.length > 1 && (
          <div className="hidden md:flex items-center gap-1 bg-[#0a1222]/90 backdrop-blur-md p-1 rounded-xl border border-emerald-500/30">
            {streams.map((st, idx) => {
              const active = idx === activeIndex;
              return (
                <button
                  key={st._id}
                  onClick={() => {
                    if (controlledIndex === undefined) setInternalIndex(idx);
                    onStreamIndexChange?.(idx);
                  }}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-black transition-all cursor-pointer ${
                    active
                      ? "bg-emerald-500 text-slate-950 shadow-md"
                      : "text-slate-300 hover:bg-slate-800"
                  }`}
                >
                  {st.isProxied ? `Secure CDN ${idx + 1}` : `Direct Stream ${idx + 1}`}
                </button>
              );
            })}
          </div>
        )}

        {/* Right: Latency & Fullscreen */}
        <div className="flex items-center gap-3">
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
