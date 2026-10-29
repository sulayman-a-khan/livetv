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
 *   - **Who may register.** The caller presents the box's own app token — a credential
 *     derived for that one box (see `lib/boxCredentials.ts`), compared in constant time. The
 *     box names itself in a header, and the token has to be that box's token, so a box can
 *     speak for itself and nobody else can speak for it. There is no shared token any
 *     more, and no default: a site with no master secret refuses every registration.
 *   - **Whether the box is admitted.** A registration is refused for a box the site has not
 *     enrolled, and refused for one the site has revoked. Enrolment is the site's decision
 *     (an admin issues a one-time code), and revocation is the site's decision too.
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
import { isPrivateOrInternalHost } from "./ssrfGuard";
import {
  boxSecret,
  deriveBoxToken,
  enrollmentCodeMatches,
  hashEnrollmentCode,
  newEnrollmentCode,
  tokenMatches,
  type BoxTokenPurpose,
} from "./boxCredentials";
import ProxyBoxModel, { type ProxyBoxState } from "../models/ProxyBox";

/** A box the site holds: where it is, and whether the site still admits it. */
export interface BoxRegistration {
  /** The box's own name. A label, not a credential. */
  boxId: string;
  /** The address the site must reach the box at. */
  baseUrl: string;
  /** When the box said so. */
  registeredAt: string;
  /** Whether the site still admits this box. */
  state: ProxyBoxState;
  /** When the box was enrolled. */
  enrolledAt: string | null;
}

/** Where the address the site is using came from. */
export interface ResolvedBoxAddress {
  baseUrl: string;
  source: "environment" | "registered";
  boxId: string | null;
  registeredAt: string | null;
}

/**
 * The box's own token, compared the way every other secret in this project is compared.
 *
 * The token is derived for one box and one purpose, so this is also the check that a
 * caller is the box it claims to be: a token derived for another box does not match, and
 * neither does one derived for another purpose. Fails closed — with no master secret there
 * is no expected token, so nothing can register an address.
 */
export function isBoxTokenValid(
  presented: string | null | undefined,
  purpose: BoxTokenPurpose,
  boxId: string
): boolean {
  const secret = boxSecret();
  if (!secret) return false;
  const expected = deriveBoxToken(secret, purpose, boxId);
  if (!expected) return false;
  return tokenMatches((presented || "").trim(), expected);
}

/**
 * The current box's token for one purpose, or an empty string.
 *
 * This is what the site's own calls to the box use: the token of the box the site is
 * currently talking to. It is empty when there is no admitted box or no master secret, and
 * every caller treats an empty token as "this site cannot talk to a box".
 */
export async function currentBoxToken(purpose: BoxTokenPurpose): Promise<string> {
  const secret = boxSecret();
  if (!secret) return "";
  const box = await readRegisteredBox();
  if (!box) return "";
  return deriveBoxToken(secret, purpose, box.boxId);
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
      reason = `the address could not be reached${describeError(error)}`;
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
  const token = (deps.appToken ?? "").trim();
  if (!token) {
    return { ok: false, reason: "the site holds no token for this box, so no address can be proved to be a box" };
  }
  try {
    const res = await send(`${baseUrl}/app/channels`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? HANDSHAKE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status !== 200) {
      return { ok: false, reason: `the address did not accept this box's token (HTTP ${res.status})` };
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
      reason: `the address could not be asked for its catalogue${describeError(error)}`,
    };
  }
}

/**
 * A short description of a failure, to finish a sentence with.
 *
 * The error's *name* alone says nothing an operator can act on — "TypeError" reports that
 * the machine gave up, not on what — so the message comes with it, flattened to one line and
 * trimmed. Nothing secret can reach here: the only fetch that fails this way is one to an
 * address the caller proposed, and a credential is never allowed in one.
 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const flat = message.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return ` (${flat.slice(0, 120)})`;
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

/**
 * The row the site keeps for a box, in the shape both stores hold.
 *
 * The address changes on every start of a quick tunnel; the enrollment is decided once and
 * lasts until it is revoked. Both live in the same row because they are the same box, and
 * because a box that registers a new address must not lose its enrollment by doing so.
 */
interface BoxRecord {
  boxId: string;
  baseUrl: string;
  /** Empty when the box has never registered an address. */
  registeredAt: string;
  state: ProxyBoxState;
  enrolledAt: string | null;
  revokedAt: string | null;
  enrollmentCodeHash: string;
  enrollmentCodeExpiresAt: string | null;
  enrollmentCodeUsedAt: string | null;
}

