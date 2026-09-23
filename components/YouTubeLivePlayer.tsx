"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, AlertCircle } from "lucide-react";
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
        playerVars: { autoplay: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: () => {
            if (!cancelled) setStatus("ready");
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
      <div className="relative bg-black overflow-hidden rounded-none border-0 aspect-video w-full mx-auto max-w-[calc(52dvh*16/9)] lg:max-w-none shadow-2xl">
        <div ref={containerRef} className="absolute inset-0 w-full h-full" />

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
