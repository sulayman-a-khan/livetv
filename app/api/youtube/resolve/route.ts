import { NextRequest, NextResponse } from "next/server";
import { extractYouTubeVideoId, isYouTubeUrl } from "@/lib/youtube";

export const dynamic = "force-dynamic";

/**
 * Resolves a YouTube URL to a `videoId` for use with YouTube's own IFrame
 * Player API. This never touches YouTube's video CDN or media manifests —
 * it only calls YouTube's official Data API (https://developers.google.com/youtube/v3)
 * to look up which video ID a channel is currently streaming to, exactly
 * like typing the channel's "/live" URL into a browser would resolve to a
 * specific video. Playback itself still goes through YouTube's sanctioned
 * player, ads and all, so nothing here strips YouTube's monetization.
 *
 * Requires a `YOUTUBE_API_KEY` environment variable (a normal YouTube Data
 * API v3 key from https://console.cloud.google.com/apis/credentials).
 */
export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json().catch(() => ({}));

    if (!url || typeof url !== "string" || !isYouTubeUrl(url)) {
      return NextResponse.json({ success: false, error: "Not a YouTube URL" }, { status: 400 });
    }

    // Fast path: the URL already names a specific video (watch?v=, youtu.be/,
    // /live/<id>, /embed/<id>) — nothing to resolve.
    const directId = extractYouTubeVideoId(url);
    if (directId) {
      return NextResponse.json({ success: true, videoId: directId });
    }

    // Otherwise this is a channel-style "live" URL (e.g. a handle's /live
    // page) — ask the Data API which video that currently points to.
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        {
          success: false,
          error:
            "This channel's YouTube URL doesn't include a video ID, and YOUTUBE_API_KEY isn't configured to look up its current live video.",
        },
        { status: 501 }
      );
    }

    const channelRef = extractChannelReference(url);
    if (!channelRef) {
      return NextResponse.json({ success: false, error: "Couldn't identify the YouTube channel" }, { status: 400 });
    }

    const channelId = await resolveChannelId(channelRef, apiKey);
    if (!channelId) {
      return NextResponse.json({ success: false, error: "YouTube channel not found" }, { status: 404 });
    }

    const liveVideoId = await findLiveVideoId(channelId, apiKey);
    if (!liveVideoId) {
      return NextResponse.json({ success: false, error: "Channel isn't live right now" }, { status: 404 });
    }

    return NextResponse.json({ success: true, videoId: liveVideoId });
  } catch (err) {
    console.error("[youtube/resolve] failed:", err);
    return NextResponse.json({ success: false, error: "Failed to resolve YouTube stream" }, { status: 500 });
  }
}

type ChannelRef = { kind: "id"; value: string } | { kind: "handle"; value: string } | { kind: "username"; value: string };

function extractChannelReference(url: string): ChannelRef | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);

    const channelIdx = segments.indexOf("channel");
    if (channelIdx !== -1 && segments[channelIdx + 1]) {
      return { kind: "id", value: segments[channelIdx + 1] };
    }

    const userIdx = segments.indexOf("user");
    if (userIdx !== -1 && segments[userIdx + 1]) {
      return { kind: "username", value: segments[userIdx + 1] };
    }

    const handleSeg = segments.find((s) => s.startsWith("@"));
    if (handleSeg) {
      return { kind: "handle", value: handleSeg };
    }

    return null;
  } catch {
    return null;
  }
}

async function resolveChannelId(ref: ChannelRef, apiKey: string): Promise<string | null> {
  if (ref.kind === "id") return ref.value;

  const param = ref.kind === "handle" ? `forHandle=${encodeURIComponent(ref.value)}` : `forUsername=${encodeURIComponent(ref.value)}`;
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=id&${param}&key=${apiKey}`
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.items?.[0]?.id || null;
}

async function findLiveVideoId(channelId: string, apiKey: string): Promise<string | null> {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${encodeURIComponent(
      channelId
    )}&eventType=live&type=video&key=${apiKey}`
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.items?.[0]?.id?.videoId || null;
}
