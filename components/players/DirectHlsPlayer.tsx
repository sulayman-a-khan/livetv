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
  Gauge,
  Check,
  RotateCcw,
} from "lucide-react";
import { FreeStreamMirror, isYouTubeStream } from "@/lib/freeChannelService";

interface DirectHlsPlayerProps {
  channelName: string;
  channelId?: string;
  streams: FreeStreamMirror[];
  currentStreamIndex?: number;
  onStreamIndexChange?: (index: number) => void;
  onAllServersFailed?: () => void;
}

interface LevelInfo {
  index: number;
  height: number;
  bitrate: number;
}

/**
 * The viewer's own copy of the health checker's delivery budget: this many
 * milliseconds to put a real frame on screen before the ladder moves on to the
 * next mirror. The player only steps — it tells the backend nothing; a scheduled
 * pass is what decides whether a link stays listed.
 */
const FIRST_FRAME_DEADLINE_MS = 10_000;

/**
 * Wave crests radiating off the feed horn. Each path is an arc of a circle
 * centred on the horn (68,76 in the receiver's viewBox), spanning ±40° around
 * the dish's axis so they read as one-way transmission rather than a halo.
 */
const SIGNAL_ARCS = [
  "M 64.1 62.5 A 14 14 0 0 1 80.6 69.9",
  "M 61.9 54.9 A 22 22 0 0 1 87.8 66.4",
  "M 59.7 47.2 A 30 30 0 0 1 95 62.9",
];

type ReceiverTone = "locking" | "weak";

/**
 * The receiver graphic: a parabolic dish on a mast that sweeps through its arc
 * while wave crests pulse off the feed horn and a ring expands from it.
 *
 * `weak` is the same drawing with the sweep stopped, the dish dimmed and the
 * crests flickering in and out — a transponder that answers nothing.
 *
 * Inline SVG plus the keyframes in this component's `<style>` block: no Lottie
 * runtime, no JSON asset, nothing fetched. The locking and weak overlays are
 * mutually exclusive, so at most one of these is ever mounted.
 */
function SatelliteReceiver({ tone }: { tone: ReceiverTone }) {
  const locking = tone === "locking";
  return (
    <svg
      viewBox="0 0 160 160"
      aria-hidden="true"
      className={`solu-sat-receiver h-24 w-24 sm:h-28 sm:w-28 overflow-visible ${
        locking
          ? "drop-shadow-[0_0_10px_rgba(34,211,238,0.45)]"
          : "drop-shadow-[0_0_8px_rgba(251,146,60,0.25)]"
      }`}
      fill="none"
      strokeLinecap="round"
    >
      {/* Mast and base */}
      <g className="text-slate-500" stroke="currentColor" strokeOpacity="0.45" strokeWidth="3">
        <path d="M56 104 L49 138" />
        <path d="M39 140 H68" />
      </g>

      {/* Dish + feed horn. The sweep rotates the whole assembly about the mast
          pivot, which is what makes it look like it is hunting for a carrier. */}
      <g
        className={
          locking
            ? "text-cyan-300 animate-[solu-dish-sweep_3.4s_ease-in-out_infinite_alternate]"
            : "text-amber-400/55"
        }
        stroke="currentColor"
        strokeWidth="2.5"
        style={{ transformBox: "view-box", transformOrigin: "56px 104px" }}
      >
        <g transform="rotate(24 56 104)">
          {/* Opaque reflector face: the mast is drawn before this, so a tinted
              fill would let its line read straight through the dish. */}
          <ellipse cx="56" cy="104" rx="34" ry="19" strokeOpacity="0.9" fill="#080e1b" />
          <ellipse cx="56" cy="104" rx="22" ry="12" strokeOpacity="0.4" />
          <ellipse cx="56" cy="104" rx="11" ry="6" strokeOpacity="0.28" />
        </g>
        <path d="M56 104 L68 76" strokeOpacity="0.75" />
        <circle cx="68" cy="76" r="3.5" fill="currentColor" stroke="none" />
      </g>

      {/* Concentric crests, staggered so they travel outward */}
      <g className={locking ? "text-cyan-200" : "text-red-400/80"} stroke="currentColor" strokeWidth="2.5">
        {SIGNAL_ARCS.map((arc, i) => (
          <path
            key={arc}
            d={arc}
            className={
              locking
                ? "animate-[solu-wave-pulse_2.1s_ease-out_infinite]"
                : "animate-[solu-wave-flicker_1.3s_ease-in-out_infinite]"
            }
            style={{
              animationDelay: `${(locking ? 0.42 : 0.17) * i}s`,
              // Hold each crest at its dim 0% state through its own stagger
              // delay, so the very first cycle already reads as outward travel.
              animationFillMode: "backwards",
            }}
          />
        ))}
      </g>

      {/* Locking only: a ring thrown from the horn and dissolving mid-flight */}
      {locking && (
        <circle
          cx="68"
          cy="76"
          r="11"
          className="text-cyan-300/70 animate-[solu-horn-ping_2.6s_ease-out_infinite]"
          stroke="currentColor"
          strokeWidth="2"
          style={{ transformBox: "fill-box", transformOrigin: "center" }}
        />
      )}
    </svg>
  );
}

