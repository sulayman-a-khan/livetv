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
 * Live feeds jitter for a few hundred ms constantly; a stall has to outlast this
 * before the receiver comes back up over the frozen last frame.
 */
const STALL_GRACE_MS = 1_200;

/**
 * How long the weak-signal notice stays up before the host is told the ladder is
 * dead. The watch page hops to another channel from that callback, so handing
 * off in the same tick would unmount the notice before it could be read.
 */
const WEAK_NOTICE_HOLD_MS = 5_000;

/**
 * The overlay's three positions. `live` is the only one with a picture on
 * screen: `tuning` covers connecting and buffering, `weak` a link that answered
 * nothing.
 */
type SignalPhase = "tuning" | "live" | "weak";

/**
 * Reflector geometry, authored upright in the receiver's own local space and
 * then tilted about its vertex: mount/vertex at (96,150), mouth from (52,134) to
 * (140,134), feed horn on the axis over the centre of the face at (96,100). CSS
 * cannot read these constants, so the same two coordinates are repeated inside
 * the `solu-sat-*` keyframes in app/globals.css — change one, change the other.
 */
const DISH_PIVOT_X = 96;
const DISH_PIVOT_Y = 150;
const HORN_X = 96;
const HORN_Y = 100;

/** rotate(θ) about a point, composed from translates so no engine has to agree
 *  on `transform-origin`/`transform-box` semantics for an SVG element. */
const tiltHead = (deg: number) =>
  `translate(${DISH_PIVOT_X}px, ${DISH_PIVOT_Y}px) rotate(${deg}deg) translate(-${DISH_PIVOT_X}px, -${DISH_PIVOT_Y}px)`;

/** A dead carrier leaves the dish slumped at this elevation, and it stays there. */
const WEAK_TILT_DEG = 48;

/**
 * Transmission crests: each is a ±30° arc of a circle centred on the feed horn,
 * at radii 13/21/29/37. They sit 8 units apart and `solu-sat-emit` carries every
 * crest exactly 8 units along the dish axis, so each one arrives at the position
 * its successor is vacating — a continuous train rather than four blinking rings.
 */
const WAVE_ARCS = [
  "M 89.5 88.74 A 13 13 0 0 1 102.5 88.74",
  "M 85.5 81.81 A 21 21 0 0 1 106.5 81.81",
  "M 81.5 74.89 A 29 29 0 0 1 110.5 74.89",
  "M 77.5 67.96 A 37 37 0 0 1 114.5 67.96",
];

/**
 * The reflector's mesh: six meridians running from the vertex's projection out
 * to the rim, which is how the ribs of a paraboloid read from this angle.
 */
const DISH_RIBS = [
  "M 96 134 L 55.5 134",
  "M 96 134 L 136.5 134",
  "M 96 134 L 65 141.7",
  "M 96 134 L 127 141.7",
  "M 96 134 L 65 126.3",
  "M 96 134 L 127 126.3",
];

type ReceiverTone = "locking" | "weak";

/**
 * The receiver graphic: a front-fed parabolic reflector on a tripod, seen from
 * just below its axis. The dish shell and mouth are shaded, six meridians carry
 * the ribs, and a boom plus two struts hold the LNB cup at the focal point.
 *
 * Three things move while locking: the whole head sweeps through its elevation
 * arc about the mount, a cone of beam leaves the feed toward the sky, and crests
 * are thrown off the LNB one after another — each sliding exactly into the gap
 * its predecessor vacated, so the fan reads as a travelling transmission rather
 * than four blinking arcs. A ring additionally expands out of the horn.
 *
 * `weak` is the same drawing with the head slumped to a fixed off-target
 * elevation, the beam gone, and the crests flickering in and out — a
 * transponder that answers nothing.
 *
 * Inline SVG and CSS keyframes only: no Lottie runtime, no exported animation
 * JSON, no third-party asset, nothing fetched at mount. The `solu-sat-*`
 * keyframes live in `app/globals.css` with the other shared animations, so the
 * graphic also paints correctly wherever a host mounts it outside this player
 * (the watch page shows it while a channel's details are still being fetched).
 */
