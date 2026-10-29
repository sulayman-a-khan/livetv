/**
 * The site's half of the box registration: where the site learns that the stream box lives
 * at an address it did not know in advance.
 *
 * A portable box has an address that moves. A quick tunnel's hostname is different every time
 * the box starts, so a site that learned the address once would be pointing at a hostname
 * that no longer answers. The box therefore says where it is when it boots, and this module
 * is where the site keeps that answer.
 *
 * Three decisions are made here, and each of them is a decision about trust:
 *
 *   - **Who may register.** The caller presents `BOX_REGISTER_TOKEN` — a credential that
 *     belongs to a machine, not to a browser. It is compared in constant time, it has no
 *     default, and an unset value refuses every registration. A site with no token has no
 *     way to learn an address, which is the safe direction: an address nobody can register
 *     is an address the site never sends a credential to.
 *   - **What an address may look like.** Only an origin: https, no credential, no query, no
 *     fragment, no path. A deployment refuses a loopback address; a local run allows one,
 *     because that is how the end-to-end proof reaches a box on this machine.
 *   - **Whether the address is our box.** The site reads the address's own `/healthz` — the one
 *     route that asks for no token, reads in-process state and opens no provider session —
 *     and insists on the box's own name in the answer. Then it reads `/app/channels` with the
 *     site's own app token, which only the box that holds that token can answer. This is what
 *     keeps the site's box credentials from ever travelling to a host that is not a box: an
 *     address that cannot answer as one is never stored, and a stored address is the only one
 *     the site will later send a token to. The second step is what makes the first one mean
 *     something — a name in a JSON body costs an impostor nothing to copy, while the shared
 *     secret is the one thing only this box holds.
 *
 * Where the answer is kept follows the rule the rest of the project already uses: MongoDB on
 * a deployment, a file of the tier's own in a local run. Never `data/store.json` — that is
 * the Direct HLS catalogue, and its contents are a release baseline.
 */

import fs from "fs";
import path from "path";
import { connectToDatabase, mustUseDatabase } from "./db";
import { safeEquals } from "./adminAuth";
import { isPrivateOrInternalHost } from "./ssrfGuard";
import ProxyBoxModel from "../models/ProxyBox";

/** A registration the site has accepted. */
export interface BoxRegistration {
  /** The box's own name. A label, not a credential. */
  boxId: string;
  /** The address the site must reach the box at. */
  baseUrl: string;
  /** When the site accepted it. */
  registeredAt: string;
}

/** Where the address the site is using came from. */
export interface ResolvedBoxAddress {
  baseUrl: string;
  source: "environment" | "registered";
  boxId: string | null;
  registeredAt: string | null;
}

/**
 * The site's registration credential, compared the way every other secret in this project is
 * compared. Fails closed: with no `BOX_REGISTER_TOKEN` configured, nothing can register an
 * address, and the site keeps using the address its own environment names.
 */
export function isBoxRegisterTokenValid(presented: string | null | undefined): boolean {
  const expected = (process.env.BOX_REGISTER_TOKEN || "").trim();
  if (!expected) return false;
  const raw = (presented || "").trim();
  if (!raw) return false;
  return safeEquals(raw, expected);
}

/** The longest address that could still be an origin rather than a mistake. */
const MAX_ADDRESS_LENGTH = 300;

/** What the address check decided. */
export interface BoxAddressVerdict {
  ok: boolean;
  /** The normalised origin, when `ok`. */
  url?: string;
  /** Why it was refused, in words an operator can act on. */
  reason?: string;
}

/**
 * True for a host that names this machine: the loopback address, `localhost`, and the
 * name `localhost` wears in its other spellings.
 */
function isLoopbackHost(rawHost: string): boolean {
  const host = (rawHost || "").trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  const quads = host.split(".");
  if (quads.length === 4 && quads.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return Number(quads[0]) === 127;
  }
  return false;
}

/**
 * The shape an address must have before the site will hold it.
 *
 * An origin and nothing else. A path, a query string or a fragment means the caller wanted
 * something other than a box's address, and a credential in the URL means the address would
 * carry a secret into a log line the first time something asked it to print itself.
 *
 * The loopback allowance is the one exception, and it is deliberate: the local end-to-end
 * proof runs the box and the site on this machine, and a deployment has no loopback to reach.
 */
