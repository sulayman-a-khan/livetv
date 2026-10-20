/**
 * Server-side bridge to soluplay-stream-proxy — the cloud service behind the
 * "24/7 Live Sports" section.
 *
 * This module is the only place in the app that knows the proxy exists, and it is
 * loaded only from route handlers running on the Node runtime. Four rules it keeps:
 *
 *   1. `PROXY_APP_TOKEN` never leaves the server. The browser gets a signed entry
 *      URL, never the credential that mints one. (The proxy's own token secret is
 *      not here either — signing stays inside the proxy.)
 *   2. An Xtream credential is never requested and never held. The proxy's public
 *      projection does not contain one, so this layer cannot accidentally forward it.
 *   3. Minting happens during serialization, not in the player. A card arrives at the
 *      browser already carrying a playable URL, which is what removes the per-play
 *      token round trip the arena player pays before its first frame.
 *   4. Fail closed and stay quiet. Missing config, a refused token, a timeout or a
 *      5xx all produce an empty catalogue — never a page error, and never a log line
 *      containing a URL the proxy handed out.
 */
import { NextResponse } from "next/server";
import { connectToDatabase } from "./db";
import ProxyChannel, { type IProxyChannel } from "@/models/ProxyChannel";

/**
 * A card list is a snapshot of a live proxy, and an entry URL is a capability, so
 * neither may be cached — not by the browser, not by Vercel's edge, not by Cloudflare
 * in front of the app. A cached card would hand an expired URL to a later viewer.
 */
