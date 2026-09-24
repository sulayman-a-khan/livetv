"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, AlertCircle, Play, Pause, Volume2, VolumeX, Maximize } from "lucide-react";
import { extractYouTubeVideoId } from "@/lib/youtube";

/**
 * Plays a YouTube Live stream via YouTube's own IFrame Player API
 * (https://developers.google.com/youtube/iframe_api_reference).
 *
 * This intentionally does NOT try to pull a raw .m3u8 manifest out of
 * YouTube and feed it into Hls.js — YouTube's Terms of Service prohibit
 * accessing their videos through anything other than their own player /
 * APIs, and prohibit stripping ads. This component uses the sanctioned
 * embed instead, so YouTube's own ads/branding on that particular stream
 * still show — the trade-off for playing it at all.
 */

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement | string,
        opts: {
          videoId?: string;
          playerVars?: Record<string, string | number>;
          events?: {
            onReady?: (e: { target: YTPlayerInstance }) => void;
            onStateChange?: (e: { data: number; target: YTPlayerInstance }) => void;
            onError?: (e: { data: number }) => void;
          };
        }
      ) => YTPlayerInstance;
      PlayerState: { ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface YTPlayerInstance {
  loadVideoById: (videoId: string) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  mute: () => void;
  unMute: () => void;
  isMuted: () => boolean;
  getPlayerState: () => number;
  destroy: () => void;
}

/** Loads the IFrame API script at most once per page, however many players are on it. */
let apiLoadPromise: Promise<void> | null = null;
function loadYouTubeIframeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiLoadPromise) return apiLoadPromise;

  apiLoadPromise = new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return apiLoadPromise;
}

interface YouTubeLivePlayerProps {
  channelName: string;
  /** The channel's YouTube URL (a direct video/live link, or a channel "/live" page). */
  youtubeUrl: string;
  /** Fired if the video can't be resolved or played (private, ended, embedding disabled, channel not live). */
  onUnavailable?: () => void;
}

