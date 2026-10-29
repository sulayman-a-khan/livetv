/**
 * The premium tier's only door to the box that holds its stream credentials.
 *
 * The decision this file exists to keep: the proxy's vault is the source of truth.
 * A premium row in this database stores an opaque `proxyChannelKey` and nothing else
 * about where its stream comes from, so a leak of this database — or of a viewer-facing
 * route — hands over nothing watchable. The admin pastes a source line into the panel,
 * it is pushed straight to the box and discarded here, and a viewer's playlist URL is
 * signed by the proxy and read by this module on the server, never by a browser.
 *
 * Two environment names, neither of them with a default and neither of them public:
 * `PROXY_ADMIN_TOKEN` (push/retract) and `PROXY_APP_TOKEN` (sign). The box's address is
 * resolved rather than read: it is the one this server's environment names, or the one a
 * box registered because its own address is not knowable in advance (`lib/boxRegistry.ts`).
 * Missing configuration fails closed with the names, never the values.
 *
 * Why this file does not use `lib/safeFetch.ts`: the base URL is not request input, it is
 * the operator's own environment or an address the site proved was a box, and the SSRF
 * guard would — correctly, for URLs a caller supplies — refuse the loopback address the
 * local end-to-end run needs. Nothing here ever builds a URL out of a request body, so the
 * guard's threat is not present on this path.
 */

import { resolveBoxAddress } from "./boxRegistry";

const PROVIDER_LABEL_LIMIT = 60;
const REQUEST_TIMEOUT_MS = 12_000;

export interface ProxySourceInput {
  /** The row's opaque handle: the same string is used as the proxy's provider id. */
  channelKey: string;
  name: string;
  sourceUrl: string;
  userAgent: string;
  referer: string;
}

export type ProxyOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The handle a premium row keeps for its source. Derived from the row id rather than its
 * name, because a renamed channel must not silently become a different stream on the box,
 * and it is lowercase `[a-z0-9_-]` because that is all the proxy's own key rule accepts.
 */
export function proxyKeyForRow(rowId: string): string {
  const slug = rowId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `prem-${slug}`.slice(0, 64);
}

/**
 * The address of the box and the two credentials the site holds for it.
 *
 * The address is resolved rather than read: it may be the one this server's environment
 * names, or the one a box registered because its own address is not knowable in advance (a
 * quick tunnel's hostname is minted at boot). The tokens are the site's own environment and
 * are never anything else.
 */
async function readEnv() {
  const baseUrl = (await resolveBoxAddress())?.baseUrl ?? "";
  const adminToken = (process.env.PROXY_ADMIN_TOKEN || "").trim();
  const appToken = (process.env.PROXY_APP_TOKEN || "").trim();
  return { baseUrl, adminToken, appToken };
}

/** The names of whatever is missing. A viewer-facing path never calls this. */
export async function proxyConfigProblem(): Promise<string | null> {
  const { baseUrl, adminToken, appToken } = await readEnv();
  const missing: string[] = [];
  if (!baseUrl) missing.push("PROXY_BASE_URL");
  if (!adminToken) missing.push("PROXY_ADMIN_TOKEN");
  if (!appToken) missing.push("PROXY_APP_TOKEN");
  return missing.length ? `the stream box is not configured on this server (missing ${missing.join(", ")})` : null;
}

interface ProxyReply {
  status: number;
  json: Record<string, unknown>;
}

async function call(
  path: string,
  token: string,
  init: { method: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown }
): Promise<ProxyReply | { ok: false; error: string }> {
  const { baseUrl } = await readEnv();
  if (!baseUrl) return { ok: false, error: "PROXY_BASE_URL is not set" };
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // A tunnel that answers in HTML (a Cloudflare error page, an auth wall) says more about
      // the transport than its body would, and a body could carry back the URL we sent.
      return { ok: false, error: `the stream box answered ${res.status} with something that is not JSON` };
    }
    return { status: res.status, json };
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown";
    return { ok: false, error: `the stream box could not be reached (${reason})` };
  }
}

/** The proxy's own failure text, trimmed of anything that could name a host or a token. */
function proxyError(json: Record<string, unknown>, fallback: string): string {
  const raw = typeof json.message === "string" ? json.message : fallback;
  const code = typeof json.code === "string" ? json.code : "proxy_error";
  return `${code}: ${raw.slice(0, 200)}`;
}

/**
 * Register (or re-register) one premium source on the box.
 *
 * Idempotent by design: the admin will press this button again after editing a line, and a
 * second registration of the same handle must update rather than fail. The channel is written
 * only after the provider succeeds, because a channel naming an unusable provider would resolve
 * to nothing and the panel would show a stream that cannot play.
 */
