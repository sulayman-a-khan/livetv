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
  Zap,
  Gauge,
  Check,
  RotateCcw,
  Radio,
} from "lucide-react";
import { FreeStreamMirror, isYouTubeStream } from "@/lib/freeChannelService";

interface DirectHlsPlayerProps {
  channelName: string;
  channelId?: string;
  streams: FreeStreamMirror[];
  currentStreamIndex?: number;
  onStreamIndexChange?: (index: number) => void;
  onAllServersFailed?: () => void;
  onStreamFailed?: (streamId: string) => void;
}

interface LevelInfo {
  index: number;
  height: number;
  bitrate: number;
}

export default function DirectHlsPlayer({
  channelName,
  channelId,
  streams,
  currentStreamIndex: controlledIndex,
  onStreamIndexChange,
  onAllServersFailed,
  onStreamFailed,
}: DirectHlsPlayerProps) {
  const [internalIndex, setInternalIndex] = useState(0);
  const activeIndex = controlledIndex !== undefined ? controlledIndex : internalIndex;

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Parent pages re-render often (sidebar health polls, category filter
  // clicks) and hand us freshly-created callback props each time. Reading them
  // through a ref keeps the stream-loader effect's deps stable — an identity
  // change in a parent callback must never tear down the running player and
  // reload the stream (that showed up as a flicker + restart on filter clicks).
  const callbacksRef = useRef({ onStreamIndexChange, onAllServersFailed, onStreamFailed });
  callbacksRef.current = { onStreamIndexChange, onAllServersFailed, onStreamFailed };

  // Playback & UI states
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1.0);
  const [isLoadingStream, setIsLoadingStream] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Quality / ABR state
  const [levels, setLevels] = useState<LevelInfo[]>([]);
  const [selectedLevel, setSelectedLevel] = useState<number>(-1); // -1 = AUTO
  const [currentHeight, setCurrentHeight] = useState<number | null>(null);
  const [showQualityMenu, setShowQualityMenu] = useState(false);

  // Active stream mirror
  const activeStream = useMemo(() => {
    return streams[activeIndex] || streams[0] || null;
  }, [streams, activeIndex]);

  const isYouTube = useMemo(() => {
    return activeStream ? isYouTubeStream(activeStream.url) : false;
  }, [activeStream]);

  // Resolution cap calculation: Mobile -> 480p max, Desktop -> 720p max
  const getDeviceMaxHeight = useCallback(() => {
    if (typeof window === "undefined") return 720;
    return window.innerWidth < 1024 ? 480 : 720;
  }, []);

  /**
   * Complete, aggressive teardown of previous HLS and video instances.
   * Purges video buffers and destroys HLS instantly upon switch.
   */
  const purgeAndDestroyPlayer = useCallback(() => {
    if (hlsRef.current) {
      try {
        hlsRef.current.stopLoad();
        hlsRef.current.detachMedia();
        hlsRef.current.destroy();
      } catch (err) {
        console.warn("[DirectHlsPlayer] HLS destroy warning:", err);
      }
      hlsRef.current = null;
    }

    if (videoRef.current) {
      try {
        videoRef.current.pause();
        videoRef.current.removeAttribute("src");
        videoRef.current.load(); // Forces garbage collection of buffers
      } catch (err) {
        console.warn("[DirectHlsPlayer] Video element cleanup warning:", err);
      }
    }
  }, []);

  const handleNextServer = useCallback(() => {
    const { onAllServersFailed, onStreamIndexChange } = callbacksRef.current;
    if (streams.length <= 1) {
      onAllServersFailed?.();
      return;
    }

    const nextIdx = (activeIndex + 1) % streams.length;
    if (nextIdx === 0) {
      // Cycled through all servers
      onAllServersFailed?.();
    } else {
      if (controlledIndex === undefined) {
        setInternalIndex(nextIdx);
      }
      onStreamIndexChange?.(nextIdx);
    }
  }, [streams, activeIndex, controlledIndex]);

  // Main stream loader effect — re-runs on every channel or server-mirror
  // switch and synchronously tears the previous instance down first, so no
  // old HLS session or buffered video survives the change.
  useEffect(() => {
    // Synchronous hard buffer purge & previous HLS teardown
    if (videoRef.current) {
      try {
        videoRef.current.pause();
        videoRef.current.removeAttribute("src");
        videoRef.current.load();
      } catch {}
    }
    if (hlsRef.current) {
      try {
        hlsRef.current.stopLoad();
        hlsRef.current.detachMedia();
        hlsRef.current.destroy();
      } catch {}
      hlsRef.current = null;
    }

    if (!activeStream || isYouTube) {
      setIsLoadingStream(false);
      return;
    }

    setIsLoadingStream(true);
    setErrorMsg(null);
    setLevels([]);
    setSelectedLevel(-1);

    const video = videoRef.current;
    if (!video) return;

    const streamUrl = activeStream.url;
    const maxHeightCap = getDeviceMaxHeight();

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 10, // Keep back buffer minimal for instant switching & low RAM
        maxBufferLength: 15,
        maxMaxBufferLength: 30,
        maxBufferSize: 30 * 1000 * 1000, // 30MB cap
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 4,
        manifestLoadingTimeOut: 8000,
        manifestLoadingMaxRetry: 2,
        levelLoadingTimeOut: 8000,
        levelLoadingMaxRetry: 2,
        fragLoadingTimeOut: 10000,
        fragLoadingMaxRetry: 3,
        capLevelToPlayerSize: true,
        xhrSetup: (xhr, url) => {
          // Same-origin only: a custom request header on a cross-origin
          // manifest triggers a CORS preflight the stream CDNs reject,
          // killing playback. Same-origin gets the anti-stale-cache guard
          // without a preflight.
          if (typeof window !== "undefined" && url.startsWith(window.location.origin)) {
            xhr.setRequestHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            xhr.setRequestHeader("Pragma", "no-cache");
          }
        },
      });

      hlsRef.current = hls;

      // Some IPTV boxes mint a fresh variant-playlist filename each time the
      // master is read, and expire it within seconds. A stalled player then
      // retries that dead filename forever, so the master is re-read to pick up
      // a live one — bounded, so a genuinely broken host can't loop us.
      let masterReresolves = 0;

      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        setIsLoadingStream(false);
        masterReresolves = 0;

        // Filter and cap levels
        const parsedLevels: LevelInfo[] = data.levels.map((lvl, index) => ({
          index,
          height: lvl.height || 0,
          bitrate: lvl.bitrate || 0,
        }));
        setLevels(parsedLevels);

        // Apply device resolution cap automatically
        const validIndices = parsedLevels
          .map((l, idx) => ({ ...l, idx }))
          .filter((l) => l.height <= maxHeightCap);

        if (validIndices.length > 0) {
          const highestValid = validIndices.reduce((prev, curr) =>
            curr.height > prev.height ? curr : prev
          );
          hls.autoLevelCapping = highestValid.idx;
        }

        video
          .play()
          .then(() => setIsPlaying(true))
          .catch(() => {
            // Autoplay with audio was blocked: mute and retry
            video.muted = true;
            setIsMuted(true);
            video.play().then(() => setIsPlaying(true)).catch(() => {});
          });
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        const lvl = hls.levels[data.level];
        if (lvl) {
          setCurrentHeight(lvl.height);
        }
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        console.warn("[DirectHlsPlayer] Fatal HLS error:", data.type, data.details);

        // A level/fragment that will not load is usually an expired filename
        // from a live origin, not a dead link — re-read the master for a fresh
        // one first. Only once that is used up (or when the master itself never
        // loaded) do we tell the backend this mirror failed, so a healthy
        // StreamLink is not retired off a transient hiccup.
        if (
          data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          data.details !== Hls.ErrorDetails.MANIFEST_LOAD_ERROR &&
          data.details !== Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT &&
          masterReresolves < 2
        ) {
          masterReresolves++;
          hls.loadSource(streamUrl);
          return;
        }

        callbacksRef.current.onStreamFailed?.(activeStream._id);

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            // Try recovery once, then move to next server
            hls.startLoad();
            setTimeout(() => {
              if (hlsRef.current) {
                handleNextServer();
              }
            }, 3000);
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            purgeAndDestroyPlayer();
            setErrorMsg("Direct stream signal interrupted");
            handleNextServer();
            break;
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native Safari iOS/macOS HLS
      video.src = streamUrl;
      video.addEventListener("loadedmetadata", () => {
        setIsLoadingStream(false);
        video.play().then(() => setIsPlaying(true)).catch(() => {});
      });
      video.addEventListener("error", () => {
        callbacksRef.current.onStreamFailed?.(activeStream._id);
        handleNextServer();
      });
    } else {
      setErrorMsg("HLS streaming is not supported on this device");
      setIsLoadingStream(false);
    }

    return () => {
      purgeAndDestroyPlayer();
    };
    // onStreamIndexChange/onAllServersFailed/onStreamFailed intentionally read
    // via callbacksRef — see comment above the ref declaration.
  }, [channelId, activeIndex, activeStream, isYouTube, getDeviceMaxHeight, handleNextServer, purgeAndDestroyPlayer]);

  // Mouse activity timer for overlay controls
  const handleMouseMove = () => {
    setControlsVisible(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      if (!showQualityMenu) {
        setControlsVisible(false);
      }
    }, 3500);
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

  const handleSelectQuality = (lvlIndex: number) => {
    if (!hlsRef.current) return;
    setSelectedLevel(lvlIndex);
    hlsRef.current.currentLevel = lvlIndex;
    setShowQualityMenu(false);
  };

  const extractYouTubeId = (url: string) => {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|live\/)([^#&?]*).*/;
    const match = url.match(regExp);
    return match && match[2].length === 11 ? match[2] : null;
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setControlsVisible(false)}
      className="relative w-full aspect-video bg-black overflow-hidden select-none group font-sans"
    >
      {/* YouTube Live Embed Mode */}
      {isYouTube && activeStream ? (
        <div className="w-full h-full relative">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${extractYouTubeId(activeStream.url)}?autoplay=1&mute=0&controls=1&modestbranding=1&rel=0`}
            title={channelName}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            className="w-full h-full border-0"
          />
        </div>
      ) : (
        /* Bare-metal Direct HLS Video Element */
        <video
          ref={videoRef}
          playsInline
          className="w-full h-full object-contain bg-black"
          onClick={togglePlay}
          onPlay={() => setIsPlaying(true)}
          onPlaying={() => {
            // Frames are actually rendering — the switch is truly done.
            setIsPlaying(true);
            setIsLoadingStream(false);
          }}
          onPause={() => setIsPlaying(false)}
        />
      )}

      {/* Loading Spinner */}
      {isLoadingStream && !isYouTube && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm pointer-events-none">
          <RefreshCw className="w-10 h-10 text-emerald-400 animate-spin mb-3" />
          <p className="text-xs font-bold text-white tracking-wide">Direct High-Speed Stream Tuning...</p>
        </div>
      )}

      {/* Error Overlay */}
      {errorMsg && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/90 p-6 text-center">
          <AlertTriangle className="w-10 h-10 text-amber-400 mb-2" />
          <p className="text-sm font-bold text-white mb-1">Direct Stream Unavailable</p>
          <p className="text-xs text-slate-400 mb-4">{errorMsg}</p>
          <button
            onClick={() => handleNextServer()}
            className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl text-xs flex items-center gap-2 cursor-pointer transition-colors shadow-lg"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Switch to Next Direct Mirror</span>
          </button>
        </div>
      )}

      {/* Top Channel Badge Overlay */}
      <div
        className={`absolute top-3 left-3 right-3 z-20 flex items-center justify-between pointer-events-none transition-opacity duration-300 ${
          controlsVisible || isLoadingStream ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="flex items-center gap-2 bg-[#080e1b]/85 backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-700/60 shadow-xl pointer-events-auto">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs font-bold text-white">{channelName}</span>
          <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/30">
            DIRECT {currentHeight ? `${currentHeight}p` : "HD"}
          </span>
        </div>

        {/* Multi-server ladder switcher */}
        {streams.length > 1 && (
          <div className="flex items-center gap-1 bg-[#080e1b]/85 backdrop-blur-md p-1 rounded-xl border border-slate-700/60 shadow-xl pointer-events-auto">
            <Radio className="w-3.5 h-3.5 text-slate-400 ml-1.5 mr-0.5" />
            {streams.map((st, idx) => {
              const active = idx === activeIndex;
              return (
                <button
                  key={st._id}
                  onClick={() => {
                    if (controlledIndex === undefined) setInternalIndex(idx);
                    onStreamIndexChange?.(idx);
                  }}
                  className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-all cursor-pointer ${
                    active
                      ? "bg-emerald-500 text-slate-950 shadow-sm"
                      : "text-slate-300 hover:bg-slate-800"
                  }`}
                >
                  Server {idx + 1}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom Control Bar */}
      {!isYouTube && (
        <div
          className={`absolute bottom-0 inset-x-0 z-20 p-3 bg-gradient-to-t from-black/95 via-black/60 to-transparent flex items-center justify-between gap-3 transition-opacity duration-300 ${
            controlsVisible ? "opacity-100" : "opacity-0"
          }`}
        >
          {/* Left: Play/Pause, Volume */}
          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer"
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 fill-white ml-0.5" />}
            </button>

            <div className="flex items-center gap-2 group/vol">
              <button
                onClick={toggleMute}
                className="text-slate-300 hover:text-white transition-colors cursor-pointer"
                title={isMuted ? "Unmute" : "Mute"}
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="w-4 h-4 text-red-400" />
                ) : (
                  <Volume2 className="w-4 h-4" />
                )}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                className="w-16 h-1 accent-emerald-400 bg-slate-700 rounded-lg appearance-none cursor-pointer"
              />
            </div>
          </div>

          {/* Right: Quality ABR menu & Fullscreen */}
          <div className="flex items-center gap-2 relative">
            {/* Resolution indicator & menu trigger */}
            {levels.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowQualityMenu(!showQualityMenu)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] font-bold text-slate-200 transition-colors cursor-pointer"
                >
                  <Gauge className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{selectedLevel === -1 ? `Auto (${currentHeight || "HD"}p)` : `${levels[selectedLevel]?.height}p`}</span>
                </button>

                {/* Quality selection dropdown */}
                {showQualityMenu && (
                  <div className="absolute bottom-full right-0 mb-2 w-36 bg-[#0c1628] border border-slate-700 rounded-xl p-1 shadow-2xl z-30">
                    <button
                      onClick={() => handleSelectQuality(-1)}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-between cursor-pointer ${
                        selectedLevel === -1 ? "bg-emerald-500 text-slate-950 font-bold" : "text-slate-300 hover:bg-slate-800"
                      }`}
                    >
                      <span>Auto (Adaptive)</span>
                      {selectedLevel === -1 && <Check className="w-3.5 h-3.5" />}
                    </button>
                    {levels.map((lvl) => (
                      <button
                        key={lvl.index}
                        onClick={() => handleSelectQuality(lvl.index)}
                        className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-between cursor-pointer ${
                          selectedLevel === lvl.index ? "bg-emerald-500 text-slate-950 font-bold" : "text-slate-300 hover:bg-slate-800"
                        }`}
                      >
                        <span>{lvl.height}p</span>
                        {selectedLevel === lvl.index && <Check className="w-3.5 h-3.5" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Direct Zero-Buffer Badge */}
            <div className="hidden sm:flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-950/60 border border-emerald-500/30 px-2 py-1 rounded-lg">
              <Zap className="w-3 h-3 text-emerald-400" />
              <span>DIRECT ACCEL</span>
            </div>

            {/* Fullscreen Button */}
            <button
              onClick={toggleFullscreen}
              className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer"
              title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
