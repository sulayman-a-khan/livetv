import { NextRequest, NextResponse } from "next/server";
import { extractYouTubeVideoId, isYouTubeUrl } from "@/lib/youtube";
import { resolveYouTubeHls } from "@/lib/youtubeResolver";

export const dynamic = "force-dynamic";

/**
 * Resolves a YouTube (live) URL to a same-origin HLS playback URL for the
 * app's own HlsPlayer:
 *
 *   1. YouTube URL → video ID (directly, or via the Data API for
 *      channel-style "/live" URLs — requires YOUTUBE_API_KEY).
 *   2. video ID → YouTube's HLS master manifest (lib/youtubeResolver).
 *   3. Returns `/api/youtube/proxy/...` wrapping that manifest, so the
 *      browser fetches playlists and segments same-origin (googlevideo.com
 *      sends no CORS headers).
 */
export async function POST(req: NextRequest) {
  try {
    const { url, refresh } = await req.json().catch(() => ({}));

    if (!url || typeof url !== "string" || !isYouTubeUrl(url)) {
      return NextResponse.json({ success: false, error: "Not a YouTube URL" }, { status: 400 });
    }

    let videoId = extractYouTubeVideoId(url);

    if (!videoId) {
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
      // Channel-style "/live" URL — find the current live video via the Data API.
      videoId = await resolveLiveVideoId(url, apiKey);
      if (!videoId) {
        return NextResponse.json(
          { success: false, error: "Couldn't find a live broadcast for this YouTube channel" },
          { status: 404 }
        );
      }
    }

    const manifestUrl = await resolveYouTubeHls(videoId, refresh === true);
    const playbackUrl = `/api/youtube/proxy/manifest?url=${encodeURIComponent(manifestUrl)}`;

    return NextResponse.json({ success: true, videoId, playbackUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to resolve YouTube HLS stream";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}

/* ---- Channel "/live" URL → current live video ID (YouTube Data API v3) ---- */

type ChannelRef =
  | { kind: "id"; value: string }
  | { kind: "handle"; value: string }
  | { kind: "username"; value: string };

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
    if (handleSeg) return { kind: "handle", value: handleSeg };
    return null;
  } catch {
    return null;
  }
}

async function resolveLiveVideoId(url: string, apiKey: string): Promise<string | null> {
  const ref = extractChannelReference(url);
  if (!ref) return null;

  let channelId = ref.value;
  if (ref.kind !== "id") {
    const param =
      ref.kind === "handle"
        ? `forHandle=${encodeURIComponent(ref.value)}`
        : `forUsername=${encodeURIComponent(ref.value)}`;
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=id&${param}&key=${apiKey}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    channelId = data?.items?.[0]?.id || "";
    if (!channelId) return null;
  }

  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${encodeURIComponent(
      channelId
    )}&eventType=live&type=video&key=${apiKey}`
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.items?.[0]?.id?.videoId || null;
}
