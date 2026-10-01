import { NextRequest } from "next/server";

/**
 * MPEG-TS / Xtream passthrough proxy with SEAMLESS server-side auto-reconnect.
 *
 * The upstream IPTV provider drops the connection roughly every 17-18s (and
 * occasionally returns a 401/403 when its session token expires). If we let
 * that drop propagate, the browser sees end-of-stream and shows a black frame
 * while mpegts.js rebuilds. Instead, this proxy keeps ONE client response open
 * (`video/mp2t`, chunked) and internally re-dials the provider whenever the
 * upstream feed ends, resets, or throws — piping the fresh chunks into the same
 * response so the player never notices the drop.
 *
 * Flow:
 *   browser (mpegts.js) -> /api/stream?id=<streamId>  (or ?url=<absolute .ts>)
 *                       -> http://toxicplay1.com/live/<user>/<pass>/<id>.ts
 *
 * The client response is only closed when: the client itself goes away, the
 * upstream stays dead for MAX_RECONNECT_ATTEMPTS consecutive tries, or the
 * platform ends the function (maxDuration) — in the last case the player's own
 * auto-reconnect immediately re-opens a fresh /api/stream and resumes.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Live feeds are endless; cap one proxied connection so a stuck upstream can't
// pin a serverless instance forever. Raise this if your Vercel plan allows it
// (Pro/Fluid) to make client-visible reconnects even rarer.
export const maxDuration = 60;

/* ------------------------------------------------------------------ *
 * Hardcoded Xtream test credentials (per request — for testing ease)
 * ------------------------------------------------------------------ */
const XTREAM_HOST = "http://toxicplay1.com";
const XTREAM_USER = "1Aoen7elp5";
const XTREAM_PASS = "IgMJ60tmAa";

/** Headers the provider expects from an IPTV player. */
const UPSTREAM_HEADERS: Record<string, string> = {
  "User-Agent": "IPTVSmartersPlayer",
  Accept: "*/*",
  Connection: "keep-alive",
};

/* ---- Reconnect tuning ---- */
/** Quick retries to establish the very first connection before we 502. */
const INITIAL_CONNECT_ATTEMPTS = 3;
/** Consecutive data-less reconnects before we give up and close. */
const MAX_RECONNECT_ATTEMPTS = 40;
const RECONNECT_BASE_DELAY_MS = 300;
const RECONNECT_MAX_DELAY_MS = 3000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function corsHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type",
    ...extra,
  };
}

/** The exact response headers requested for the proxied transport stream. */
function streamResponseHeaders(): Record<string, string> {
  return corsHeaders({
    "Content-Type": "video/mp2t",
    "Transfer-Encoding": "chunked",
    Connection: "keep-alive",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    // Disable any intermediary buffering so chunks flush to the player at once.
    "X-Accel-Buffering": "no",
  });
}

/** Builds the canonical Xtream live transport-stream URL for a stream id. */
function buildXtreamTsUrl(streamId: string): string {
  return `${XTREAM_HOST}/live/${XTREAM_USER}/${XTREAM_PASS}/${streamId}.ts`;
}

/**
 * If someone stored a toxicplay1.com link WITHOUT credentials
 * (e.g. http://toxicplay1.com/live/1234.ts), inject the hardcoded ones so it
 * still plays. Fully-qualified or non-Xtream URLs are returned untouched.
 */