/** The part of a row the rest of the site is allowed to see. */
function toRegistration(record: BoxRecord): BoxRegistration {
  return {
    boxId: record.boxId,
    baseUrl: record.baseUrl,
    registeredAt: record.registeredAt,
    state: record.state,
    enrolledAt: record.enrolledAt,
  };
}

/** Reads one stored row back into the shape this module works in. */
function toRecord(row: Record<string, unknown>): BoxRecord {
  const when = (value: unknown): string | null =>
    typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
  const state = row.state;
  return {
    boxId: typeof row.boxId === "string" ? row.boxId.trim() : "",
    baseUrl: typeof row.baseUrl === "string" ? row.baseUrl.trim() : "",
    registeredAt: typeof row.registeredAt === "string" ? row.registeredAt : "",
    state: state === "enrolled" || state === "revoked" ? state : "pending",
    enrolledAt: when(row.enrolledAt),
    revokedAt: when(row.revokedAt),
    enrollmentCodeHash: typeof row.enrollmentCodeHash === "string" ? row.enrollmentCodeHash : "",
    enrollmentCodeExpiresAt: when(row.enrollmentCodeExpiresAt),
    enrollmentCodeUsedAt: when(row.enrollmentCodeUsedAt),
  };
}

function readLocalBoxes(): BoxRecord[] {
  try {
    const file = localBoxFile();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { boxes?: unknown[] })?.boxes)
        ? ((parsed as { boxes: unknown[] }).boxes as unknown[])
        : (parsed as { boxId?: unknown })?.boxId
          ? [parsed]
          : [];
    return (rows as Record<string, unknown>[])
      .map((row) => toRecord(row))
      .filter((row) => row.boxId);
  } catch {
    return [];
  }
}

function writeLocalBoxes(records: BoxRecord[]): void {
  const file = localBoxFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic, for the same reason the other local stores are: a crash mid-write must not
  // leave a truncated file behind.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ boxes: records }, null, 2), "utf8");
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
 *
 * Only an **enrolled** box is returned. A box whose enrollment was asked for but not
 * exchanged has no address and no claim on the site, and a revoked one has had its claim
 * withdrawn — so neither can be the box the site talks to.
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
    const row = await ProxyBoxModel.findOne({ state: "enrolled" })
      .sort({ registeredAt: -1, enrolledAt: -1 })
      .lean();
    if (row) found = toRegistration(toRecord(row as unknown as Record<string, unknown>));
  } else if (!mustUseDatabase()) {
    // A deployment has no file to fall back to, and a local run has no database to read, so
    // this branch is only ever one or the other.
    const enrolled = readLocalBoxes()
      .filter((row) => row.state === "enrolled")
      .sort((a, b) => (b.registeredAt || "").localeCompare(a.registeredAt || ""));
    if (enrolled[0]) found = toRegistration(enrolled[0]);
  }

  cached.box = found;
  cached.readAt = now;
  return found;
}

/** Every box the site knows about, whatever state it is in. */
export async function listBoxes(): Promise<BoxRegistration[]> {
  const conn = await connectToDatabase();
  if (conn) {
    const rows = await ProxyBoxModel.find({}).sort({ boxId: 1 }).lean();
    return rows.map((row) => toRegistration(toRecord(row as unknown as Record<string, unknown>)));
  }
  if (mustUseDatabase()) return [];
  return readLocalBoxes()
    .sort((a, b) => a.boxId.localeCompare(b.boxId))
    .map((row) => toRegistration(row));
}

/** One box by its own name, whatever state it is in. */
export async function readBox(boxId: string): Promise<BoxRegistration | null> {
  const id = (boxId || "").trim();
  if (!id) return null;
  const conn = await connectToDatabase();
  if (conn) {
    const row = await ProxyBoxModel.findOne({ boxId: id }).lean();
    if (!row) return null;
    return toRegistration(toRecord(row as unknown as Record<string, unknown>));
  }
  if (mustUseDatabase()) return null;
  const found = readLocalBoxes().find((row) => row.boxId === id);
  return found ? toRegistration(found) : null;
}

/**
 * The address the site must use to reach the box.
 *
 * An address the operator configured always wins: it was written on purpose, and a
 * discovered address must not quietly override a deliberate one. Only when the site has no
 * configured address does it fall back to what a box has said — which is the case a quick
 * tunnel creates, because its hostname is not knowable before the box starts.
 *
 * A configured address still needs an enrolled box behind it. The site's tokens are derived
 * for one box, so an address with no box the site admits is an address the site cannot use,
 * and saying otherwise would hide a missing enrollment behind a present address.
 *
 * Returns null when there is neither, which every caller reads as "this server has no box".
 */
