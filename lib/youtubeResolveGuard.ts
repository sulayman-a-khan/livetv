import { NextRequest, NextResponse } from "next/server";
import { extractYouTubeVideoId, isYouTubeUrl } from "@/lib/youtube";

/**
 * The bound in front of the public YouTube resolver.
 *
 * `app/api/youtube/resolve/route.ts` is called by the browser — the Direct HLS player's
 * YouTube branch posts to it — so it cannot be admin-authenticated. What it can do is spend
 * `YOUTUBE_API_KEY` quota: a channel-style URL costs one `channels.list` call plus one
 * `search.list` call, and `search.list` is priced at 100 units, so a single lookup burns
 * 101 units of a 10 000-unit daily allowance.
 *
 * This module is that bound. For each request it answers three questions:
 *
 *   - has this client asked too often in the last minute?      → refuse (429)
 *   - has this instance spent past its hourly ceiling?        → refuse (429)
 *   - did we resolve this URL a moment ago?                    → answer from the cache
 *
 * The cache is what makes the endpoint affordable: a repeat resolution of the same channel
 * costs nothing, so a burst of viewers cannot burn the day's quota. It holds successful
 * answers only, for a couple of minutes, which bounds how long a stream that has just ended
 * can stay visible.
 *
 * Everything here fails open. If the guard cannot make up its mind the request goes through
 * untouched — a bound that took the resolver down with it would be worse than the abuse it
 * prevents.
 */

export interface YouTubeResolveGuardOptions {
  /** Resolutions one client may ask for inside `windowMs`. */
  maxPerClient?: number;
  windowMs?: number;
  /** Resolutions one instance may spend inside `hourMs` — the quota ceiling. */
  maxPerHour?: number;
  hourMs?: number;
  /** How long a successful resolution is reused before it is looked up again. */
  cacheTtlMs?: number;
  now?: () => number;
}

export type YouTubeResolveRefusal = "client-rate" | "hourly-budget";

export type YouTubeResolveDecision =
  | { action: "cached"; status: number; payload: unknown }
  | { action: "resolve" }
  | { action: "refuse"; reason: YouTubeResolveRefusal; status: 429; retryAfterSeconds: number };

export interface YouTubeResolveGuard {
  evaluate(input: { clientKey: string; url: string }): YouTubeResolveDecision;
  remember(url: string, status: number, payload: unknown): void;
  reset(): void;
}

/**
 * The bound below is **per Edge instance**, not per site.
 *
 * The counters live in this guard's own closure, and the guard is created once per isolate,
 * so every isolate gets its own `maxPerClient` window and its own `maxPerHour` budget. The
 * real ceiling is therefore **instances × maxPerHour** — at the defaults, instances × 240
 * per hour — and the per-client window is likewise per instance, not shared.
 *
 * A genuinely global ceiling needs a counter every isolate can read at once. This
 * deployment has no such store (no Redis, no Edge Config, no KV), and the resolver route
 * itself is a protected path, so there is nowhere to put one without changing code the
 * Direct HLS contract pins. The bound is therefore left per instance on purpose, and the
 * true ceiling is written down here rather than left to look like a global one.
 */
const DEFAULTS = {
  maxPerClient: 20,
  windowMs: 60_000,
  maxPerHour: 240,
  hourMs: 3_600_000,
  cacheTtlMs: 120_000,
};

/** How many distinct clients are remembered before the oldest are dropped. */
const MAX_TRACKED_CLIENTS = 4096;