export function SatelliteReceiver({ tone }: { tone: ReceiverTone }) {
  const locking = tone === "locking";
  return (
    <svg
      viewBox="0 0 200 200"
      aria-hidden="true"
      className={`solu-sat-receiver h-32 w-32 shrink-0 sm:h-36 sm:w-36 overflow-visible ${
        locking
          ? "drop-shadow-[0_0_14px_rgba(34,211,238,0.42)]"
          : "drop-shadow-[0_0_10px_rgba(251,146,60,0.22)]"
      }`}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <defs>
        {/* Back of the reflector: lit near the rim, falling off into the shell. */}
        <linearGradient id="solu-sat-shell" x1="96" y1="134" x2="96" y2="168" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#18263f" />
          <stop offset="100%" stopColor="#070d18" />
        </linearGradient>
        {/* The mouth: a faint cyan wash at the vertex, dark at the rim. */}
        <radialGradient id="solu-sat-face" cx="96" cy="134" r="44" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#060b14" />
        </radialGradient>
        {/* Beam: densest at the feed, gone by the time it reaches the sky. */}
        <linearGradient id="solu-sat-beam" x1="96" y1="100" x2="96" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#67e8f9" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#67e8f9" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Tripod: static, so the head visibly moves against its mount. */}
      <g className="text-slate-500" stroke="currentColor" strokeOpacity="0.5" strokeWidth="3.5">
        <path d="M70 186 L96 152 L122 186" />
        <path d="M60 187 H132" strokeOpacity="0.35" strokeWidth="3" />
      </g>

      {/* The head: dish, feed and everything thrown from it, swept as one. */}
      <g
        className={`transition-colors duration-500 ${
          locking
            ? "text-cyan-300 animate-[solu-sat-sweep_4.4s_ease-in-out_infinite_alternate]"
            : "text-amber-400/60"
        }`}
        stroke="currentColor"
        strokeWidth="2.5"
        // Weak takes the slump as a plain static transform; locking must not
        // carry one, or the two fight and the sweep loses its pivot.
        style={locking ? undefined : { transform: tiltHead(WEAK_TILT_DEG) }}
      >
        {/* Reflector: shell behind, face over it, so nothing behind reads through. */}
        <path d="M52 134 Q96 168 140 134" fill="url(#solu-sat-shell)" strokeOpacity="0.85" />
        <ellipse cx="96" cy="134" rx="44" ry="13" fill="url(#solu-sat-face)" strokeOpacity="0.9" />

        {/* Ribs converging on the vertex, and one shallow ring of the mesh. */}
        <g strokeOpacity="0.32" strokeWidth="1.5" className="text-cyan-100">
          {DISH_RIBS.map((rib) => (
            <path key={rib} d={rib} />
          ))}
          <ellipse cx="96" cy="134" rx="26" ry="7.7" strokeOpacity="0.25" />
        </g>

        {/* Feed assembly: boom up the axis, two struts to the rim, LNB at focus. */}
        <path d="M96 150 L96 104" strokeOpacity="0.75" />
        <g strokeOpacity="0.45" strokeWidth="2">
          <path d="M62 143 L96 104" />
          <path d="M130 143 L96 104" />
        </g>
        <path d="M89 107 A 7.5 7.5 0 0 1 103 107" strokeOpacity="0.8" />
        <circle cx="96" cy="101.5" r="4.6" fill="currentColor" stroke="none" />

        {/* Locking only: the uplink cone the crests travel through. */}
        {locking && (
          <path
            d="M96 100 L68 46 L124 46 Z"
            fill="url(#solu-sat-beam)"
            stroke="none"
            className="animate-[solu-sat-beam_2.6s_ease-in-out_infinite]"
          />
        )}

        {/* Transmission crests, staggered a quarter-cycle apart so each one
            arrives where the previous crest is disappearing. */}
        <g className={`transition-colors duration-500 ${locking ? "text-cyan-200" : "text-red-400/80"}`} stroke="currentColor" strokeWidth="2.5">
          {WAVE_ARCS.map((arc, i) => (
            <path
              key={arc}
              d={arc}
              className={
                locking
                  ? "animate-[solu-sat-emit_1.8s_linear_infinite]"
                  : "animate-[solu-sat-flicker_1.4s_ease-in-out_infinite]"
              }
              style={{
                animationDelay: `${(locking ? 0.45 : 0.18) * i}s`,
                // Hold each crest at its dim 0% state through its own stagger
                // delay, so the very first cycle already reads as outward travel.
                animationFillMode: "backwards",
              }}
            />
          ))}
        </g>

        {/* Locking only: a ping thrown from the horn and dissolving mid-flight. */}
        {locking && (
          <circle
            cx={HORN_X}
            cy={HORN_Y}
            r="12"
            className="text-cyan-300/70 animate-[solu-sat-ping_2.4s_ease-out_infinite]"
            stroke="currentColor"
            strokeWidth="2"
          />
        )}
      </g>
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
  /** Bumped by every loader effect run so a superseded timer can't act twice. */
  const runIdRef = useRef(0);
  /** The overlay's current position, readable from timers without a re-render. */
  const phaseRef = useRef<SignalPhase>("tuning");
  const deadlineRef = useRef<NodeJS.Timeout | null>(null);
  const recoverTimerRef = useRef<NodeJS.Timeout | null>(null);
  const stallTimerRef = useRef<NodeJS.Timeout | null>(null);
  const escalateRef = useRef<NodeJS.Timeout | null>(null);

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
  const [phase, setPhase] = useState<SignalPhase>("tuning");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  phaseRef.current = phase;

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
   * The attempt now on trial. A channel or mirror change is detected during
   * render rather than in the loader effect, because effects run after paint:
   * resetting there left one bare black frame between the old player's teardown
   * and the receiver coming up.
   */
  const attemptKey = `${channelId ?? ""}|${activeIndex}|${activeStream?.url ?? ""}`;
  const [renderedAttemptKey, setRenderedAttemptKey] = useState(attemptKey);
  if (renderedAttemptKey !== attemptKey) {
    setRenderedAttemptKey(attemptKey);
    setPhase("tuning");
    setErrorMsg(null);
  }

  /**
   * The header pill states only what this player actually observes: whether the
   * loader is still waiting for a frame, whether frames are arriving, and the
   * level hls.js really switched to. Nothing here is decorative or assumed.
   */
  const headerStatus = useMemo(() => {
    if (isYouTube) {
      return { label: "YOUTUBE", dot: "bg-red-500 animate-pulse", chip: "text-red-400 bg-red-500/10 border-red-500/30" };
    }
    if (phase === "weak") {
      return { label: "NO SIGNAL", dot: "bg-red-500 animate-pulse", chip: "text-red-400 bg-red-500/10 border-red-500/30" };
    }
    if (phase === "tuning") {
      return { label: "TUNING", dot: "bg-cyan-300 animate-pulse", chip: "text-cyan-300 bg-cyan-500/10 border-cyan-500/30" };
    }
    if (isPlaying) {
      return { label: "LIVE", dot: "bg-emerald-400 animate-pulse", chip: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" };
    }
    return { label: "PAUSED", dot: "bg-slate-400", chip: "text-slate-300 bg-slate-500/10 border-slate-500/30" };
  }, [isYouTube, phase, isPlaying]);

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

  /**
   * Drop every timer that could still move the overlay: the first-frame
   * deadline, the post-error recovery probe, the stall watch, the host hand-off.
   */
  const disarmTimers = useCallback(() => {
    for (const timer of [deadlineRef, recoverTimerRef, stallTimerRef, escalateRef]) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    }
  }, []);

  /**
   * Step to the next mirror, and when the ladder has nothing left to give, hand
   * the overlay over to the weak-signal state instead of spinning on a link that
   * will never answer. `exhaustedReason` is the one line the viewer reads under
   * that headline; it is only shown once the mirrors are used up, so stepping
   * between mirrors never flashes a warning the next attempt has already fixed.
   */
  const handleNextServer = useCallback(
    (exhaustedReason: string) => {
      const { onAllServersFailed, onStreamIndexChange } = callbacksRef.current;

      const giveUp = () => {
        if (phaseRef.current === "weak") return;
        disarmTimers();
        phaseRef.current = "weak";
        setErrorMsg(exhaustedReason);
        setPhase("weak");
        escalateRef.current = setTimeout(() => {
          escalateRef.current = null;
          onAllServersFailed?.();
        }, WEAK_NOTICE_HOLD_MS);
      };

      if (streams.length <= 1) {
        giveUp();
        return;
      }

      const nextIdx = (activeIndex + 1) % streams.length;
      if (nextIdx === 0) {
        // Cycled through all servers
        giveUp();
      } else {
        if (controlledIndex === undefined) {
          setInternalIndex(nextIdx);
        }
        onStreamIndexChange?.(nextIdx);
      }
    },
    [streams, activeIndex, controlledIndex, disarmTimers]
  );

  /**
   * Take the overlay down, but only once output is proven: frames decoded and
   * ready (`videoWidth` on screen), or — for a feed with no video track at all —
   * a media clock that has started moving. A parsed manifest or loaded metadata
   * is not proof; standing the receiver down on those is what produced the black
   * gap between tuning and picture.
   */
  const markLocked = useCallback(() => {
    if (frameDeliveredRef.current && phaseRef.current === "live") return;
    const video = videoRef.current;
    if (!video || video.readyState < 2 || (video.videoWidth === 0 && video.currentTime === 0)) return;
    frameDeliveredRef.current = true;
    disarmTimers();
    phaseRef.current = "live";
    setErrorMsg(null);
    setPhase("live");
  }, [disarmTimers]);

  /**
   * A stall after the picture was already rolling. The frozen last frame holds
   * the screen through the grace window; only a stall that outlasts it brings the
   * receiver back as the buffering indicator, and from there it gets the same
   * budget a first frame gets — recover, or hand off to the weak state rather
   * than tune forever over a dead carrier.
   */
  const handleWaiting = useCallback(() => {
    if (phaseRef.current !== "live" || stallTimerRef.current) return;
    stallTimerRef.current = setTimeout(() => {
      stallTimerRef.current = null;
      const video = videoRef.current;
      if (!video || video.paused || phaseRef.current !== "live") return;
      frameDeliveredRef.current = false;
      phaseRef.current = "tuning";
      setPhase("tuning");
      stallTimerRef.current = setTimeout(() => {
        stallTimerRef.current = null;
        if (frameDeliveredRef.current) return;
        console.warn(`[DirectHlsPlayer] Server ${activeIndex + 1} of ${channelName} stalled and did not resume`);
        handleNextServer("The picture stopped arriving on this mirror");
      }, FIRST_FRAME_DEADLINE_MS);
    }, STALL_GRACE_MS);
  }, [activeIndex, channelName, handleNextServer]);

  /**
   * The weak overlay's button. The ladder is wound back to the mirror after the
   * one that ran out — Server 1 when every mirror has had its turn — and the
   * pending host hand-off is cancelled so the retry isn't interrupted mid-flight.
   * With a single mirror there is nowhere else to go, so the host moves on now.
   */
  const handleRetryMirror = useCallback(() => {
    const { onAllServersFailed, onStreamIndexChange } = callbacksRef.current;
    disarmTimers();
    if (streams.length <= 1) {
      onAllServersFailed?.();
      return;
    }
    const nextIdx = (activeIndex + 1) % streams.length;
    if (controlledIndex === undefined) {
      setInternalIndex(nextIdx);
    }
    onStreamIndexChange?.(nextIdx);
  }, [streams, activeIndex, controlledIndex, disarmTimers]);

  // Main stream loader effect — re-runs on every channel or server-mirror
  // switch and synchronously tears the previous instance down first, so no
  // old HLS session or buffered video survives the change.
  useEffect(() => {
    const runId = ++runIdRef.current;

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
    disarmTimers();

    if (!activeStream || isYouTube) {
      // Nothing for the receiver to tune: an empty mirror list gets the host's
      // off-air card, and a YouTube feed paints its own iframe player.
      setPhase("live");
      return;
    }

    setPhase("tuning");
    setErrorMsg(null);
    setLevels([]);
    setSelectedLevel(-1);

    const video = videoRef.current;
    if (!video) return;

    const streamUrl = activeStream.url;
    const maxHeightCap = getDeviceMaxHeight();

    // Arm the delivery deadline for this connection. `markLocked` disarms it once
    // a frame is proven on screen, and a video that is buffered but paused
    // (autoplay blocked until a tap) counts as delivered too, so the timer
    // blames the link only for a picture that genuinely never arrived.
    frameDeliveredRef.current = false;
    deadlineRef.current = setTimeout(() => {
      deadlineRef.current = null;
      if (runIdRef.current !== runId || frameDeliveredRef.current) return;
      const v = videoRef.current;
      if (v && (v.readyState >= 2 || v.currentTime > 0)) {
        markLocked();
        if (frameDeliveredRef.current) return;
      }
      console.warn(
        `[DirectHlsPlayer] Server ${activeIndex + 1} of ${channelName} delivered no frame in ${
          FIRST_FRAME_DEADLINE_MS / 1000
        }s`
      );
      handleNextServer(`Server ${activeIndex + 1} sent no picture in ${FIRST_FRAME_DEADLINE_MS / 1000}s`);
    }, FIRST_FRAME_DEADLINE_MS);

    // Native-Safari-only element handlers. Both are named and removed in this
    // effect's cleanup: anonymous listeners added per run used to stack up, so a
    // single element error could advance the ladder several mirrors at once.
    const onNativeMetadata = () => {
      if (runIdRef.current !== runId) return;
      video.play().then(() => setIsPlaying(true)).catch(() => {});
    };
    const onNativeError = () => {
      if (runIdRef.current !== runId) return;
      handleNextServer("This browser could not play the feed from this mirror");
    };

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
        // Deliberately not the end of tuning: a parsed playlist is a link that
        // answered, not a picture. The receiver comes down on the video
        // element's own output events (see markLocked).
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
            recoverTimerRef.current = setTimeout(() => {
              recoverTimerRef.current = null;
              if (runIdRef.current !== runId) return;
              if (hlsRef.current) {
                handleNextServer("This mirror stopped responding");
              }
            }, 3000);
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            purgeAndDestroyPlayer();
            handleNextServer("Direct stream signal interrupted");
            break;
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native Safari iOS/macOS HLS. Metadata only kicks the element into
      // playing; the overlay still comes down on proven output, same as the
      // hls.js path.
      video.src = streamUrl;
      video.addEventListener("loadedmetadata", onNativeMetadata);
      video.addEventListener("error", onNativeError);
    } else {
      // Nothing on this device can play HLS — the link is not on trial here, so
      // no host hand-off is scheduled. This notice is the destination.
      if (deadlineRef.current) {
        clearTimeout(deadlineRef.current);
        deadlineRef.current = null;
      }
      setErrorMsg("HLS streaming is not supported on this device");
      phaseRef.current = "weak";
      setPhase("weak");
    }

    return () => {
      disarmTimers();
      // Removing handlers that were never added is a no-op, so this runs for
      // every transport rather than only the native one.
      video.removeEventListener("loadedmetadata", onNativeMetadata);
      video.removeEventListener("error", onNativeError);
      purgeAndDestroyPlayer();
    };
    // onStreamIndexChange/onAllServersFailed intentionally read
    // via callbacksRef — see comment above the ref declaration.
  }, [
    channelId,
    activeIndex,
    activeStream,
    isYouTube,
    getDeviceMaxHeight,
    channelName,
    disarmTimers,
    handleNextServer,
    markLocked,
    purgeAndDestroyPlayer,
  ]);

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
            setIsPlaying(true);
            markLocked();
          }}
          onCanPlay={markLocked}
          onTimeUpdate={markLocked}
          onWaiting={handleWaiting}
          onPause={() => setIsPlaying(false)}
        />
      )}

      {/* One overlay, two faces: the receiver hunting for a carrier, then the
          same receiver stopped with a weak signal. Keeping both in a single
          mounted block is what makes the hand-off seamless — the dish element
          survives the change instead of being torn down and remounted, which
          restarted every keyframe and read as a pop. It also never coexists with
          the other face, so no spinner or interim screen is drawn alongside it. */}
      {!isYouTube && phase !== "live" && (
        <div
          className={`absolute inset-0 flex flex-col items-center justify-center p-6 text-center backdrop-blur-sm transition-colors duration-500 ${
            phase === "weak" ? "z-30 bg-black/90" : "z-20 bg-black/70 pointer-events-none"
          }`}
        >
          <SatelliteReceiver tone={phase === "weak" ? "weak" : "locking"} />
          {phase === "weak" ? (
            <>
              <p className="mt-2 text-sm font-black text-white mb-1">
                Satellite Signal Weak <span className="text-amber-400">— Unable to lock onto stream.</span>
              </p>
              {errorMsg && <p className="text-xs text-slate-400 mb-4">{errorMsg}</p>}
              <button
                onClick={handleRetryMirror}
                className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl text-xs flex items-center gap-2 cursor-pointer transition-colors shadow-lg"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Switch to Next Direct Mirror</span>
              </button>
            </>
          ) : (
            <p className="mt-2 text-xs font-bold text-cyan-200 tracking-wide">
              Locking onto satellite signal...
            </p>
          )}
        </div>
      )}

      {/* Top Channel Badge Overlay */}
      <div
        className={`absolute top-3 left-3 right-3 z-20 flex items-center justify-between pointer-events-none transition-opacity duration-300 ${
          controlsVisible || phase === "tuning" ? "opacity-100" : "opacity-0"
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
