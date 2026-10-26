/**
 * The write half of the 24/7 proxy control tier.
 *
 * The read half (`lib/proxyControl.ts`) may look at the box. This module may change it, and
 * it is the only place in the site that holds the box's *write* credential — the same
 * `PROXY_ADMIN_TOKEN` the premium tier already uses to push a source onto the box.
 *
 * Three properties this file has to keep, and each one is a decision rather than a detail:
 *
 *   - **The browser never holds a proxy credential.** A panel asks this server for an action
 *     by name; the server performs it with the token in its own environment and answers with
 *     a projection. A panel that could write to the box itself would need that token in the
 *     page, where it would be readable by anything that can read the page.
 *   - **The action list is closed.** A caller names one of four actions and supplies the one
 *     argument that action needs. It cannot supply a path, a URL, a host or a body: the
 *     request to the box is built here from a table, with an argument that has been
 *     pattern-checked against the box's own key rule. There is no route through this module
 *     that reaches a box path the table does not name.
 *   - **The box's answer is projected, not passed through.** Its admin projections carry a
 *     lane identity and a stream id; its error bodies carry free text that can name a host.
 *     None of that is copied here, so none of it can reach a browser. What travels back is a
 *     machine code and a handful of numbers.
 *
 * The admin secret is checked before the box is asked at all, so an unauthorized caller cannot
 * make this server write on their behalf.
 */
import { isProxyAdminSecretValid } from "./proxyControl";

/**
 * How long the box has to answer an action.
 *
 * The slowest action is the probe: the box opens the upstream itself and waits for a
 * manifest, which it allows twelve seconds for. The site waits longer than that so the box's
 * own answer — rather than a timeout on this side — is what the operator gets to see.
 */
const ACTION_TIMEOUT_MS = 20_000;

/**
 * The largest answer read from the box. A write answer is a handful of rows; the cap keeps a
 * misconfigured base URL from turning a panel into a memory sink.
 */
const MAX_ACTION_BYTES = 64 * 1024;

/**
 * Every action this server performs, and the only ones. The names are the contract between
 * the panel and this module, so they are listed here rather than being derived from whatever
 * the request happens to carry.
 */
export const PROXY_ACTION_NAMES = [
  "refresh_vault",
  "set_provider_active",
  "set_channel_active",
  "probe_channel",
] as const;

export type ProxyActionName = (typeof PROXY_ACTION_NAMES)[number];

interface ActionSpec {
  method: "POST" | "PATCH";
  /** What the caller has to supply for this action to mean anything. */
  needs: Array<"target" | "active">;
  /** The box path. Built only from a validated handle, so it cannot carry a slash or a dot. */
  path: (target: string) => string;
  /** The body to send, when the action has one. */
  body?: (active: boolean) => Record<string, unknown>;
}

/**
 * The table. Every request to the box's write surface comes from one of these four rows, and
 * the path of each is assembled here rather than supplied by the caller.
 */
const ACTIONS: Record<ProxyActionName, ActionSpec> = {
  /** Re-read the vault: the operator edited a row by hand and wants the box to notice now. */
  refresh_vault: {
    method: "POST",
    needs: [],
    path: () => "/admin/refresh",
  },
  /** Take one provider account out of service, or put it back. */
  set_provider_active: {
    method: "PATCH",
    needs: ["target", "active"],
    path: (target) => `/admin/providers/${encodeURIComponent(target)}`,
    body: (active) => ({ active }),
  },
  /** Take one channel out of service, or put it back. */
  set_channel_active: {
    method: "PATCH",
    needs: ["target", "active"],
    path: (target) => `/admin/channels/${encodeURIComponent(target)}`,
    body: (active) => ({ active }),
  },
  /** "Does this credential work?" — the box probes the source through the channel's own lane. */
  probe_channel: {
    method: "POST",
    needs: ["target"],
    path: (target) => `/admin/channels/${encodeURIComponent(target)}/probe`,
  },
};

/**
 * The box's own key rule, copied from `ProxyServer/src/config.ts`: two to sixty-four
 * characters of `[a-z0-9_-]`, starting with a letter or a digit.
 *
 * Matching it here is what makes the handle safe to put in a path — no slash, no dot, no
 * percent sign, nothing that could turn one request into two — and matching it here means
 * the box never has to answer with a validation error for an id the panel could not have
 * produced.
 */
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

/** A handle the box itself would accept, lowercased the way the box lowercases it. */
function handleOf(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return HANDLE_RE.test(raw) ? raw.toLowerCase() : null;
}

/**
 * What an action is allowed to report. Numbers, booleans and two short enums — nothing that
 * can name a host, a credential, a lane or a stream.
 */