export function createYouTubeResolveGuard(
  options: YouTubeResolveGuardOptions = {}
): YouTubeResolveGuard {
  const maxPerClient = options.maxPerClient ?? DEFAULTS.maxPerClient;
  const windowMs = options.windowMs ?? DEFAULTS.windowMs;
  const maxPerHour = options.maxPerHour ?? DEFAULTS.maxPerHour;
  const hourMs = options.hourMs ?? DEFAULTS.hourMs;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULTS.cacheTtlMs;
  const now = options.now ?? (() => Date.now());

  const clientHits = new Map<string, number[]>();
  const hourHits: number[] = [];
  const cache = new Map<string, { status: number; payload: unknown; expiresAt: number }>();

  const prune = (at: number) => {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= at) cache.delete(key);
    }
    while (hourHits.length > 0 && hourHits[0] <= at - hourMs) hourHits.shift();
    for (const [key, hits] of clientHits) {
      const kept = hits.filter((hit) => hit > at - windowMs);
      if (kept.length === 0) clientHits.delete(key);
      else if (kept.length !== hits.length) clientHits.set(key, kept);
    }
    while (clientHits.size > MAX_TRACKED_CLIENTS) {
      const oldest = clientHits.keys().next();
      if (oldest.done) break;
      clientHits.delete(oldest.value);
    }
  };

  return {
    evaluate({ clientKey, url }) {
      const at = now();
      prune(at);

      const cached = cache.get(url);
      if (cached && cached.expiresAt > at) {
        return { action: "cached", status: cached.status, payload: cached.payload };
      }

      const hits = (clientHits.get(clientKey) ?? []).filter((hit) => hit > at - windowMs);
      if (hits.length >= maxPerClient) {
        const retryAfterSeconds = Math.max(1, Math.ceil((hits[0] + windowMs - at) / 1000));
        clientHits.set(clientKey, hits);
        return { action: "refuse", reason: "client-rate", status: 429, retryAfterSeconds };
      }

      if (hourHits.length >= maxPerHour) {
        const retryAfterSeconds = Math.max(1, Math.ceil((hourHits[0] + hourMs - at) / 1000));
        return { action: "refuse", reason: "hourly-budget", status: 429, retryAfterSeconds };
      }

      clientHits.set(clientKey, [...hits, at]);
      hourHits.push(at);
      return { action: "resolve" };
    },

    remember(url, status, payload) {
      cache.set(url, { status, payload, expiresAt: now() + cacheTtlMs });
    },

    reset() {
      clientHits.clear();
      hourHits.length = 0;
      cache.clear();
    },
  };
}

/**
 * Identifies the caller. `x-forwarded-for` is set by Vercel for every request, and the
 * first entry is the client the edge saw.
 */
export function clientKeyFromHeaders(
  headers: { get(name: string): string | null },
  fallbackIp?: string | null
): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const fallback = fallbackIp?.trim();
  return fallback ? fallback : "unknown";
}

/** The refusal body — the same shape the route uses, so the player reads it unchanged. */
export function refusalPayload(reason: YouTubeResolveRefusal): { success: false; error: string } {
  return {
    success: false,
    error:
      reason === "client-rate"
        ? "Too many YouTube lookups from this device — wait a moment and try again."
        : "This hour's YouTube lookup allowance is used up — try again later.",
  };
}

export type YouTubeResolveHandler = (request: NextRequest) => Promise<Response>;

export interface YouTubeResolveProxyOptions {
  guard: YouTubeResolveGuard;
  resolve: YouTubeResolveHandler;
}

/**
 * The request-level half of the bound: it answers a repeat lookup from the cache, refuses
 * one that is over a limit, and otherwise hands the request to the resolver.
 */
export function createYouTubeResolveProxy({ guard, resolve }: YouTubeResolveProxyOptions) {
  return async function proxyYouTubeResolve(request: NextRequest): Promise<Response> {
    let url: string;
    try {
      // The clone leaves the original request readable, so a pass-through still carries
      // its body.
      const body = await request.clone().json();
      url = typeof body?.url === "string" ? body.url : "";
    } catch {
      return NextResponse.next();
    }

    // A URL that already names a video is answered by the route for free, and anything
    // that is not a YouTube URL is refused by the route itself. Neither spends quota, so
    // neither is this guard's business.
    if (!url || !isYouTubeUrl(url) || extractYouTubeVideoId(url)) {
      return NextResponse.next();
    }

    const decision = guard.evaluate({
      clientKey: clientKeyFromHeaders(request.headers, request.ip),
      url,
    });

    if (decision.action === "cached") {
      return NextResponse.json(decision.payload, {
        status: decision.status,
        headers: { "cache-control": "no-store" },
      });
    }

    if (decision.action === "refuse") {
      return NextResponse.json(refusalPayload(decision.reason), {
        status: decision.status,
        headers: {
          "cache-control": "no-store",
          "retry-after": String(decision.retryAfterSeconds),
        },
      });
    }

    try {
      const headers = new Headers();
      headers.set("content-type", "application/json");
      const upstream = await resolve(
        new NextRequest(request.url, { method: "POST", headers, body: JSON.stringify({ url }) })
      );
      const payload = await upstream.json().catch(() => null);
      const resolved =
        payload && typeof payload === "object" && (payload as { success?: unknown }).success === true;
      if (resolved) guard.remember(url, upstream.status, payload);
      return NextResponse.json(
        payload ?? { success: false, error: "Failed to resolve YouTube stream" },
        { status: upstream.status, headers: { "cache-control": "no-store" } }
      );
    } catch {
      // The bound must never be the reason a channel stops playing.
      return NextResponse.next();
    }
  };
}