export function checkBoxBaseUrl(
  raw: unknown,
  options: { allowLoopback?: boolean } = {}
): BoxAddressVerdict {
  const allowLoopback = options.allowLoopback ?? !process.env.VERCEL;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return { ok: false, reason: "no address was given" };
  if (trimmed.length > MAX_ADDRESS_LENGTH) {
    return { ok: false, reason: "the address is too long to be an origin" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "the address is not a valid URL" };
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "https" && scheme !== "http") {
    return { ok: false, reason: "the address must use https" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "the address carries a credential, which is never accepted" };
  }
  if (parsed.search) {
    return { ok: false, reason: "the address carries a query string, which is never accepted" };
  }
  if (parsed.hash) {
    return { ok: false, reason: "the address carries a fragment, which is never accepted" };
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    return { ok: false, reason: "the address must be an origin, with no path" };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: "the address names no host" };
  }

  const loopback = isLoopbackHost(parsed.hostname);
  if (scheme === "http" && !loopback) {
    return { ok: false, reason: "the address must use https" };
  }
  if (loopback && !allowLoopback) {
    return { ok: false, reason: "the address names this machine's own loopback, which a deployment will not use" };
  }
  if (!loopback && isPrivateOrInternalHost(parsed.hostname)) {
    return {
      ok: false,
      reason: "the address names a private or internal host, which the site will not send a credential to",
    };
  }
  if (!loopback && !parsed.hostname.includes(".")) {
    return { ok: false, reason: "the address must name a host on a domain" };
  }

  return { ok: true, url: parsed.origin };
}

/** How long the site waits for an address to answer as a box. */
const HANDSHAKE_TIMEOUT_MS = 2_000;

/** How many times it asks, before it concludes the address is not a box. */
const HANDSHAKE_ATTEMPTS = 3;

/** The pause between two attempts. */
const HANDSHAKE_PAUSE_MS = 700;

/** What the handshake concluded. */
export interface BoxHandshake {
  ok: boolean;
  /** Why it was refused, when it was. */
  reason?: string;
  /** The box's own name for itself, when it answered. */
  service?: string | null;
  /** Whether the box says it is healthy. A box can be alive and not ready. */
  boxOk?: boolean;
}

/**
 * The name the box gives itself in its health answer. It is a constant on the box's side
 * (`ProxyServer/src/server.ts`), so an address that answers with any other name is not a box.
 */
export const BOX_SERVICE_NAME = "soluplay-stream-proxy";

/**
 * True for the box's own health answer and nothing else: a body with a boolean `ok` and the
 * box's own name in `service`. The name is the discriminator — it is what makes the answer
 * the box's rather than any other server's.
 */
function isBoxHealthBody(body: unknown): body is { ok: boolean; service: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  if (typeof record.ok !== "boolean") return false;
  return record.service === BOX_SERVICE_NAME;
}

/**
 * Ask an address whether it is our stream box.
 *
 * Two reads, in this order, and the order is the whole point:
 *
 *   1. `/healthz` — the cheapest read the box has. It asks for no token, reads in-process
 *      state and opens no provider session, so asking cannot disturb a stream somebody is
 *      already watching. It proves the address is running our proxy.
 *   2. `/app/channels` with the site's own app token — a read that only the box holding that
 *      token can answer. It proves the address is *this* box and not a copy of one. Without
 *      it, a name in a JSON body would be all an impostor had to copy, and the site would
 *      hand its box credentials to whoever answered.
 *
 * Never throws. A refused address is an answer, not an exception.
 */
export async function verifyBoxHandshake(
  baseUrl: string,
  deps: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    attempts?: number;
    /** The site's own app token. Without it the address cannot be proved and is refused. */
    appToken?: string;
  } = {}
): Promise<BoxHandshake> {
  const send = deps.fetchImpl ?? fetch;
  const attempts = Math.max(1, deps.attempts ?? HANDSHAKE_ATTEMPTS);
  let reason = "the address did not answer";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await send(`${baseUrl}/healthz`, {
        method: "GET",
        signal: AbortSignal.timeout(deps.timeoutMs ?? HANDSHAKE_TIMEOUT_MS),
        cache: "no-store",
      });
      if (res.status !== 200) {
        reason = `the address answered HTTP ${res.status}`;
      } else {
        const text = await res.text();
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }
        if (!isBoxHealthBody(body)) {
          reason = "the address answered, but not as a stream box";
        } else {
          const proof = await proveBoxSecret(withoutTrailingSlash(baseUrl), send, deps);
          if (!proof.ok) {
            reason = proof.reason;
          } else {
            return { ok: true, service: body.service, boxOk: body.ok };
          }
        }
      }
    } catch (error) {
      reason = error instanceof Error ? error.name : "the address could not be reached";
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_PAUSE_MS));
    }
  }

  return { ok: false, reason };
}