function applyXtreamDefaults(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const xhost = new URL(XTREAM_HOST).host;
    if (u.host.toLowerCase() === xhost.toLowerCase()) {
      const parts = u.pathname.split("/").filter(Boolean); // e.g. ["live","1234.ts"]
      if (parts.length === 2 && parts[0].toLowerCase() === "live") {
        return `${XTREAM_HOST}/live/${XTREAM_USER}/${XTREAM_PASS}/${parts[1]}`;
      }
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

/** Resolves the upstream target from `?url=` (absolute feed) or `?id=`
 *  (Xtream stream id, or an absolute URL passed as id). */
function resolveTarget(req: NextRequest): string | null {
  const params = req.nextUrl.searchParams;
  const urlParam = (params.get("url") || "").trim();
  const idParam = (params.get("id") || "").trim();

  if (urlParam && /^https?:\/\//i.test(urlParam)) return applyXtreamDefaults(urlParam);
  if (idParam) {
    if (/^https?:\/\//i.test(idParam)) return applyXtreamDefaults(idParam);
    // Bare Xtream stream id -> build the credentialed .ts URL.
    if (/^[A-Za-z0-9_-]+$/.test(idParam)) return buildXtreamTsUrl(idParam);
  }
  return null;
}

/** Opens one upstream connection and returns its body reader. Throws on any
 *  non-2xx/206 (including 401/403 session errors) so the caller reconnects. */
async function openUpstream(
  target: string,
  signal: AbortSignal
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await fetch(target, { headers: UPSTREAM_HEADERS, signal });

  if (res.status === 401 || res.status === 403 || !res.ok || !res.body) {
    // Drain/cancel the rejected body so the socket is released.
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new Error(`upstream ${res.status}`);
  }
  return res.body.getReader();
}

function badRequest(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: corsHeaders({ "Content-Type": "application/json" }),
  });
}

/** Preflight for cross-origin players. */
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function HEAD(req: NextRequest) {
  const target = resolveTarget(req);
  if (!target) return badRequest("A valid `id` (Xtream stream id) or `url` query parameter is required");
  return new Response(null, { status: 200, headers: streamResponseHeaders() });
}

export async function GET(req: NextRequest) {
  const target = resolveTarget(req);
  if (!target) return badRequest("A valid `id` (Xtream stream id) or `url` query parameter is required");

  // One controller for every upstream attempt; aborted when the client leaves.
  const upstreamController = new AbortController();
  const upstreamSignal = upstreamController.signal;

  // ---- Establish the first connection (with a few quick retries) ----
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  for (let i = 0; i < INITIAL_CONNECT_ATTEMPTS && !reader; i++) {
    try {
      reader = await openUpstream(target, upstreamSignal);
    } catch {
      if (i < INITIAL_CONNECT_ATTEMPTS - 1) await sleep(300 * (i + 1));
    }
  }
  if (!reader) {
    upstreamController.abort();
    return new Response(JSON.stringify({ error: "Upstream connection failed" }), {
      status: 502,
      headers: corsHeaders({ "Content-Type": "application/json" }),
    });
  }

  let stopped = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = reader;

  const onClientAbort = () => {
    stopped = true;
    try {
      activeReader?.cancel().catch(() => {});
    } catch {
      /* ignore */
    }
    upstreamController.abort();
  };
  req.signal.addEventListener("abort", onClientAbort);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let failures = 0; // consecutive data-less reconnect cycles

      const closeReader = () => {
        const r = activeReader;
        activeReader = null;
        if (r) {
          try {
            r.cancel().catch(() => {});
          } catch {
            /* ignore */
          }
        }
      };

      while (!stopped) {
        // ---- 1) Drain the current upstream connection ----
        let gotData = false;
        try {
          const r = activeReader;
          if (r) {
            // eslint-disable-next-line no-constant-condition
            while (true) {
              if (stopped) break;
              const { done, value } = await r.read();
              if (done) break; // provider dropped the feed
              if (value && value.length) {
                gotData = true;
                controller.enqueue(value);
              }
            }
          }
        } catch {
          // Upstream reset / aborted mid-read — fall through and reconnect.
          if (stopped) break;
        }
        if (stopped) break;

        closeReader();
        if (gotData) failures = 0;

        // ---- 2) Seamlessly re-dial the provider, keeping THIS response open ----
        let reconnected = false;
        while (!stopped && failures <= MAX_RECONNECT_ATTEMPTS) {
          failures += 1;
          const delay = Math.min(RECONNECT_BASE_DELAY_MS * failures, RECONNECT_MAX_DELAY_MS);
          await sleep(delay);
          if (stopped) break;
          try {
            activeReader = await openUpstream(target, upstreamSignal);
            reconnected = true;
            break;
          } catch {
            if (stopped) break;
            // 401/403/reset — loop retries with growing backoff (fresh session).
          }
        }
        if (!reconnected) break; // upstream stayed dead — let the client retry
      }

      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
    cancel() {
      stopped = true;
      try {
        activeReader?.cancel().catch(() => {});
      } catch {
        /* ignore */
      }
      activeReader = null;
      upstreamController.abort();
      req.signal.removeEventListener("abort", onClientAbort);
    },
  });

  return new Response(stream, { status: 200, headers: streamResponseHeaders() });
}
