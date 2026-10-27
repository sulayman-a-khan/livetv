import { NextRequest, NextResponse } from "next/server";
import { POST as resolveYouTubeStream } from "@/app/api/youtube/resolve/route";
import { createYouTubeResolveGuard, createYouTubeResolveProxy } from "@/lib/youtubeResolveGuard";

/**
 * The bound in front of the public YouTube resolver.
 *
 * Only `/api/youtube/resolve` is matched, and only a POST to it is bounded, so no other
 * part of the app is touched. The resolver itself is left exactly as it is — this decides
 * whether a request is answered from a recent result, refused, or passed on to it.
 */
export const config = { matcher: "/api/youtube/resolve" };

const proxy = createYouTubeResolveProxy({
  guard: createYouTubeResolveGuard(),
  resolve: resolveYouTubeStream,
});

export async function middleware(request: NextRequest): Promise<Response> {
  if (request.method !== "POST") return NextResponse.next();
  return proxy(request);
}