export function proxyJson(body: unknown, init: { status?: number } = {}): NextResponse {
  return NextResponse.json(body, {
    status: init.status ?? 200,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0, s-maxage=0",
      "CDN-Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

/** What the section renders. `playable: false` means "listed, but nothing to watch yet". */
export interface ProxyCard {
  channelKey: string;
  displayName: string;
  category: string;
  logoUrl: string;
  entryUrl: string;
  /** Epoch ms after which the proxy stops accepting `entryUrl`. */
  expiresAt: number;
  playable: boolean;
}

export interface CatalogueResult {
  cards: ProxyCard[];
  /** `proxy` served live data; `mirror` is a fallback listing with no playable URL. */
  source: "proxy" | "mirror" | "none";
  /** Seconds the proxy's playlist token class is good for, for the player's own clock. */
  tokenTtlMs: number;
}

const FETCH_TIMEOUT_MS = 6000;
/** A mirror row this old was not seen on the proxy, so it is probably gone for good. */
const MIRROR_TTL_MS = 1000 * 60 * 60 * 24;
const MAX_CARDS = 24;

function baseOrigin(): URL | null {
  const raw = (process.env.PROXY_BASE_URL ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // A path here would silently drop the proxy's own routes, and a plaintext origin
  // would ship the app token in the clear — both are configuration mistakes, so
  // treat them as "not configured" rather than trying to repair them.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))) {
    return null;
  }
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url;
}

function tokenHeader(): Record<string, string> | null {
  const token = (process.env.PROXY_APP_TOKEN ?? "").trim();
  return token ? { Authorization: `Bearer ${token}` } : null;
}

interface RawChannel {
  channelKey: string;
  displayName: string;
  category: string;
  logoUrl: string;
  entryPath: string;
  entryUrl: string;
  expiresAt: number;
}

function str(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Only accept a play URL that points back at the configured proxy origin. A
 * misconfigured or compromised upstream that tried to aim viewers at another host
 * would otherwise get a trusted first-party card to do it with.
 */
function trustableEntryUrl(raw: string, base: URL): string {
  const value = str(raw, 2048);
  if (!value) return "";
  try {
    return new URL(value).origin === base.origin ? value : "";
  } catch {
    return "";
  }
}

async function callProxy(pathname: string, init: RequestInit): Promise<unknown | null> {
  const base = baseOrigin();
  const auth = tokenHeader();
  if (!base || !auth) return null;
  try {
    const res = await fetch(`${base.origin}${pathname}`, {
      ...init,
      headers: { ...auth, Accept: "application/json", ...(init.headers ?? {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // A failure here can name the proxy host inside the error message, so nothing is logged.
    return null;
  }
}

/** Reads the proxy's catalogue and mints a play URL for every channel in it, in one round trip. */
async function fetchCatalogue(): Promise<{ cards: ProxyCard[]; tokenTtlMs: number } | null> {
  const base = baseOrigin();
  if (!base) return null;
  const body = await callProxy("/app/channels", { method: "GET" });
  const rows = (body as { channels?: unknown } | null)?.channels;
  if (!Array.isArray(rows)) return null;

  const rawTtl = Number((body as { tokenTtlMs?: unknown } | null)?.tokenTtlMs);
  const tokenTtlMs = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 0;
  // A URL with no stated expiry is treated as short-lived, so the player re-mints
  // early rather than playing confidently until the proxy starts refusing it.
  const fallbackExpiry = Date.now() + (tokenTtlMs > 0 ? tokenTtlMs : 60_000);

  const cards: ProxyCard[] = [];
  for (const row of rows.slice(0, MAX_CARDS)) {
    const item = row as Record<string, unknown>;
    const channelKey = str(item.channelKey, 64).toLowerCase();
    const entryUrl = trustableEntryUrl(str(item.entryUrl), base);
    const logo = str(item.logoUrl, 512);
    if (!channelKey || !entryUrl) continue;
    cards.push({
      channelKey,
      displayName: str(item.displayName, 120) || channelKey,
      category: str(item.category, 60),
      // An http logo on an https page is blocked by the browser anyway.
      logoUrl: /^https:\/\//i.test(logo) ? logo : "",
      entryUrl,
      expiresAt: Number.isFinite(Number(item.expiresAt)) ? Number(item.expiresAt) : fallbackExpiry,
      playable: true,
    });
  }
  return { cards, tokenTtlMs };
}

/**
 * Mirrors the listing into the app's own database. Best effort: this is display
 * continuity, not a source of truth, so a Mongo failure is not allowed to cost a
 * viewer their channel list.
 */
async function mirrorRows(cards: ProxyCard[]): Promise<void> {
  const conn = await connectToDatabase();
  if (!conn) return;
  const now = new Date();
  await Promise.all(
    cards.map((card) =>
      ProxyChannel.updateOne(
        { channelKey: card.channelKey },
        {
          $set: {
            channelKey: card.channelKey,
            displayName: card.displayName,
            category: card.category,
            logoUrl: card.logoUrl,
            lastSeenAt: now,
          },
        },
        { upsert: true }
      )
    )
  ).catch(() => {});
}

/** Mirror rows only: enough to draw cards when the proxy itself is not answering. */
type MirrorRow = Pick<IProxyChannel, "channelKey" | "displayName"> & Partial<IProxyChannel>;

async function readMirror(): Promise<ProxyCard[]> {
  const conn = await connectToDatabase();
  if (!conn) return [];
  try {
    const rows = (await ProxyChannel.find({
      lastSeenAt: { $gte: new Date(Date.now() - MIRROR_TTL_MS) },
    })
      .sort({ displayName: 1 })
      .limit(MAX_CARDS)
      .lean()) as unknown as MirrorRow[];
    return rows.map((row) => ({
      channelKey: row.channelKey,
      displayName: row.displayName || row.channelKey,
      category: row.category ?? "",
      logoUrl: row.logoUrl ?? "",
      // Deliberately empty: a signed URL is not a stored thing.
      entryUrl: "",
      expiresAt: 0,
      playable: false,
    }));
  } catch {
    return [];
  }
}

export async function buildProxyCards(): Promise<CatalogueResult> {
  const fresh = await fetchCatalogue();
  if (fresh && fresh.cards.length > 0) {
    // Not awaited: a slow database must not delay the first frame of a live match.
    void mirrorRows(fresh.cards).catch(() => {});
    return { cards: fresh.cards, source: "proxy", tokenTtlMs: fresh.tokenTtlMs };
  }
  if (fresh && fresh.cards.length === 0) {
    // The proxy answered and has nothing serving. That is a real state — showing the
    // stale mirror would offer channels that cannot play.
    return { cards: [], source: "none", tokenTtlMs: fresh.tokenTtlMs };
  }
  const mirror = await readMirror();
  return { cards: mirror, source: mirror.length > 0 ? "mirror" : "none", tokenTtlMs: 0 };
}

/**
 * One channel, one fresh URL. The player calls this when the proxy answers 403 on a
 * playlist it has been polling — i.e. when a session outlives its signing window.
 */
export async function resignEntryUrl(channelKey: string): Promise<{ entryUrl: string; expiresAt: number } | null> {
  const base = baseOrigin();
  const key = str(channelKey, 64).toLowerCase();
  if (!base || !key) return null;
  const body = await callProxy("/app/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelKeys: [key] }),
  });
  const signed = (body as { signed?: unknown } | null)?.signed;
  if (!Array.isArray(signed)) return null;
  for (const row of signed) {
    const item = row as Record<string, unknown>;
    if (str(item.channelKey, 64).toLowerCase() !== key) continue;
    const entryUrl = trustableEntryUrl(str(item.entryUrl), base);
    if (!entryUrl) return null;
    // No stated expiry: assume a minute, so the player re-mints rather than riding
    // a URL that may already be dead.
    const expiresAt = Number.isFinite(Number(item.expiresAt)) ? Number(item.expiresAt) : Date.now() + 60_000;
    return { entryUrl, expiresAt };
  }
  return null;
}

/** True when the app is configured to talk to a proxy at all (so the UI can stay invisible). */
export function proxyConfigured(): boolean {
  return baseOrigin() !== null && tokenHeader() !== null;
}
