"use client";

import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { premiumPlayFailureText } from "@/lib/premiumPlayFailure";
import { nextFallbackChannel } from "@/lib/fixtureBoard";

/**
 * The premium tier's own player, deliberately its own file.
 *
 * It shares nothing with the Direct HLS player: no ladder, no mirror ranking, no health probe, no
 * failover. It has one job — keep a short-lived, box-signed playlist playing — and the two things
 * that make that different from a public stream are that the URL expires while the video is still
 * running, and that a refusal here is a decision (the source was never pushed, the box is off, an
 * embed is off-site) rather than a bad mirror to hop away from. So it re-signs on a timer instead
 * of re-ranking, and it stops with a reason instead of trying a next source.
 *
 * The one exception is the match card's own order: a card may name several channels for one match,
 * and the order on it is the priority. When this channel cannot play, the player hands over to the
 * next one on that card rather than sitting on a dead stream — the same handoff the card's chooser
 * would make by hand. The Direct tier is not touched by this: a direct channel is handed over to
 * its own existing watch page, which keeps the failover it already has.
 */

/** Re-sign this long before the URL dies, so a viewer never sees the expiry. */
const REFRESH_LEAD_MS = 30_000;
/** Never spin on a URL that was issued to expire sooner than that. */
const MIN_REFRESH_MS = 5_000;
/** How long the handover note stays on screen before the next channel is opened. */
const HANDOVER_DELAY_MS = 1_400;

type Phase = "loading" | "playing" | "blocked";

interface SignedUrl {
  url: string;
  expiresAt: number;
}

/** One channel of a match card, in the order the admin set. */
export interface PremiumPlayerChannel {
  channelId: string;
  sourceType: "secured" | "direct";
}

/**
 * A refusal that carries its code.
 *
 * The code is what tells a channel-level refusal (this channel is off air, nobody pushed its source)
 * from a box-level one (the box is down, could not sign): the first is worth trying again on another
 * channel, the second would answer the same way for every other channel on the same box.
 */
class Refusal extends Error {
  readonly code: string | null;

  constructor(code: string | null) {
    super(premiumPlayFailureText(code));
    this.name = "Refusal";
    this.code = code;
  }
}

/** The code a caught error carries, or none when the failure was not the server's answer. */
function codeOf(error: unknown): string | null {
  return error instanceof Refusal ? error.code : null;
}

