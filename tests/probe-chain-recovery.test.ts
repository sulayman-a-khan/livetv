/**
 * Regression tests for the guarded browser-trust re-check in the production
 * probe path (`lib/streamProbe.ts`).
 *
 * The failure this restores: Node's bundled roots are narrower than the store a
 * browser trusts, so a link whose certificate chain only fails against Node's
 * snapshot was filed OFFLINE and hidden. The re-check must ask again with the
 * browser trust store, and report DEGRADED + TLS_CHAIN_UNVERIFIED with the media
 * evidence it obtained, keeping the link active and visible.
 *
 * Everything here is decided by injected transports: the main probe fails the
 * way Node reports an unbuildable chain, and the recovery transport answers
 * with scripted media. No network and no database.
 *
 * Run with `npm run test:probe-chain`.
 */

import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { test } from "node:test";

type NodeModuleWithHook = typeof Module & {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};

// The compiled probe reaches its siblings through the app's `@/` alias, which
// the compiler leaves in the emitted require. Point it at the compiled output.
const nodeModule = Module as NodeModuleWithHook;
const originalResolve = nodeModule._resolveFilename;
const compiledRoot = path.resolve(__dirname, "..");
nodeModule._resolveFilename = function resolveAppAlias(request: string, ...rest: unknown[]) {
  if (request.startsWith("@/")) {
    return originalResolve.call(this, path.resolve(compiledRoot, request.slice(2)), ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};

delete process.env.SITE_ORIGIN;
delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
delete process.env.VERCEL_URL;

const { checkHlsStream } = require("../lib/streamProbe.js") as typeof import("../lib/streamProbe");
const { decideStreamHealth, isUsableViewerLink, probeEstablishesPlayability } =
  require("../lib/streamHealth.js") as typeof import("../lib/streamHealth");

const PUBLIC_IP = "93.184.216.34";
const PLAYLIST_URL = `https://${PUBLIC_IP}/live/channel.m3u8`;
const TS_URL = `https://${PUBLIC_IP}/live/channel.ts`;

/** A transport that fails the way Node reports an unbuildable chain. */
function chainFailure(): Promise<Response> {
  const cause = Object.assign(new Error("unable to verify the first certificate"), {
    code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  });
  return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause }));
}

function otherFailure(code: string): () => Promise<Response> {
  return () => {
    const cause = Object.assign(new Error(code), { code });
    return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause }));
  };
}

function response(
  body: BodyInit | null,
  init: { status?: number; contentType?: string; headers?: Record<string, string> } = {}
): Response {
  const headers = new Headers(init.headers);
  if (init.contentType) headers.set("content-type", init.contentType);
  return new Response(body, { status: init.status ?? 200, headers });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

const PLAYLIST_BODY = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:4",
  "#EXTINF:4,",
  `${TS_URL}?segment=1`,
  "",
].join("\n");

/** A recovery transport that serves one media playlist and one segment. */
function mediaTransport(calls: string[] = []): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    calls.push(`${(init?.method || "GET").toUpperCase()} ${url}`);
    if (url.endsWith(".m3u8")) {
      return response(PLAYLIST_BODY, { contentType: "application/vnd.apple.mpegurl" });
    }
    return response(null, {
      contentType: "video/mp2t",
      headers: { "content-length": "4096" },
    });
  };
  return impl as typeof fetch;
}

test("a verified recovery that gets media keeps the link active and visible", async () => {
  const recoveryCalls: string[] = [];
  const result = await checkHlsStream(PLAYLIST_URL, {
    maxAttempts: 1,
    checkLiveRefresh: false,
    useFfprobe: false,
    transport: { fetchImpl: chainFailure, chainRecoveryFetchImpl: mediaTransport(recoveryCalls) },
  });

  assert.equal(result.status, "DEGRADED");
  assert.equal(result.errorCode, "TLS_CHAIN_UNVERIFIED");
  assert.equal(result.deliveryMisses, 0);
  assert.equal(result.playlistType, "MEDIA");
  assert.equal(result.segmentCount, 1);
  assert.equal(result.httpStatus, 200);
  assert.ok(result.responseTime > 0);
  assert.equal(result.latency, result.responseTime);
  assert.match(result.error || "", /browser trust store verified it and delivered media/i);
  assert.ok(recoveryCalls.length >= 2, "playlist and segment were both fetched");

  assert.equal(probeEstablishesPlayability(result), true);
  const decision = decideStreamHealth("active", 0, null, result);
  assert.equal(decision.status, "active");
  assert.equal(decision.deliveryHidden, false);
  assert.equal(decision.deliveryMisses, 0);
  assert.equal(
    isUsableViewerLink({
      status: decision.status,
      deliveryMisses: decision.deliveryMisses,
      deliveryHidden: decision.deliveryHidden,
    }),
    true
  );
});

test("recovery follows a master playlist to a playable variant", async () => {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url.endsWith("master.m3u8")) {
      return response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nmedia.m3u8\n", {
        contentType: "application/vnd.apple.mpegurl",
      });
    }
    if (url.endsWith("media.m3u8")) {
      return response(PLAYLIST_BODY, { contentType: "application/vnd.apple.mpegurl" });
    }
    return response(null, { contentType: "video/mp2t", headers: { "content-length": "4096" } });
  };

  const result = await checkHlsStream(`https://${PUBLIC_IP}/live/master.m3u8`, {
    maxAttempts: 1,
    checkLiveRefresh: false,
    useFfprobe: false,
    transport: { fetchImpl: chainFailure, chainRecoveryFetchImpl: impl as typeof fetch },
  });

  assert.equal(result.status, "DEGRADED");
  assert.equal(result.errorCode, "TLS_CHAIN_UNVERIFIED");
  // The probe reports the URL's own type; the media evidence came from the variant.
  assert.equal(result.playlistType, "MASTER");
  assert.equal(result.segmentCount, 1);
  assert.equal(result.deliveryMisses, 0);
});