/** The address without a trailing slash, so a path can be added to it. */
function withoutTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Prove that the address holds the site's own app token.
 *
 * The read is a list of the box's own catalogue and nothing else; it changes no state and it
 * opens no provider session. The token goes out over the address the caller already proposed,
 * which is the one thing this step is guarding against — so the proof is made *before* the
 * address is stored, never after.
 */
async function proveBoxSecret(
  baseUrl: string,
  send: typeof fetch,
  deps: { timeoutMs?: number; appToken?: string }
): Promise<{ ok: boolean; reason: string }> {
  const token = (deps.appToken ?? process.env.PROXY_APP_TOKEN ?? "").trim();
  if (!token) {
    return { ok: false, reason: "the site holds no app token, so no address can be proved to be a box" };
  }
  try {
    const res = await send(`${baseUrl}/app/channels`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? HANDSHAKE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status !== 200) {
      return { ok: false, reason: `the address did not accept the site's app token (HTTP ${res.status})` };
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { ok: false, reason: "the address accepted the app token but did not answer as a box" };
    }
    if ((body as Record<string, unknown>).ok !== true) {
      return { ok: false, reason: "the address accepted the app token but did not answer as a box" };
    }
    return { ok: true, reason: "" };
  } catch (error) {
    return {
      ok: false,
      reason: `the address could not be asked for its catalogue: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Where a local run keeps the registration.
 *
 * The default is the tier's own file, beside the other local stores. `BOX_REGISTRY_FILE`
 * moves it, so a test or a proof can work in a directory of its own instead of writing
 * into the project's data.
 */
function localBoxFile(): string {
  const configured = (process.env.BOX_REGISTRY_FILE || "").trim();
  if (configured) return path.resolve(configured);
  return path.join(process.cwd(), "data", "proxy-box.json");
}

function readLocalBox(): BoxRegistration | null {
  try {
    const file = localBoxFile();
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BoxRegistration>;
    const boxId = typeof parsed.boxId === "string" ? parsed.boxId.trim() : "";
    const baseUrl = typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "";
    if (!boxId || !baseUrl) return null;
    const registeredAt =
      typeof parsed.registeredAt === "string" && !Number.isNaN(Date.parse(parsed.registeredAt))
        ? new Date(parsed.registeredAt).toISOString()
        : new Date(0).toISOString();
    return { boxId, baseUrl, registeredAt };
  } catch {
    return null;
  }
}

function writeLocalBox(box: BoxRegistration): void {
  const file = localBoxFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic, for the same reason the other local stores are: a crash mid-write must not
  // leave a truncated file behind.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(box, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** How long a read of the registry is reused before it is read again. */
const REGISTRY_CACHE_MS = 15_000;

interface RegistrySlot {
  box: BoxRegistration | null;
  readAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __soluplay_box_registry: RegistrySlot | undefined;
}

function slot(): RegistrySlot {
  globalThis.__soluplay_box_registry ??= { box: null, readAt: 0 };
  return globalThis.__soluplay_box_registry;
}

/** Forgets the cached registration, so the next read goes to the store again. */
export function resetBoxRegistryCache(): void {
  globalThis.__soluplay_box_registry = { box: null, readAt: 0 };
}

/**
 * The newest registration the site holds, or null when it holds none.
 *
 * Read from MongoDB on a deployment and from the tier's own file in a local run, exactly as
 * the rest of the project's stores do. A read is never a failure: when the store cannot be
 * read the site keeps using the address it already had.
 */
export async function readRegisteredBox(
  deps: { now?: () => number } = {}
): Promise<BoxRegistration | null> {
  const clock = deps.now ?? Date.now;
  const now = clock();
  const cached = slot();
  if (cached.box && now - cached.readAt < REGISTRY_CACHE_MS) return cached.box;

  let found: BoxRegistration | null = null;
  const conn = await connectToDatabase();
  if (conn) {
    const row = await ProxyBoxModel.findOne().sort({ registeredAt: -1 }).lean();
    if (row) {
      found = {
        boxId: row.boxId,
        baseUrl: row.baseUrl,
        registeredAt: new Date(row.registeredAt).toISOString(),
      };
    }
  } else if (!mustUseDatabase()) {
    // A deployment has no file to fall back to, and a local run has no database to read, so
    // this branch is only ever one or the other.
    found = readLocalBox();
  }

  cached.box = found;
  cached.readAt = now;
  return found;
}

/**
 * The address the site must use to reach the box.
 *
 * An address the operator configured always wins: it was written on purpose, and a
 * discovered address must not quietly override a deliberate one. Only when the site has no
 * configured address does it fall back to what a box has said — which is the case a quick
 * tunnel creates, because its hostname is not knowable before the box starts.
 *
 * Returns null when neither exists, which every caller reads as "this server has no box".
 */
export async function resolveBoxAddress(): Promise<ResolvedBoxAddress | null> {
  const configured = (process.env.PROXY_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) {
    return { baseUrl: configured, source: "environment", boxId: null, registeredAt: null };
  }
  const registered = await readRegisteredBox();
  if (registered?.baseUrl) {
    return {
      baseUrl: registered.baseUrl,
      source: "registered",
      boxId: registered.boxId,
      registeredAt: registered.registeredAt,
    };
  }
  return null;
}

/** Why a registration was refused. The route turns each of these into its own status. */
export type BoxRegistrationFailure = "invalid" | "unverified" | "not_persisted";

export type BoxRegistrationResult =
  | { ok: true; box: BoxRegistration }
  | { ok: false; error: string; reason: BoxRegistrationFailure };

/**
 * Accept a registration: check the address, prove the address is a box, and keep it.
 *
 * The order is the point. The address is checked before anything is fetched, and the box is
 * proved before anything is stored, so an address that is not a box never becomes the
 * address this site will send a credential to.
 */
export async function registerBox(
  input: { baseUrl: string; boxId: string },
  deps: {
    fetchImpl?: typeof fetch;
    now?: () => number;
    allowLoopback?: boolean;
    timeoutMs?: number;
    attempts?: number;
    /** The site's own app token, used to prove the address is this box. */
    appToken?: string;
  } = {}
): Promise<BoxRegistrationResult> {
  const boxId = (input.boxId || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(boxId)) {
    return { ok: false, error: "the registration did not name the box", reason: "invalid" };
  }

  const address = checkBoxBaseUrl(input.baseUrl, { allowLoopback: deps.allowLoopback });
  if (!address.ok || !address.url) {
    return { ok: false, error: address.reason || "the address is not one the site accepts", reason: "invalid" };
  }

  const handshake = await verifyBoxHandshake(address.url, deps);
  if (!handshake.ok) {
    return { ok: false, error: handshake.reason || "the address did not answer as a box", reason: "unverified" };
  }

  const clock = deps.now ?? Date.now;
  const registeredAt = new Date(clock()).toISOString();
  const stored = await persistBox({ boxId, baseUrl: address.url, registeredAt });
  if (!stored) {
    return {
      ok: false,
      error: "the registration could not be stored, so the site would have forgotten it",
      reason: "not_persisted",
    };
  }

  // The answer this process is about to give must not lag behind the one it just accepted.
  slot().box = stored;
  slot().readAt = clock();

  return { ok: true, box: stored };
}

/**
 * Keep the registration where the rest of the project keeps its rows.
 *
 * A deployment has nowhere else to keep it: a registration that cannot be persisted would be
 * answered as accepted and then forgotten, and the site would go on using an address that no
 * longer exists — which is the one outcome worse than refusing.
 */
async function persistBox(box: BoxRegistration): Promise<BoxRegistration | null> {
  const conn = await connectToDatabase();
  if (conn) {
    const updated = await ProxyBoxModel.findOneAndUpdate(
      { boxId: box.boxId },
      { baseUrl: box.baseUrl, registeredAt: new Date(box.registeredAt) },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    if (!updated) return null;
    return {
      boxId: updated.boxId,
      baseUrl: updated.baseUrl,
      registeredAt: new Date(updated.registeredAt).toISOString(),
    };
  }
  if (mustUseDatabase()) return null;
  writeLocalBox(box);
  return box;
}