export async function pushPremiumSource(
  input: ProxySourceInput
): Promise<ProxyOutcome<{ channelKey: string; pushedAt: string }>> {
  const { adminToken } = await readEnv();
  if (!adminToken) return { ok: false, error: "PROXY_ADMIN_TOKEN is not set" };

  const providerBody = {
    providerId: input.channelKey,
    label: input.name.slice(0, PROVIDER_LABEL_LIMIT),
    kind: "hls",
    sourceUrl: input.sourceUrl,
    userAgent: input.userAgent,
    referer: input.referer,
    maxConnections: 1,
  };

  let provider = await call("/admin/providers", adminToken, { method: "POST", body: providerBody });
  if ("ok" in provider) return provider;
  if (provider.status === 409 || provider.json.code === "provider_exists") {
    provider = await call(`/admin/providers/${encodeURIComponent(input.channelKey)}`, adminToken, {
      method: "PATCH",
      body: providerBody,
    });
    if ("ok" in provider) return provider;
  }
  if (provider.status >= 400 && provider.json.ok === false) {
    return { ok: false, error: proxyError(provider.json, `the box refused the source (${provider.status})`) };
  }

  const channel = await call("/admin/channels", adminToken, {
    method: "POST",
    body: {
      channelKey: input.channelKey,
      displayName: input.name.slice(0, 120),
      category: "premium",
      logoUrl: "",
      active: true,
      providerId: input.channelKey,
      streamId: "",
    },
  });
  if ("ok" in channel) return channel;
  if (channel.status === 409 || channel.json.code === "channel_exists") {
    const patched = await call(`/admin/channels/${encodeURIComponent(input.channelKey)}`, adminToken, {
      method: "PATCH",
      body: { active: true, displayName: input.name.slice(0, 120) },
    });
    if ("ok" in patched) return patched;
    if (patched.status >= 400 && patched.json.ok === false) {
      return { ok: false, error: proxyError(patched.json, `the box refused the channel (${patched.status})`) };
    }
  } else if (channel.status >= 400 && channel.json.ok === false) {
    return { ok: false, error: proxyError(channel.json, `the box refused the channel (${channel.status})`) };
  }

  return { ok: true, value: { channelKey: input.channelKey, pushedAt: new Date().toISOString() } };
}

/**
 * Take a source off the box: the channel first, then the provider that only it used.
 *
 * A 404 counts as success, because after it the box certainly is not serving that handle.
 * Anything else — a refused delete, an unreachable tunnel — is reported as a failure so the
 * caller keeps its handle rather than forgetting a lane that is still open with a credential
 * in it. The provider is deleted best-effort beside a channel that went: an orphan provider
 * holds a credential but streams nothing, which is the lesser of the two.
 */
export async function retractPremiumSource(
  channelKey: string
): Promise<ProxyOutcome<{ channelKey: string }>> {
  const { adminToken } = await readEnv();
  if (!adminToken) return { ok: false, error: "PROXY_ADMIN_TOKEN is not set" };
  const key = encodeURIComponent(channelKey);

  const channel = await call(`/admin/channels/${key}`, adminToken, { method: "DELETE" });
  if ("ok" in channel) return channel;
  if (channel.status >= 400 && channel.status !== 404) {
    return { ok: false, error: proxyError(channel.json, `the box refused to remove the channel (${channel.status})`) };
  }
  await call(`/admin/providers/${key}`, adminToken, { method: "DELETE" });
  return { ok: true, value: { channelKey } };
}

export interface SignedEntry {
  entryUrl: string;
  /** Epoch milliseconds, from the box's own clock, when the URL stops working. */
  expiresAt: number;
}

/**
 * Ask the box for a short-lived, signed entry URL for one premium channel.
 *
 * This is the whole reason the signing secret stays on the server: the answer is a URL that
 * plays for a couple of minutes, and the browser is given that and nothing else. An unknown
 * handle is reported as such rather than retried, because it means the row was never pushed
 * (or was retracted), which is an admin action, not a network fault.
 */
export async function signPremiumEntry(channelKey: string): Promise<ProxyOutcome<SignedEntry>> {
  const { appToken } = await readEnv();
  if (!appToken) return { ok: false, error: "PROXY_APP_TOKEN is not set" };

  const reply = await call("/app/sign", appToken, { method: "POST", body: { channelKeys: [channelKey] } });
  if ("ok" in reply) return reply;
  if (reply.status >= 400 && reply.json.ok === false) {
    return { ok: false, error: proxyError(reply.json, `the box refused to sign (${reply.status})`) };
  }

  const signed = Array.isArray(reply.json.signed) ? reply.json.signed : [];
  const entry = signed.find((row) => (row as { channelKey?: string })?.channelKey === channelKey) as
    | { entryUrl?: string; expiresAt?: number }
    | undefined;
  if (!entry || typeof entry.entryUrl !== "string" || !entry.entryUrl.startsWith("http")) {
    const unknown = Array.isArray(reply.json.unknown) ? (reply.json.unknown as string[]) : [];
    return {
      ok: false,
      error: unknown.includes(channelKey)
        ? "this channel is not registered on the stream box yet"
        : "the stream box returned no playable URL",
    };
  }
  return { ok: true, value: { entryUrl: entry.entryUrl, expiresAt: Number(entry.expiresAt) || 0 } };
}