export interface ProxyActionDetail {
  /** The row's new state, for the two set-active actions. */
  active?: boolean | null;
  /** The vault's counters, for the refresh. */
  providers?: number | null;
  stored?: number | null;
  resolvable?: number | null;
  /** True when the vault reported a problem. The text stays on the box. */
  hasError?: boolean | null;
  /** How the probe was made: through the channel's own lane, or straight at a cold row. */
  via?: "lane" | "cold" | null;
  /** Whether the probed source answered. */
  probeOk?: boolean | null;
  httpStatus?: number | null;
  levels?: number | null;
  segments?: number | null;
  bytes?: number | null;
  tookMs?: number | null;
}

export interface ProxyActionDeps {
  /** Defaults to `PROXY_BASE_URL`. Never taken from a request. */
  baseUrl?: string;
  /** The box's admin token. Defaults to `PROXY_ADMIN_TOKEN`. Never taken from a request. */
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ProxyActionResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Why this server could not perform the action, in its own words.
 *
 * These are the panel's whole vocabulary for a failure, and they are closed so the panel can
 * say each one in its own language instead of showing the server's English text. The box's
 * own refusal code travels separately, in `result.code`.
 */
export type ProxyActionFailureCode =
  | "unauthorized"
  | "unknown_action"
  | "invalid_target"
  | "invalid_active"
  | "not_configured"
  | "unreachable"
  | "unreadable_answer"
  | "refused"
  | "unknown_row"
  | "refused_credential"
  | "box_error";

/**
 * What a caller may send.
 *
 * The index signature is deliberate: a caller can send anything at all, and every field
 * other than the three below is ignored — never read, never forwarded. Naming them here is
 * what says which three are real.
 */
export interface ProxyActionRequest {
  action?: unknown;
  target?: unknown;
  active?: unknown;
  [key: string]: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The box's own refusal code, when it gave one. Machine-shaped by construction: the codes are
 * snake_case identifiers, and a body that carries anything else is treated as carrying no
 * code at all rather than as carrying text.
 */
function codeOf(body: Record<string, unknown>): string | null {
  const raw = body.code;
  return typeof raw === "string" && /^[a-z0-9_]{1,40}$/.test(raw) ? raw : null;
}

/**
 * The projection of one answer. Each action reports only the fields that answer its own
 * question: the vault's counters for a refresh, the new state for an activation, the
 * manifest's shape for a probe.
 */
function detailOf(action: ProxyActionName, body: Record<string, unknown>): ProxyActionDetail {
  switch (action) {
    case "refresh_vault": {
      const registry = record(body.registry);
      return {
        providers: numOrNull(registry.providers),
        stored: numOrNull(registry.stored),
        resolvable: numOrNull(registry.resolvable),
        hasError: typeof registry.error === "string" && registry.error !== "",
      };
    }
    case "set_provider_active": {
      const provider = record(body.provider);
      return { active: typeof provider.active === "boolean" ? provider.active : null };
    }
    case "set_channel_active": {
      const channel = record(body.channel);
      return { active: typeof channel.active === "boolean" ? channel.active : null };
    }
    case "probe_channel": {
      const probe = record(body.probe);
      const via = body.via === "lane" || body.via === "cold" ? body.via : null;
      return {
        via,
        probeOk: typeof body.ok === "boolean" ? body.ok : null,
        httpStatus: numOrNull(probe.httpStatus),
        levels: numOrNull(probe.levels),
        segments: numOrNull(probe.segments),
        bytes: numOrNull(typeof body.bytes === "number" ? body.bytes : probe.bytes),
        tookMs: numOrNull(probe.tookMs),
      };
    }
  }
}

/**
 * The status the site answers with.
 *
 * A failed probe is not a failed action: the box ran the probe and the source did not
 * answer, which is the answer the operator asked for. Everything else maps onto what the
 * caller can act on — a row that is not there (404), a change the box refused (400), and
 * anything the box could not do at all (502, which includes a refused credential, because
 * that is this server's problem and not the caller's).
 */
function siteStatusFor(
  action: ProxyActionName,
  boxStatus: number,
  body: Record<string, unknown>
): number {
  if (boxStatus >= 200 && boxStatus < 300) return 200;
  if (action === "probe_channel" && boxStatus === 502 && body.via === "cold") return 200;
  if (boxStatus === 400) return 400;
  if (boxStatus === 404) return 404;
  return 502;
}

/**
 * What the panel is told when the box refused. A phrase chosen here, never the box's own
 * text: the box's message can name a host, and the panel has no need for it.
 */
function failurePhrase(boxStatus: number): string {
  if (boxStatus === 400) return "the stream box refused the change";
  if (boxStatus === 404) return "the stream box does not know that row";
  if (boxStatus === 401 || boxStatus === 403) {
    return "the stream box refused this server's credential";
  }
  return "the stream box failed while making the change";
}

/** The same refusal, as one of this server's own codes, so the panel can name it. */
function failureCodeFor(boxStatus: number): ProxyActionFailureCode {
  if (boxStatus === 400) return "refused";
  if (boxStatus === 404) return "unknown_row";
  if (boxStatus === 401 || boxStatus === 403) return "refused_credential";
  return "box_error";
}

/**
 * What this server is missing, by name only.
 *
 * The write surface needs the address and the admin token; without either one the action
 * cannot be performed, and saying which one is missing is the difference between a five
 * minute fix and an hour of guessing.
 */
export function proxyActionConfigProblem(): string | null {
  const missing: string[] = [];
  if (!(process.env.PROXY_BASE_URL || "").trim()) missing.push("PROXY_BASE_URL");
  if (!(process.env.PROXY_ADMIN_TOKEN || "").trim()) missing.push("PROXY_ADMIN_TOKEN");
  return missing.length ? missing.join(", ") : null;
}

/**
 * The whole of the action endpoint: the auth decision, the action decision, and only then
 * the box.
 *
 * The order matters and is the point of this function. An unauthorized call is answered
 * without the box ever being asked, and an unknown action is answered without the box ever
 * being asked either — so neither an unauthorized caller nor a curious one can make this
 * server talk to the box on their behalf.
 */
export async function proxyActionResponse(
  presentedSecret: string | null | undefined,
  request: ProxyActionRequest,
  deps: ProxyActionDeps = {}
): Promise<ProxyActionResponse> {
  if (!isProxyAdminSecretValid(presentedSecret)) {
    return {
      status: 401,
      body: { success: false, code: "unauthorized", error: "Unauthorized: Invalid Admin Secret Key" },
    };
  }

  const name = typeof request.action === "string" ? request.action.trim() : "";
  const spec: ActionSpec | undefined = (ACTIONS as Record<string, ActionSpec | undefined>)[name];
  if (!spec) {
    return {
      status: 400,
      body: {
        success: false,
        code: "unknown_action",
        error: "that action is not one this server performs",
        allowed: [...PROXY_ACTION_NAMES],
      },
    };
  }
  const action = name as ProxyActionName;

  let target: string | null = null;
  if (spec.needs.includes("target")) {
    target = handleOf(request.target);
    if (!target) {
      return {
        status: 400,
        body: {
          success: false,
          code: "invalid_target",
          error: "that action needs a target id, and the id given is not one",
        },
      };
    }
  }

  let active = false;
  if (spec.needs.includes("active")) {
    if (typeof request.active !== "boolean") {
      return {
        status: 400,
        body: {
          success: false,
          code: "invalid_active",
          error: "that action needs active to be true or false",
        },
      };
    }
    active = request.active;
  }

  const baseUrl = (deps.baseUrl ?? process.env.PROXY_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = (deps.token ?? process.env.PROXY_ADMIN_TOKEN ?? "").trim();
  if (!baseUrl || !token) {
    const missing = [!baseUrl ? "PROXY_BASE_URL" : null, !token ? "PROXY_ADMIN_TOKEN" : null].filter(
      (name): name is string => name !== null
    );
    return {
      status: 503,
      body: {
        success: false,
        code: "not_configured",
        error: `the stream box cannot be written to from this server (missing ${missing.join(", ")})`,
      },
    };
  }

  const send = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await send(`${baseUrl}${spec.path(target ?? "")}`, {
      method: spec.method,
      headers: {
        // The box's write credential, in the header the box expects. It never appears in a
        // URL, a body, an answer or a log line.
        authorization: `Bearer ${token}`,
        ...(spec.body ? { "content-type": "application/json" } : {}),
      },
      body: spec.body ? JSON.stringify(spec.body(active)) : undefined,
      signal: AbortSignal.timeout(deps.timeoutMs ?? ACTION_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return {
      status: 502,
      body: { success: false, code: "unreachable", error: "the stream box could not be reached" },
    };
  }

  const declared = Number(res.headers?.get?.("content-length") || "");
  const oversize = Number.isFinite(declared) && declared > MAX_ACTION_BYTES;
  const raw = oversize ? "" : await res.text();
  if (!oversize && raw.length > MAX_ACTION_BYTES) {
    // The body that actually arrived is bigger than the declared one, or there was no
    // declaration at all. Either way it is not an answer this module can read.
    return {
      status: 502,
      body: {
        success: false,
        code: "unreadable_answer",
        error: "the stream box answered with something too large to read",
      },
    };
  }
  let body: Record<string, unknown> = {};
  try {
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // A tunnel that answers in HTML says more about the transport than its body would, and
    // the body could carry back the address that was asked for.
    body = {};
  }

  const code = codeOf(body);
  const detail = detailOf(action, body);
  const status = siteStatusFor(action, res.status, body);
  const changed = res.status >= 200 && res.status < 300;

  const result = {
    action,
    target,
    ok: changed,
    code,
    detail,
  };

  if (status === 200 && (changed || action === "probe_channel")) {
    return { status: 200, body: { success: true, result } };
  }

  return {
    status,
    body: {
      success: false,
      code: failureCodeFor(res.status),
      error: failurePhrase(res.status),
      result,
    },
  };
}
