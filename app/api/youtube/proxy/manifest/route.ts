import { NextRequest, NextResponse } from "next/server";
import { evictManifest } from "@/lib/youtubeResolver";

export const dynamic = "force-dynamic";

/**
 * Same-origin proxy for YouTube's HLS media (googlevideo.com sends no CORS
 * headers, so the browser can't fetch playlists/segments from it directly).
 *
 *   /api/youtube/proxy/manifest?url=<encoded googlevideo URL>
 *
 * Playlist responses (.m3u8) have every URI line rewritten to come back
 * through this route; everything else (TS/fMP4 segments, init sections) is
 * streamed through untouched, honouring Range requests.
 */

const ALLOWED_HOST_RE = /(^|\.)googlevideo\.com$|(^|\.)youtube\.com$/;

function isAllowedTarget(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return null;
    return ALLOWED_HOST_RE.test(parsed.hostname.toLowerCase()) ? parsed : null;
  } catch {
    return null;
  }
}

function proxyUrlFor(absoluteUrl: string): string {
  return `/api/youtube/proxy/manifest?url=${encodeURIComponent(absoluteUrl)}`;
}

/** Rewrites every URI line in an M3U8 playlist to route back through here. */
function rewritePlaylist(text: string, baseUrl: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const absolute = new URL(trimmed, baseUrl).toString();
      return proxyUrlFor(absolute);
    })
    .join("\n");
}

export async function GET(req: NextRequest) {
  const rawUrl = req.nextUrl.searchParams.get("url") || "";
  const target = isAllowedTarget(rawUrl);

  if (!target) {
    return NextResponse.json({ success: false, error: "Invalid proxy target" }, { status: 400 });
  }

  const urlLooksLikePlaylist =
    target.pathname.includes(".m3u8") ||
    target.searchParams.get("mime") === "application/x-mpegURL";

  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        // Forward Range so hls.js byte-range segment loading works.
        ...(req.headers.get("range") ? { Range: req.headers.get("range")! } : {}),
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      cache: "no-store",
    });

    // 403/404 on a playlist means the signed URL expired — drop it from the
    // resolver cache so the next attempt extracts a fresh one.
    if ((upstream.status === 403 || upstream.status === 404) && urlLooksLikePlaylist) {
      evictManifest(target.toString());
      return NextResponse.json(
        { success: false, error: "YouTube manifest expired" },
        { status: 410 }
      );
    }
    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json(
        { success: false, error: `Upstream returned ${upstream.status}` },
        { status: 502 }
      );
    }

    // Segment URLs (/videoplayback/...) have no .m3u8 marker, so trust the
    // upstream content-type as the final word on playlist vs media.
    const upstreamType = upstream.headers.get("content-type") || "";
    const isPlaylist =
      urlLooksLikePlaylist || /mpegurl|m3u8/i.test(upstreamType);

    if (isPlaylist && upstream.status === 200 && !/mp2t|mp4|iso\.segment|octet-stream/i.test(upstreamType)) {
      const text = await upstream.text();
      const rewritten = rewritePlaylist(text, target.toString());
      return new NextResponse(rewritten, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const headers = new Headers({
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Content-Type":
        upstream.headers.get("content-type") || "application/octet-stream",
    });
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) headers.set("Content-Range", contentRange);
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);
    if (upstream.headers.get("accept-ranges")) {
      headers.set("Accept-Ranges", upstream.headers.get("accept-ranges")!);
    }

    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    console.error("[youtube/proxy] fetch failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to fetch YouTube media" },
      { status: 502 }
    );
  }
}