export default function DirectHlsPlayer({
  channelName,
  channelId,
  streams,
  currentStreamIndex: controlledIndex,
  onStreamIndexChange,
  onAllServersFailed,
}: DirectHlsPlayerProps) {
  const [internalIndex, setInternalIndex] = useState(0);
  const activeIndex = controlledIndex !== undefined ? controlledIndex : internalIndex;

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** Set by the first real frame; the loader effect's deadline reads it. */
  const frameDeliveredRef = useRef(false);

  // Parent pages re-render often (sidebar health polls, category filter
  // clicks) and hand us freshly-created callback props each time. Reading them
  // through a ref keeps the stream-loader effect's deps stable — an identity
  // change in a parent callback must never tear down the running player and
  // reload the stream (that showed up as a flicker + restart on filter clicks).
  const callbacksRef = useRef({ onStreamIndexChange, onAllServersFailed });
  callbacksRef.current = { onStreamIndexChange, onAllServersFailed };

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

  /**
   * The header pill states only what this player actually observes: whether the
   * loader is still waiting for a frame, whether frames are arriving, and the
   * level hls.js really switched to. Nothing here is decorative or assumed.
   */
  const headerStatus = useMemo(() => {
    if (isYouTube) {
      return { label: "YOUTUBE", dot: "bg-red-500 animate-pulse", chip: "text-red-400 bg-red-500/10 border-red-500/30" };
    }
    if (errorMsg) {
      return { label: "NO SIGNAL", dot: "bg-red-500 animate-pulse", chip: "text-red-400 bg-red-500/10 border-red-500/30" };
    }
    if (isLoadingStream) {
      return { label: "TUNING", dot: "bg-cyan-300 animate-pulse", chip: "text-cyan-300 bg-cyan-500/10 border-cyan-500/30" };
    }
    if (isPlaying) {
      return { label: "LIVE", dot: "bg-emerald-400 animate-pulse", chip: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" };
    }
    return { label: "PAUSED", dot: "bg-slate-400", chip: "text-slate-300 bg-slate-500/10 border-slate-500/30" };
  }, [isYouTube, errorMsg, isLoadingStream, isPlaying]);

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

    // Arm the delivery deadline for this connection. `playing` below disarms it;
    // a video that is buffered but paused (autoplay blocked until a tap) counts
    // as delivered too, so the timer blames the link only for a picture that
    // genuinely never arrived.
    frameDeliveredRef.current = false;
    const deadline = setTimeout(() => {
      if (frameDeliveredRef.current) return;
      const v = videoRef.current;
      if (v && (v.readyState >= 2 || v.currentTime > 0)) {
        frameDeliveredRef.current = true;
        return;
      }
      console.warn(
        `[DirectHlsPlayer] Server ${activeIndex + 1} of ${channelName} delivered no frame in ${
          FIRST_FRAME_DEADLINE_MS / 1000
        }s`
      );
      handleNextServer();
    }, FIRST_FRAME_DEADLINE_MS);

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
        handleNextServer();
      });
    } else {
      // Nothing on this device can play HLS — the link is not on trial here.
      clearTimeout(deadline);
      setErrorMsg("HLS streaming is not supported on this device");
      setIsLoadingStream(false);
    }

    return () => {
      clearTimeout(deadline);
      purgeAndDestroyPlayer();
    };
    // onStreamIndexChange/onAllServersFailed intentionally read
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
            // Frames are actually rendering — the switch is truly done, and this
            // link has met its delivery deadline.
            frameDeliveredRef.current = true;
            setIsPlaying(true);
            setIsLoadingStream(false);
          }}
          onPause={() => setIsPlaying(false)}
        />
      )}

      {/* Locking overlay — the receiver hunting for the carrier. It stands down
          the moment the signal is declared weak, so the two never stack. */}
      {isLoadingStream && !isYouTube && !errorMsg && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm pointer-events-none">
          <SatelliteReceiver tone="locking" />
          <p className="mt-2 text-xs font-bold text-cyan-200 tracking-wide">
            Locking onto satellite signal...
          </p>
        </div>
      )}

      {/* Weak-signal overlay — same dish, stopped, dimmed and flickering */}
      {errorMsg && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/90 p-6 text-center">
          <SatelliteReceiver tone="weak" />
          <p className="mt-2 text-sm font-black text-white mb-1">
            Satellite Signal Weak <span className="text-amber-400">— Unable to lock onto stream.</span>
          </p>
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

      <style>{`
        @keyframes solu-dish-sweep {
          from { transform: rotate(-10deg); }
          to { transform: rotate(4deg); }
        }
        @keyframes solu-wave-pulse {
          0%, 100% { opacity: 0.12; }
          35% { opacity: 1; }
          70% { opacity: 0.35; }
        }
        @keyframes solu-horn-ping {
          0% { transform: scale(0.5); opacity: 0.75; }
          70%, 100% { transform: scale(2.6); opacity: 0; }
        }
        @keyframes solu-wave-flicker {
          0%, 100% { opacity: 0.1; }
          12% { opacity: 0.7; }
          24% { opacity: 0.05; }
          41% { opacity: 0.6; }
          55% { opacity: 0.08; }
          73% { opacity: 0.75; }
          86% { opacity: 0.12; }
        }
        @media (prefers-reduced-motion: reduce) {
          .solu-sat-receiver,
          .solu-sat-receiver * {
            animation: none !important;
          }
        }
      `}</style>

      {/* Top Channel Badge Overlay */}
      <div
        className={`absolute top-3 left-3 right-3 z-20 flex items-center justify-between pointer-events-none transition-opacity duration-300 ${
          controlsVisible || isLoadingStream ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="flex items-center gap-2 bg-[#080e1b]/85 backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-700/60 shadow-xl pointer-events-auto">
          <span className={`w-2 h-2 rounded-full ${headerStatus.dot}`} />
          <span className="text-xs font-bold text-white">{channelName}</span>
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${headerStatus.chip}`}>
            {headerStatus.label}
            {currentHeight ? ` • ${currentHeight}p` : ""}
          </span>
        </div>

        {/* Multi-server ladder switcher */}
        {streams.length > 1 && (
          <div className="flex items-center gap-1 bg-[#080e1b]/85 backdrop-blur-md p-1 rounded-xl border border-slate-700/60 shadow-xl pointer-events-auto">
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
