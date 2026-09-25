"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { RefreshCw, AlertCircle, Play, Pause, Volume2, VolumeX, Maximize, SatelliteDish, Signal } from "lucide-react";
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
  /** CSS-driven fullscreen for browsers without the Fullscreen API (iOS). */
  const [cssFullscreen, setCssFullscreen] = useState(false);
  const cssFullscreenRef = useRef(false);
  cssFullscreenRef.current = cssFullscreen;
  /** Mirrors the real browser fullscreen state (Fullscreen API). */
  const [isFullscreen, setIsFullscreen] = useState(false);
  /**
   * True while a phone-sized viewport is in portrait. When fullscreen is
   * active in this state we can't rely on the OS rotating the picture, so the
   * frame is sized to the swapped viewport dims and rotated 90° to present a
   * landscape widescreen view. As soon as the viewport is actually landscape
   * (or the OS orientation-lock kicks in) the rotate is dropped.
   */
  const [portraitPhone, setPortraitPhone] = useState(false);
  const fsGuardPushedRef = useRef(false);

  // ---- YouTube chrome cover ----
  // YouTube paints its own title / share / logo chrome over the video while
  // the embed boots, on every resume, and whenever it is paused. The iframe
  // is cross-origin so none of it can be styled away — instead our own
  // broadcast-style info bars sit over the same top/bottom bands for exactly
  // the window that chrome is on screen, then fade out with it. Paused gets
  // the full opaque mask (chrome never fades while paused).
  /** Raw YT.PlayerState number (-1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued). */
  const [ytState, setYtState] = useState(-1);
  const ytStateRef = useRef(-1);
  const [coverVisible, setCoverVisible] = useState(true);
  const coverTimerRef = useRef<NodeJS.Timeout | null>(null);

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

  // Leaves whichever fullscreen mode is active (real Fullscreen API and/or the
  // CSS rotate frame), releases the orientation lock, and — when `consumeGuard`
  // is true — pops the throwaway history entry pushed on enter so it can't
  // swallow the user's next back press.
  const exitFullscreenMode = useCallback((consumeGuard: boolean) => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => { });
    }
    // Clear both flags synchronously so the rotate-90 frame is torn down on
    // this very render — don't wait for the async fullscreenchange event,
    // which can leave the player visibly rotated after a hardware-back exit.
    setIsFullscreen(false);
    if (cssFullscreenRef.current) {
      setCssFullscreen(false);
    }
    const so = screen.orientation as ScreenOrientation & { unlock?: () => void };
    so?.unlock?.();
    if (consumeGuard && fsGuardPushedRef.current) {
      fsGuardPushedRef.current = false;
      window.history.back();
    } else {
      fsGuardPushedRef.current = false;
    }
  }, []);

  const toggleFullscreen = () => {
    const target = containerBoxRef.current;
    if (!target) return;

    if (document.fullscreenElement || cssFullscreen) {
      exitFullscreenMode(true);
      return;
    }

    // A throwaway history entry means the first back-press just exits the
    // full-screen view instead of leaving the page, and we ask the OS to lock
    // the picture to landscape so it fills the screen wide.
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

    // Real Fullscreen API first (with the webkit prefix for older Safari);
    // where it is missing or refused (iOS), pin the frame to the viewport so
    // a full-screen view still works.
    const requestFs =
      target.requestFullscreen ||
      (target as HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> })
        .webkitRequestFullscreen;

    if (requestFs) {
      Promise.resolve(requestFs.call(target))
        .then(afterEnter)
        .catch(() => {
          setCssFullscreen(true);
          afterEnter();
        });
    } else {
      setCssFullscreen(true);
      afterEnter();
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

  /** Tapping the video only brings the controls back; play/pause is triggered
   *  exclusively by the dedicated play/pause button. */
  const handleVideoClick = () => {
    revealControls();
  };

  /** Click/tap on the masking overlay: start (or resume) playback. */
  const resumePlayback = () => {
    playerRef.current?.playVideo();
    revealControls();
  };

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (coverTimerRef.current) clearTimeout(coverTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("resolving");
    setErrorMsg(null);
    setYtState(-1);
    ytStateRef.current = -1;
    setCoverVisible(true);
    if (coverTimerRef.current) clearTimeout(coverTimerRef.current);

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

      // A channel switch gets a brand-new iframe. Loading a new video into an
      // existing player via loadVideoById leaves it paused — the play() that
      // fires inside the already-loaded iframe has no user activation behind
      // it — whereas a fresh embed carrying autoplay=1 starts exactly like
      // the first one on the page did.
      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch {
          /* already gone */
        }
        playerRef.current = null;
        // destroy() leaves its placeholder div behind; without clearing it the
        // new iframe lands below the fold of this overflow-hidden box.
        containerRef.current.replaceChildren();
      }
      const mount = document.createElement("div");
      mount.className = "w-full h-full";
      containerRef.current.appendChild(mount);

      playerRef.current = new window.YT.Player(mount, {
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
              const st = e.target.getPlayerState();
              setIsPlaying(st === 1);
              setYtState(st);
              ytStateRef.current = st;
            }
          },
          onStateChange: (e) => {
            if (cancelled) return;
            setIsPlaying(e.data === 1);
            const prev = ytStateRef.current;
            setYtState(e.data);
            ytStateRef.current = e.data;
            // Every entry into PLAYING (first frame after a tune-in, or a
            // resume from pause) is when YouTube's title / share chrome is on
            // screen — hold our info bars across that window, then fade them
            // out once YouTube's own chrome has faded.
            if (e.data === 1 && prev !== 1) {
              setCoverVisible(true);
              if (coverTimerRef.current) clearTimeout(coverTimerRef.current);
              coverTimerRef.current = setTimeout(() => setCoverVisible(false), 4000);
            }
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

  // Keep `isFullscreen` in sync with the real browser fullscreen state and
  // release the orientation lock on exit.
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

  // A hardware/gesture back press should close fullscreen first. The browser
  // already consumed the guard entry by the time popstate fires, so we must
  // NOT pop another one here.
  useEffect(() => {
    const onPopState = () => {
      // Always fully tear down on a back press: exit real fullscreen, clear
      // the CSS rotate frame, and release the orientation lock. The browser
      // already consumed the guard entry, so don't pop another one.
      exitFullscreenMode(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [exitFullscreenMode]);

  // Track whether we're on a phone-sized viewport in portrait, so the
  // fullscreen frame can be rotated into a landscape widescreen view.
  useEffect(() => {
    const update = () => {
      setPortraitPhone(
        window.innerWidth < 1024 &&
        window.matchMedia("(orientation: portrait)").matches
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return (
    <div className="w-full space-y-3">
      <div
        ref={containerBoxRef}
        className={`relative bg-black overflow-hidden rounded-none border-0 ${isFullscreen || cssFullscreen
          ? portraitPhone
            ? "fixed top-1/2 left-1/2 z-[999] w-[100dvh] h-[100dvw] -translate-x-1/2 -translate-y-1/2 rotate-90 max-w-none"
            : "fixed inset-0 z-[999] w-screen h-screen max-w-none"
          : "aspect-video w-full mx-auto max-w-[calc(52dvh*16/9)] lg:max-w-none shadow-2xl"
          }`}
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

        {/* Opaque mask while paused / ended — YouTube's chrome never fades in
            those states, so the whole frame gets covered; our own play button
            keeps the surface behaving like a player. */}
        {status === "ready" && (ytState === 2 || ytState === 0) && (
          <div
            className="absolute inset-0 z-[15] bg-black flex items-center justify-center cursor-pointer"
            onMouseMove={revealControls}
            onTouchStart={revealControls}
            onClick={resumePlayback}
          >
            <button
              type="button"
              aria-label={`Play ${channelName}`}
              onClick={(e) => {
                e.stopPropagation();
                resumePlayback();
              }}
              className="w-14 h-14 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
            >
              <Play className="w-6 h-6 fill-current text-white ml-1" />
            </button>
          </div>
        )}

        {/* Broadcast-style info bars. They sit over the exact bands YouTube
            paints its title / share (top) and logo (bottom) chrome in, and
            are on screen for exactly the window that chrome is up — tune-in
            and every resume — then fade out with it. Also revealed by hover
            / touch like the rest of the player chrome. */}
        <div
          className={`absolute top-0 inset-x-0 h-11 sm:h-12 bg-black/35 backdrop-blur-sm backdrop-saturate-150 border-b border-white/10 flex items-center justify-between gap-2 px-2.5 sm:px-4 z-20 pointer-events-none transition-opacity duration-500 ${coverVisible || controlsVisible ? "opacity-100" : "opacity-0"
            }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-xs sm:text-sm font-bold text-white tracking-tight truncate">{channelName}</h2>
            <span className="px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold bg-red-500/15 text-red-400 border border-red-500/30 shrink-0">
              LIVE
            </span>
          </div>
          <div className="flex items-center gap-1 sm:gap-1.5 text-[9px] sm:text-[10px] font-bold text-slate-300 shrink-0 min-w-0">
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/5 border border-white/10 whitespace-nowrap">
              <SatelliteDish className="w-3 h-3 text-slate-400" />
              PAKSAT 1R • 38.8°E
            </span>
            <span className="hidden sm:flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/5 border border-white/10 whitespace-nowrap">
              TP 3880
            </span>
            <span className="hidden md:flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/5 border border-white/10 whitespace-nowrap">
              FREQ 4052 MHz
            </span>
            <span className="hidden lg:flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/5 border border-white/10 whitespace-nowrap">
              POL H
            </span>
            <span className="hidden lg:flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/5 border border-white/10 whitespace-nowrap">
              SR 5600
            </span>
            <span className="hidden xl:flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/5 border border-white/10 whitespace-nowrap">
              FEC 3/4
            </span>
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 whitespace-nowrap">
              <Signal className="w-3 h-3" />
              98%
            </span>
          </div>
        </div>

        <div
          className={`absolute bottom-0 inset-x-0 h-11 sm:h-12 bg-black/35 backdrop-blur-md backdrop-saturate-125 border-t border-white/10 flex items-center justify-between gap-3 px-2.5 sm:px-4 z-20 transition-opacity duration-500 ${coverVisible || controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
        >
          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              aria-label={isPlaying ? "Pause" : "Play"}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current ml-0.5" />}
            </button>
            <button onClick={toggleMute} aria-label={isMuted ? "Unmute" : "Mute"} className="text-slate-300 hover:text-white transition-colors">
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
          </div>
          <div className="hidden md:flex items-center gap-3 text-[9px] font-bold text-slate-400">
            <span>FREQ 4052 MHz</span>
            <span>SR 5600</span>
            <span>FEC 3/4</span>
            <span className="text-emerald-400">1080i50</span>
          </div>
          <button onClick={toggleFullscreen} aria-label="Fullscreen" className="text-slate-300 hover:text-white transition-colors">
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