export default function YouTubeLivePlayer({ channelName, youtubeUrl, onUnavailable }: YouTubeLivePlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const [status, setStatus] = useState<"resolving" | "ready" | "error">("resolving");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ---- Auto-hiding channel-name overlay — same behavior as HlsPlayer: never
  // shown on its own, only revealed by hover (desktop) or touch (mobile), and
  // faded back out after a few seconds so it doesn't sit over the video the
  // rest of the time. ----
  const [controlsVisible, setControlsVisible] = useState(false);
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);

  // ---- Playback state for the custom hover-only control bar. YouTube's own
  // bar is disabled (controls: 0), so these drive play/pause, mute and
  // fullscreen through the IFrame API instead. ----
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const containerBoxRef = useRef<HTMLDivElement>(null);

  const togglePlay = () => {
    const p = playerRef.current;
    if (!p) return;
    if (isPlaying) p.pauseVideo();
    else p.playVideo();
  };

  const toggleMute = () => {
    const p = playerRef.current;
    if (!p) return;
    if (isMuted) {
      p.unMute();
      setIsMuted(false);
    } else {
      p.mute();
      setIsMuted(true);
    }
  };

  const toggleFullscreen = () => {
    const target = containerBoxRef.current;
    if (!target) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      target.requestFullscreen?.().catch(() => {});
    }
  };

  const scheduleControlsHide = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  };
  const revealControls = () => {
    setControlsVisible(true);
    scheduleControlsHide();
  };

  /** First tap just brings the controls back; a tap while they're visible
   *  plays/pauses — same convention as HlsPlayer. */
  const handleVideoClick = () => {
    if (!controlsVisible) {
      revealControls();
      return;
    }
    togglePlay();
    revealControls();
  };

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("resolving");
    setErrorMsg(null);

    async function resolveAndPlay() {
      // Fast path: the URL already names a video — skip the network round trip.
      let videoId = extractYouTubeVideoId(youtubeUrl);

      if (!videoId) {
        try {
          const res = await fetch("/api/youtube/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: youtubeUrl }),
          });
          const data = await res.json();
          if (!data.success || !data.videoId) {
            throw new Error(data.error || "Couldn't resolve YouTube live video");
          }
          videoId = data.videoId;
        } catch (err) {
          if (cancelled) return;
          setErrorMsg(err instanceof Error ? err.message : "Couldn't reach that YouTube channel");
          setStatus("error");
          onUnavailable?.();
          return;
        }
      }

      if (cancelled || !videoId) return;

      await loadYouTubeIframeApi();
      if (cancelled || !containerRef.current || !window.YT) return;

      if (playerRef.current) {
        playerRef.current.loadVideoById(videoId);
        setStatus("ready");
        return;
      }

      playerRef.current = new window.YT.Player(containerRef.current, {
        videoId,
        // controls: 0 keeps YouTube's own control bar off entirely — the
        // hover-only custom bar below replaces it, matching HlsPlayer's
        // auto-hiding chrome.
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, controls: 0, iv_load_policy: 3, modestbranding: 1 },
        events: {
          onReady: (e) => {
            if (!cancelled) {
              setStatus("ready");
              setIsMuted(e.target.isMuted());
              setIsPlaying(e.target.getPlayerState() === 1);
            }
          },
          onStateChange: (e) => {
            if (!cancelled) setIsPlaying(e.data === 1);
          },
          onError: () => {
            if (cancelled) return;
            setErrorMsg(`Couldn't play ${channelName} on YouTube right now`);
            setStatus("error");
            onUnavailable?.();
          },
        },
      });
    }

    resolveAndPlay();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [youtubeUrl]);

  // Full teardown on unmount only.
  useEffect(() => {
    return () => {
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, []);

  return (
    <div className="w-full space-y-3">
      <div
        ref={containerBoxRef}
        className="relative bg-black overflow-hidden rounded-none border-0 aspect-video w-full mx-auto max-w-[calc(52dvh*16/9)] lg:max-w-none shadow-2xl"
        onMouseLeave={() => {
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
          setControlsVisible(false);
        }}
      >
        <div ref={containerRef} className="absolute inset-0 w-full h-full" />

        {/* The YouTube iframe swallows every mouse event, so hover/tap for the
            custom chrome has to be caught on a transparent layer above it. */}
        {status === "ready" && (
          <div
            className="absolute inset-0 z-10 cursor-pointer"
            onMouseMove={revealControls}
            onTouchStart={revealControls}
            onClick={handleVideoClick}
          />
        )}

        {/* Top Channel Title Bar Overlay — hidden until hover/touch, matching HlsPlayer */}
        <div
          className={`absolute top-0 inset-x-0 p-2.5 sm:p-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent transition-opacity duration-300 flex items-center justify-between gap-2 z-20 pointer-events-none ${
            controlsVisible ? "opacity-100" : "opacity-0"
          }`}
        >
          <h2 className="text-xs sm:text-sm font-bold text-white tracking-tight truncate">{channelName}</h2>
          <span className="px-2 py-1 rounded-full text-[9px] sm:text-[10px] font-bold bg-slate-900/80 text-red-400 border border-red-500/30 shrink-0">
            YouTube Live
          </span>
        </div>

        {/* Bottom custom control bar — hover/touch only, same chrome as HlsPlayer */}
        <div
          className={`absolute bottom-0 inset-x-0 p-2.5 sm:p-4 bg-gradient-to-t from-black/90 via-black/50 to-transparent transition-opacity duration-300 flex items-center justify-between gap-3 z-20 ${
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
            <button onClick={toggleMute} className="text-slate-300 hover:text-white transition-colors">
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
          </div>
          <button onClick={toggleFullscreen} className="text-slate-300 hover:text-white transition-colors">
            <Maximize className="w-4 h-4" />
          </button>
        </div>

        {status === "resolving" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 z-10">
            <RefreshCw className="w-8 h-8 text-emerald-400 animate-spin" />
            <p className="text-xs font-bold text-slate-300">Connecting to {channelName} on YouTube...</p>
          </div>
        )}

        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 z-10 px-6 text-center">
            <AlertCircle className="w-8 h-8 text-red-400" />
            <p className="text-xs font-bold text-slate-300">{errorMsg}</p>
          </div>
        )}
      </div>
    </div>
  );
}