test("a raw .ts feed recovers on transferred bytes", async () => {
  const packet = new Uint8Array(376);
  packet[0] = 0x47;
  packet[188] = 0x47;

  const impl = async (): Promise<Response> =>
    response(packet, { contentType: "video/mp2t" });

  const result = await checkHlsStream(TS_URL, {
    maxAttempts: 1,
    checkLiveRefresh: false,
    useFfprobe: false,
    transport: { fetchImpl: chainFailure, chainRecoveryFetchImpl: impl as typeof fetch },
  });

  assert.equal(result.status, "DEGRADED");
  assert.equal(result.errorCode, "TLS_CHAIN_UNVERIFIED");
  assert.equal(result.playlistType, null);
  assert.equal(result.segmentCount, null);
  assert.equal(result.deliveryMisses, 0);
  assert.equal(probeEstablishesPlayability(result), true);
});

test("an HTTP link is never handed to the browser-trust re-check", async () => {
  let recoveryCalls = 0;
  const recovery = (async () => {
    recoveryCalls += 1;
    return response(PLAYLIST_BODY, { contentType: "application/vnd.apple.mpegurl" });
  }) as typeof fetch;

  const result = await checkHlsStream(`http://${PUBLIC_IP}/live/channel.m3u8`, {
    maxAttempts: 1,
    checkLiveRefresh: false,
    useFfprobe: false,
    transport: { fetchImpl: chainFailure, chainRecoveryFetchImpl: recovery },
  });

  assert.equal(recoveryCalls, 0);
  assert.equal(result.status, "OFFLINE");
  assert.equal(result.errorCode, "TLS_CHAIN_UNVERIFIED");
});

test("a link with stored headers is never handed to the re-check", async () => {
  let recoveryCalls = 0;
  const recovery = (async () => {
    recoveryCalls += 1;
    return response(PLAYLIST_BODY, { contentType: "application/vnd.apple.mpegurl" });
  }) as typeof fetch;

  const result = await checkHlsStream(PLAYLIST_URL, {
    maxAttempts: 1,
    checkLiveRefresh: false,
    useFfprobe: false,
    headers: { Authorization: "Bearer stored-secret" },
    transport: { fetchImpl: chainFailure, chainRecoveryFetchImpl: recovery },
  });

  assert.equal(recoveryCalls, 0);
  assert.equal(result.status, "OFFLINE");
  assert.equal(result.errorCode, "TLS_CHAIN_UNVERIFIED");
});

test("only a chain-building failure is re-checked", async () => {
  let recoveryCalls = 0;
  const recovery = (async () => {
    recoveryCalls += 1;
    return response(PLAYLIST_BODY, { contentType: "application/vnd.apple.mpegurl" });
  }) as typeof fetch;

  const result = await checkHlsStream(PLAYLIST_URL, {
    maxAttempts: 1,
    checkLiveRefresh: false,
    useFfprobe: false,
    transport: { fetchImpl: otherFailure("ECONNRESET"), chainRecoveryFetchImpl: recovery },
  });

  assert.equal(recoveryCalls, 0);
  assert.equal(result.errorCode, "CONNECTION_REFUSED");
});

test("a recovery that gets no media leaves the verdict and hides nothing extra", async () => {
  let recoveryCalls = 0;
  const recovery = (async () => {
    recoveryCalls += 1;
    return response("missing", { status: 404, contentType: "text/plain" });
  }) as typeof fetch;

  const result = await checkHlsStream(PLAYLIST_URL, {
    maxAttempts: 1,
    checkLiveRefresh: false,
    useFfprobe: false,
    transport: { fetchImpl: chainFailure, chainRecoveryFetchImpl: recovery },
  });

  assert.ok(recoveryCalls >= 1);
  assert.equal(result.status, "OFFLINE");
  assert.equal(result.errorCode, "TLS_CHAIN_UNVERIFIED");
  assert.ok(result.deliveryMisses >= 1);
  assert.match(result.error || "", /browser-trust re-check got no media either/i);
});

test("a rate-limited recovery is not treated as media", async () => {
  const recovery = (async () =>
    response("slow down", { status: 429, contentType: "text/plain" })) as typeof fetch;

  const result = await checkHlsStream(PLAYLIST_URL, {
    maxAttempts: 1,
    checkLiveRefresh: false,
    useFfprobe: false,
    transport: { fetchImpl: chainFailure, chainRecoveryFetchImpl: recovery },
  });

  assert.equal(result.status, "OFFLINE");
  assert.equal(result.errorCode, "TLS_CHAIN_UNVERIFIED");
  assert.match(result.error || "", /browser-trust re-check got no media either/i);
});

test("the recovery keeps the SSRF guard on redirects", async () => {
  const calls: string[] = [];
  const recovery = (async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    calls.push(url);
    return response(null, {
      status: 302,
      headers: { location: "https://127.0.0.1/internal.m3u8" },
    });
  }) as typeof fetch;

  const result = await checkHlsStream(PLAYLIST_URL, {
    maxAttempts: 1,
    checkLiveRefresh: false,
    useFfprobe: false,
    transport: { fetchImpl: chainFailure, chainRecoveryFetchImpl: recovery },
  });

  assert.equal(calls.length, 1, "the private hop was refused before it was fetched");
  assert.equal(result.status, "OFFLINE");
  assert.equal(result.errorCode, "TLS_CHAIN_UNVERIFIED");
  assert.match(result.error || "", /browser-trust re-check got no media either/i);
});
