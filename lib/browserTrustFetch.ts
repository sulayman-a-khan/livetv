/**
 * A fully verified HTTPS fetch that trusts the anchors a desktop browser trusts:
 * Node's bundled roots plus the operating system's certificate store.
 *
 * Node's default store is a snapshot of bundled roots. A root that the OS has
 * current and Node's snapshot does not makes Node report a chain-building
 * failure for a link a browser plays. This transport re-asks with the union of
 * both stores and leaves certificate verification on — `rejectUnauthorized` is
 * never set to false.
 *
 * A server that omits an intermediate stays unrecoverable here: browsers fetch
 * the missing certificate over AIA, and Node exposes no chain after a
 * verification failure, so completing that chain would need an unverified
 * handshake. This transport does not make one.
 */

import { X509Certificate } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import * as tls from "node:tls";

type TlsWithCaStores = typeof tls & {
  getCACertificates?: (store: string) => string[];
};

let anchors: string[] | null = null;

/** Bundled roots plus whatever the OS and Node treat as additional anchors. */
function browserTrustAnchors(): string[] {
  if (anchors) return anchors;

  const seen = new Set<string>();
  const add = (pem: unknown) => {
    if (typeof pem !== "string" || seen.has(pem)) return;
    try {
      new X509Certificate(pem);
      seen.add(pem);
    } catch {
      // A malformed entry in an OS store must not disable the other anchors.
    }
  };

  for (const pem of tls.rootCertificates) add(pem);
  const readStore = (tls as TlsWithCaStores).getCACertificates;
  for (const store of ["system", "extra"]) {
    try {
      for (const pem of readStore?.call(tls, store) ?? []) add(pem);
    } catch {
      // The store is not available on this platform/Node build.
    }
  }

  anchors = Array.from(seen);
  return anchors;
}

function hasNullBody(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

/** Turns an HTTPS response into a Web `Response`, keeping the hop URL for relative resolution. */
function toResponse(res: IncomingMessage, method: string, url: string): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, String(value));
  }

  const status = res.statusCode && res.statusCode >= 200 && res.statusCode <= 599 ? res.statusCode : 500;
  let body: BodyInit | null = null;
  if (method !== "HEAD" && !hasNullBody(status)) {
    body = Readable.toWeb(res) as unknown as BodyInit;
  } else {
    res.resume();
  }

  const response = new Response(body, { status, statusText: res.statusMessage, headers });
  // `safeFetch` follows redirects by hand, and the probe resolves relative
  // playlist URIs against `response.url`; a constructed Response has none.
  Object.defineProperty(response, "url", { value: url });
  return response;
}

/**
 * The transport used by the chain-recovery re-check. It accepts HTTPS only,
 * including every redirect hop `safeFetch` hands it, so a chain failure can
 * never downgrade a fallback to plain HTTP.
 */
export function createBrowserTrustFetch(): typeof fetch {
  const ca = browserTrustAnchors();

  const impl = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return Promise.reject(new TypeError(`Invalid URL: ${raw}`));
    }
    if (parsed.protocol !== "https:") {
      return Promise.reject(new TypeError("The browser-trust re-check only fetches HTTPS URLs"));
    }

    const method = (init.method || "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });

    return new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(
        parsed,
        {
          method,
          headers,
          // Verification stays at its default (on). The only difference from a
          // default request is the wider, browser-equivalent anchor set.
          ca,
          // No pooled connection can carry a different verification setting.
          agent: false,
          signal: init.signal ?? undefined,
        },
        (res) => {
          try {
            resolve(toResponse(res, method, parsed.toString()));
          } catch (err) {
            res.resume();
            reject(err);
          }
        }
      );

      req.on("error", reject);
      if (typeof init.body === "string") req.write(init.body);
      else if (init.body instanceof Uint8Array) req.write(init.body);
      req.end();
    });
  };

  return impl as typeof fetch;
}