export async function resolveBoxAddress(): Promise<ResolvedBoxAddress | null> {
  const registered = await readRegisteredBox();
  const configured = (process.env.PROXY_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) {
    if (!registered) return null;
    return {
      baseUrl: configured,
      source: "environment",
      boxId: registered.boxId,
      registeredAt: registered.registeredAt,
    };
  }
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

/**
 * The address the site's credential-free reads ask.
 *
 * `/healthz` asks for no token, so it needs no admission: whether a box is up is a fact
 * about the transport, and an operator wants it before a box is enrolled as much as after.
 * A configured address wins over a registered one, as it does everywhere else.
 *
 * This is the one place the site asks an address it has not admitted, and it asks nothing
 * of it but "are you up".
 */
export async function resolveBoxHealthAddress(): Promise<string | null> {
  const configured = (process.env.PROXY_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const registered = await readRegisteredBox();
  return registered?.baseUrl ? registered.baseUrl.replace(/\/+$/, "") : null;
}

/**
 * What this server is missing before it can reach a box with a credential, by name only.
 *
 * The three are in a chain of dependence, and only the first missing one is named: without
 * a master secret there is nothing to derive a token from, so no box and no address would
 * help; with a secret but no enrolled box there is no box to derive one for; with a box but
 * no address there is nowhere to reach it. Naming a second thing the operator cannot fix
 * yet only costs them time.
 *
 * The address is missing only when there is none at all. A configured address with no box
 * behind it is not a missing address — it is the enrolled box that is missing, and saying
 * otherwise would send the operator to edit a variable that is already set.
 */
export async function boxConfigProblem(): Promise<string | null> {
  if (!boxSecret()) return "PROXY_BOX_SECRET";
  if (!(await readRegisteredBox())) return "an enrolled stream box";
  if (!(await resolveBoxAddress())) return "PROXY_BASE_URL";
  return null;
}

/** Why a registration was refused. The route turns each of these into its own status. */
export type BoxRegistrationFailure = "invalid" | "unverified" | "not_admitted" | "not_persisted";

export type BoxRegistrationResult =
  | { ok: true; box: BoxRegistration }
  | { ok: false; error: string; reason: BoxRegistrationFailure };

/**
 * Accept a registration: check the address, prove the address is a box, and keep it.
 *
 * The order is the point. The address is checked before anything is fetched, the box is
 * proved before anything is stored, and the box has to be one the site admits — so an
 * address that is not a box never becomes the address this site will send a credential to.
 *
 * The caller is already authenticated by the time it gets here: the route checked the
 * box's own token against the one derived for the box it named. What is left is the
 * question the token alone cannot answer — is this address *that* box? — and it is answered
 * by asking the address with the same token.
 */
export async function registerBox(
  input: { baseUrl: string; boxId: string },
  deps: {
    fetchImpl?: typeof fetch;
    now?: () => number;
    allowLoopback?: boolean;
    timeoutMs?: number;
    attempts?: number;
    /** This box's own app token, used to prove the address is this box. */
    appToken?: string;
  } = {}
): Promise<BoxRegistrationResult> {
  const boxId = (input.boxId || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(boxId)) {
    return { ok: false, error: "the registration did not name the box", reason: "invalid" };
  }

  const admitted = await readBox(boxId);
  if (!admitted) {
    return {
      ok: false,
      error: "this box is not enrolled, so the site will not talk to it",
      reason: "not_admitted",
    };
  }
  if (admitted.state !== "enrolled") {
    return {
      ok: false,
      error: `this box is ${admitted.state}, so the site will not talk to it`,
      reason: "not_admitted",
    };
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
  const stored = await persistRegistration(boxId, address.url, registeredAt);
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
 *
 * The row is never created here. A box the site has not enrolled has no row, and making one
 * would let a registration invent its own admission.
 */
async function persistRegistration(
  boxId: string,
  baseUrl: string,
  registeredAt: string
): Promise<BoxRegistration | null> {
  const conn = await connectToDatabase();
  if (conn) {
    const updated = await ProxyBoxModel.findOneAndUpdate(
      { boxId },
      { baseUrl, registeredAt: new Date(registeredAt) },
      { upsert: false, new: true, setDefaultsOnInsert: true }
    ).lean();
    if (!updated) return null;
    return toRegistration(toRecord(updated as unknown as Record<string, unknown>));
  }
  if (mustUseDatabase()) return null;
  const records = readLocalBoxes();
  const found = records.find((row) => row.boxId === boxId);
  if (!found) return null;
  found.baseUrl = baseUrl;
  found.registeredAt = registeredAt;
  writeLocalBoxes(records);
  return toRegistration(found);
}

// --- enrollment ---

/** How long an enrollment code is good for. A day is long enough to hand a box over. */
export const ENROLLMENT_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/** Why an enrollment was refused. */
export type BoxEnrollmentFailure = "invalid" | "refused" | "not_persisted";

/** An enrollment the site issued. The code is in here, and nowhere else. */
export interface BoxEnrollment {
  boxId: string;
  /** The one-time code. Shown to the operator once; only its hash is kept. */
  code: string;
  /** When the code stops working. */
  expiresAt: string;
}

/** The three credentials a box holds. Each is derived for that one box. */
export interface BoxTokens {
  app: string;
  admin: string;
  readonly: string;
}

/** A box's name has to be usable as a DNS-ish label and safe to put in a header. */
function isBoxName(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * Issue an enrollment for a box.
 *
 * This is the site's decision to admit a box, and it is the only place that decision is
 * made. The code it returns is the credential that admits the box: it is handed to the
 * operator once, the box exchanges it for its own tokens, and it is worthless afterwards.
 * Only the code's hash is kept, so a dump of the site's database cannot be replayed as an
 * enrollment.
 *
 * Issuing a code for a box that is already enrolled does not withdraw it — the tokens a box
 * holds are derived, not random, so a box that loses its file gets the same tokens back. A
 * revoked box is different: a fresh enrollment is the way back in, and it is the admin's
 * call to make it.
 */
export async function createEnrollment(
  boxId: string,
  deps: { now?: () => number; ttlMs?: number } = {}
): Promise<
  | { ok: true; enrollment: BoxEnrollment }
  | { ok: false; error: string; reason: BoxEnrollmentFailure }
> {
  const id = (boxId || "").trim();
  if (!isBoxName(id)) {
    return {
      ok: false,
      error: "a box name may hold letters, digits, a dash and an underscore, and nothing else",
      reason: "invalid",
    };
  }

  const clock = deps.now ?? Date.now;
  const now = clock();
  const ttl = deps.ttlMs ?? ENROLLMENT_CODE_TTL_MS;
  const code = newEnrollmentCode();
  const expiresAt = new Date(now + ttl).toISOString();

  const existing = await readBox(id);
  const state: ProxyBoxState = existing?.state === "enrolled" ? "enrolled" : "pending";

  const stored = await persistEnrollment({
    boxId: id,
    baseUrl: existing?.baseUrl || "",
    registeredAt: existing?.registeredAt || "",
    state,
    enrolledAt: existing?.enrolledAt || null,
    revokedAt: null,
    enrollmentCodeHash: hashEnrollmentCode(code),
    enrollmentCodeExpiresAt: expiresAt,
    enrollmentCodeUsedAt: null,
  });
  if (!stored) {
    return {
      ok: false,
      error: "the enrollment could not be stored, so the site would have forgotten it",
      reason: "not_persisted",
    };
  }

  resetBoxRegistryCache();
  return { ok: true, enrollment: { boxId: id, code, expiresAt } };
}

/**
 * Exchange an enrollment code for the box's own tokens.
 *
 * The box presents the code it was given; the site checks it against the hash it kept, in
 * constant time, and only then hands over the three tokens that box will use from now on.
 * The code is spent in the same breath — it is cleared from the row — so a code that was
 * captured cannot be replayed.
 *
 * The tokens are derived from the site's master secret, so nothing secret is stored here:
 * the site's database holds a box's name, its address and the fact that it is enrolled.
 */
export async function redeemEnrollment(
  input: { boxId: string; code: string },
  deps: { now?: () => number } = {}
): Promise<
  | { ok: true; boxId: string; tokens: BoxTokens }
  | { ok: false; error: string; reason: BoxEnrollmentFailure }
> {
  const id = (input.boxId || "").trim();
  const code = (input.code || "").trim();
  if (!isBoxName(id) || !code) {
    return { ok: false, error: "the enrollment did not name the box and its code", reason: "invalid" };
  }

  const secret = boxSecret();
  if (!secret) {
    return {
      ok: false,
      error: "this site holds no master secret, so it cannot issue a box a credential",
      reason: "refused",
    };
  }

  const record = await readBoxRecord(id);
  if (!record) {
    return { ok: false, error: "no enrollment was issued for this box", reason: "refused" };
  }
  if (record.enrollmentCodeUsedAt) {
    return { ok: false, error: "this enrollment code has already been used", reason: "refused" };
  }
  if (record.enrollmentCodeExpiresAt && Date.parse(record.enrollmentCodeExpiresAt) <= (deps.now ?? Date.now)()) {
    return { ok: false, error: "this enrollment code has expired", reason: "refused" };
  }
  if (!enrollmentCodeMatches(code, record.enrollmentCodeHash)) {
    return { ok: false, error: "the enrollment code is not this box's", reason: "refused" };
  }

  const clock = deps.now ?? Date.now;
  const now = new Date(clock()).toISOString();
  record.state = "enrolled";
  record.enrolledAt = record.enrolledAt || now;
  record.revokedAt = null;
  record.enrollmentCodeUsedAt = now;
  record.enrollmentCodeHash = "";
  const stored = await persistEnrollment(record);
  if (!stored) {
    return {
      ok: false,
      error: "the enrollment could not be stored, so the site would have forgotten it",
      reason: "not_persisted",
    };
  }

  resetBoxRegistryCache();
  return {
    ok: true,
    boxId: id,
    tokens: {
      app: deriveBoxToken(secret, "app", id),
      admin: deriveBoxToken(secret, "admin", id),
      readonly: deriveBoxToken(secret, "readonly", id),
    },
  };
}

/**
 * Withdraw a box.
 *
 * The site stops deriving tokens for it, stops accepting its registrations, and stops
 * talking to it — one row, one call. The box keeps the tokens it holds, and they are worth
 * nothing to the site now: a credential the site no longer derives is not a credential the
 * site will accept.
 */
export async function revokeBox(
  boxId: string,
  deps: { now?: () => number } = {}
): Promise<{ ok: true; boxId: string } | { ok: false; error: string; reason: BoxEnrollmentFailure }> {
  const id = (boxId || "").trim();
  if (!isBoxName(id)) {
    return { ok: false, error: "a box name may hold letters, digits, a dash and an underscore", reason: "invalid" };
  }
  const record = await readBoxRecord(id);
  if (!record) {
    return { ok: false, error: "this site knows no box by that name", reason: "refused" };
  }
  record.state = "revoked";
  record.revokedAt = new Date((deps.now ?? Date.now)()).toISOString();
  record.enrollmentCodeHash = "";
  const stored = await persistEnrollment(record);
  if (!stored) {
    return {
      ok: false,
      error: "the revocation could not be stored, so the site would have forgotten it",
      reason: "not_persisted",
    };
  }
  resetBoxRegistryCache();
  return { ok: true, boxId: id };
}

/** One box's stored row, enrollment fields included. */
async function readBoxRecord(boxId: string): Promise<BoxRecord | null> {
  const id = (boxId || "").trim();
  if (!id) return null;
  const conn = await connectToDatabase();
  if (conn) {
    const row = await ProxyBoxModel.findOne({ boxId: id }).lean();
    if (!row) return null;
    return toRecord(row as unknown as Record<string, unknown>);
  }
  if (mustUseDatabase()) return null;
  const found = readLocalBoxes().find((row) => row.boxId === id);
  return found || null;
}

/** Write a box's row, enrollment fields included. */
async function persistEnrollment(record: BoxRecord): Promise<BoxRecord | null> {
  const conn = await connectToDatabase();
  if (conn) {
    const updated = await ProxyBoxModel.findOneAndUpdate(
      { boxId: record.boxId },
      {
        baseUrl: record.baseUrl,
        registeredAt: record.registeredAt ? new Date(record.registeredAt) : null,
        state: record.state,
        enrolledAt: record.enrolledAt ? new Date(record.enrolledAt) : null,
        revokedAt: record.revokedAt ? new Date(record.revokedAt) : null,
        enrollmentCodeHash: record.enrollmentCodeHash,
        enrollmentCodeExpiresAt: record.enrollmentCodeExpiresAt ? new Date(record.enrollmentCodeExpiresAt) : null,
        enrollmentCodeUsedAt: record.enrollmentCodeUsedAt ? new Date(record.enrollmentCodeUsedAt) : null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    if (!updated) return null;
    return toRecord(updated as unknown as Record<string, unknown>);
  }
  if (mustUseDatabase()) return null;
  const records = readLocalBoxes();
  const index = records.findIndex((row) => row.boxId === record.boxId);
  if (index >= 0) records[index] = record;
  else records.push(record);
  writeLocalBoxes(records);
  return record;
}