export default function PremiumPlayer({
  channelId,
  channels,
}: {
  channelId: string;
  channels?: PremiumPlayerChannel[];
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  // The card's order is read by the effect below, which must not restart when the page hands over a
  // fresh array; a ref keeps the order readable without making it a dependency of the effect.
  const orderRef = useRef<PremiumPlayerChannel[]>(channels ?? []);
  const [phase, setPhase] = useState<Phase>("loading");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    orderRef.current = channels ?? [];
  }, [channels]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let refreshTimer = 0;
    let recovering = false;

    const sign = async (): Promise<SignedUrl> => {
      let data: { success?: unknown; code?: unknown; entryUrl?: unknown; expiresAt?: unknown } | null =
        null;
      try {
        const res = await fetch(`/api/premium/${encodeURIComponent(channelId)}/play`, {
          cache: "no-store",
        });
        data = await res.json().catch(() => null);
        if (res.ok && data?.success === true && typeof data.entryUrl === "string") {
          return { url: data.entryUrl, expiresAt: Number(data.expiresAt) || 0 };
        }
      } catch {
        // The request never reached this server. That is the network rather than the channel,
        // and it carries no code — so it reads as the generic line instead of blaming the box.
        throw new Refusal(null);
      }
      // What the viewer reads is the Bengali line for the code the server sent. The server's own
      // English sentence stays in the response body for the log; putting it on this screen would
      // answer a Bengali question in the wrong language.
      throw new Refusal(typeof data?.code === "string" ? data.code : null);
    };

    const scheduleRefresh = (expiresAt: number) => {
      window.clearTimeout(refreshTimer);
      if (!expiresAt) return;
      refreshTimer = window.setTimeout(() => void refresh(), Math.max(MIN_REFRESH_MS, expiresAt - Date.now() - REFRESH_LEAD_MS));
    };

    /** Swap in a freshly signed playlist without tearing the buffer down around it. */
    const refresh = async () => {
      if (cancelled) return;
      try {
        const signed = await sign();
        if (cancelled) return;
        if (hlsRef.current) hlsRef.current.loadSource(signed.url);
        else video.src = signed.url;
        scheduleRefresh(signed.expiresAt);
      } catch {
        // A refresh that fails mid-programme is the box being unreachable, not the viewer's
        // fault. The current buffer keeps playing; the next attempt is what reports it.
        scheduleRefresh(Date.now() + MIN_REFRESH_MS * 6);
      }
    };

    /** Stop and say why. The last word, when there is nowhere else to go. */
    const stop = (reason: string) => {
      if (cancelled) return;
      window.clearTimeout(refreshTimer);
      setPhase("blocked");
      setNotice(reason);
    };

    /**
     * The next channel on the card, in the card's own order, that is worth trying.
     *
     * Only the channels *after* this one count: the walk moves forward along the priority the
     * admin set, so a handover can never come back to a channel that already failed.
     */
    const nextCandidate = (code: string | null): PremiumPlayerChannel | null => {
      const order = orderRef.current;
      const at = order.findIndex(
        (entry) => entry.channelId === channelId && entry.sourceType === "secured"
      );
      const remaining =
        at >= 0
          ? order.slice(at + 1)
          : order.filter((entry) => entry.channelId !== channelId);
      return nextFallbackChannel(remaining, code);
    };

    /** Where a channel of either tier is watched, on the address its own tier already answers. */
    const watchPathFor = (entry: PremiumPlayerChannel): string =>
      entry.sourceType === "secured"
        ? `/premium/${encodeURIComponent(entry.channelId)}`
        : `/watch/${encodeURIComponent(entry.channelId)}`;

    /**
     * Give up on this channel — but only after the card's next channel has had its turn.
     *
     * The handover is a real navigation rather than a silent swap, because the two tiers are
     * separate players with separate pages: a direct channel is watched on the watch page it
     * already has, and this file never reaches into that player.
     */
    const fail = (reason: string, code: string | null) => {
      if (cancelled) return;
      const next = nextCandidate(code);
      if (!next) {
        stop(reason);
        return;
      }
      window.clearTimeout(refreshTimer);
      setPhase("blocked");
      setNotice("চ্যানেলটি চালু হয়নি — পরের চ্যানেলে যাওয়া হচ্ছে…");
      window.setTimeout(() => window.location.assign(watchPathFor(next)), HANDOVER_DELAY_MS);
    };

    const attach = (signed: SignedUrl) => {
      scheduleRefresh(signed.expiresAt);
      // hls.js ahead of the native check, in the order the Direct tier's player uses: a Chromium
      // build can answer "maybe" to the HLS type while having no HLS decoder at all, and then the
      // element just sits at readyState 0 with nothing to say about it.
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 60 });
        hlsRef.current = hls;
        hls.attachMedia(video);
        hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(signed.url));
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setPhase("playing");
          void video.play().catch(() => {
            // Autoplay with sound is refused by every browser without a gesture. The controls are
            // there; a viewer presses play and the stream carries on from the live edge.
          });
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !recovering) {
            // The likeliest reason a working premium lane turns into a network error is a token
            // that aged out while the tab was backgrounded. Ask for a fresh one, once, then stop.
            recovering = true;
            void sign()
              .then((fresh) => {
                if (cancelled) return;
                recovering = false;
                hls.loadSource(fresh.url);
                scheduleRefresh(fresh.expiresAt);
              })
              .catch((error: unknown) => {
                fail(
                  error instanceof Error ? error.message : "স্ট্রিম বক্স সাড়া দেয়নি",
                  codeOf(error)
                );
              });
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
          // hls.js's own detail is an English phrase for a log, not for this screen.
          console.warn("[premium] hls error", data.type, data.details);
          fail("স্ট্রিম বন্ধ হয়ে গেছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।", null);
        });
        return;
      }
      if (!video.canPlayType("application/vnd.apple.mpegurl")) {
        // Another channel would not help: this browser cannot play HLS at all.
        stop("এই ব্রাউজারে HLS চালানো যায় না");
        return;
      }
      // Safari's own HLS player. Without these two listeners nothing here ever reports the frame
      // arriving or the box refusing it, so the overlay would read "লোড হচ্ছে" over a live
      // stream — or over a dead one — for as long as the tab stayed open.
      video.src = signed.url;
      video.addEventListener(
        "loadedmetadata",
        () => {
          setPhase("playing");
          void video.play().catch(() => {});
        },
        { once: true }
      );
      video.addEventListener(
        "error",
        () => {
          // The browser's MediaError message is English and names a code, not a reason.
          console.warn("[premium] media error", video.error?.code);
          fail("স্ট্রিম চালু করা যায়নি। কিছুক্ষণ পরে আবার চেষ্টা করুন।", null);
        },
        { once: true }
      );
    };

    void sign()
      .then((signed) => {
        if (cancelled) return;
        attach(signed);
      })
      .catch((error: unknown) => {
        fail(
          error instanceof Error ? error.message : "স্ট্রিম বক্স সাড়া দেয়নি",
          codeOf(error)
        );
      });

    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [channelId]);

  return (
    <div className="relative w-full aspect-video rounded-2xl overflow-hidden bg-black border border-slate-800/80">
      <video ref={videoRef} playsInline controls className="w-full h-full bg-black" />
      {phase !== "playing" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#05080f]/85 px-6 text-center">
          {phase === "loading" ? (
            <span className="text-xs font-bold text-slate-300 animate-pulse">লোড হচ্ছে…</span>
          ) : (
            <span className="text-xs font-bold text-slate-300 max-w-md leading-relaxed">{notice}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
