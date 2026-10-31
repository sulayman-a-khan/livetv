/**
 * The panel's vocabulary for the write half of the control tier.
 *
 * The server answers an action in machine words — a code from this server, and the box's own
 * refusal code when there is one — because a code can be acted on and a sentence cannot be
 * matched. This module is where those words become a line an operator can read, so the
 * mapping lives in one place instead of being scattered through the dashboard.
 *
 * It is its own module because it is the part of the panel that can be argued with: every
 * code the server or the box can send has to have a line, and a code that arrives without
 * one still has to read as something rather than as an empty box.
 */

export interface ProxyActionLine {
  tone: "green" | "amber" | "red";
  text: string;
}

/** What each action is called in the panel. */
export function proxyActionLabel(action: string | null | undefined): string {
  switch (action) {
    case "refresh_vault":
      return "Refresh vault";
    case "set_provider_active":
      return "Turn provider on/off";
    case "set_channel_active":
      return "Turn channel on/off";
    case "probe_channel":
      return "Probe channel";
    case "create_provider":
      return "Add provider";
    case "update_provider":
      return "Edit provider";
    case "delete_provider":
      return "Delete provider";
    case "create_channel":
      return "Add channel";
    case "update_channel":
      return "Edit channel";
    case "delete_channel":
      return "Delete channel";
    default:
      return "Action";
  }
}

/** Why this server could not perform the action at all. */
const SITE_FAILURES: Record<string, string> = {
  unauthorized: "The admin key does not match.",
  unknown_action: "This panel does not perform that action.",
  invalid_target: "The id does not follow the box's rule.",
  invalid_active: "On/off was not sent.",
  invalid_argument: "The given values do not follow the box's rule.",
  not_configured: "This server has no key for the box.",
  unreachable: "The box could not be reached.",
  unreadable_answer: "The box's answer could not be read.",
  refused: "The box did not accept the change.",
  unknown_row: "The box has no such row.",
  conflict: "That row already exists on the box, or is still in use.",
  refused_credential: "The box does not accept this server's key.",
  box_error: "The box could not do the action.",
};

/** Why the box itself refused. */
const BOX_FAILURES: Record<string, string> = {
  unknown_channel: "The box has no such channel.",
  unknown_provider: "The box has no such provider.",
  invalid_channelKey: "The channel id does not follow the box's rule.",
  invalid_providerId: "The provider id does not follow the box's rule.",
  invalid_kind: "This provider's kind cannot be changed.",
  invalid_credential: "There is a problem with the credential.",
  unauthorized: "The box does not accept this server's key.",
  admin_disabled: "The admin surface is off on the box.",
  vault_disabled: "The vault is off on the box.",
  vault_failed: "The vault could not be opened.",
  vault_write_failed: "The vault could not be written.",
  registry_unavailable: "The box's registry could not be reached.",
  provider_busy: "Every one of the provider's connections is in use.",
  provider_in_use: "The provider is in use.",
  provider_exists: "That provider already exists on the box.",
  channel_exists: "That channel already exists on the box.",
  duplicate_credential: "That credential already exists.",
  channel_limit: "The box's channel limit is full.",
  too_many_channels: "The box's channel limit is full.",
  invalid_body: "The box could not read the body.",
};

/**
 * The line for a refused action.
 *
 * The box's own code is used when there is one, because it names the reason precisely; the
 * server's code says where the refusal happened when the box gave no reason of its own.
 *
 * The box names the field it refused in its own code — `invalid_streamId`,
 * `invalid_backupStreamIds` — and there are more fields than anyone would want to write a
 * line for. So a code of that shape gets one general line rather than no line at all: the
 * operator learns that a value was refused without learning which of forty rules it broke.
 */
export function proxyActionFailure(
  siteCode: string | null | undefined,
  boxCode?: string | null
): ProxyActionLine {
  const boxText = boxCode ? BOX_FAILURES[boxCode] : undefined;
  if (boxText) return { tone: "red", text: boxText };
  if (boxCode && /^invalid_[a-z]{1,30}$/.test(boxCode)) {
    return { tone: "red", text: "The box did not accept the given value — a field's rule does not match." };
  }
  if (siteCode && SITE_FAILURES[siteCode]) return { tone: "red", text: SITE_FAILURES[siteCode] };
  return { tone: "red", text: "The box did not accept the action." };
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Joins the parts that are actually there, so a line never shows an empty field. */
function parts(values: Array<string | null>): string {
  return values.filter((value): value is string => Boolean(value)).join(" · ");
}

/**
 * The line for an action that ran.
 *
 * A probe that ran and found nothing is not a failure of the panel: the answer the operator
 * asked for is "the source did not answer", which is a different thing from "the panel could
 * not do it" and is shown in amber rather than red.
 */
export function proxyActionSuccess(
  action: string | null | undefined,
  detail: Record<string, unknown> | null | undefined
): ProxyActionLine {
  const data = detail ?? {};

  if (action === "refresh_vault") {
    const providers = number(data.providers);
    const stored = number(data.stored);
    const summary = parts([
      providers === null ? null : `${providers} providers`,
      stored === null ? null : `${stored} stored channels`,
    ]);
    if (data.hasError === true) {
      return {
        tone: "amber",
        text: `Vault refresh done, but the vault has a problem — check the box's log.${summary ? ` (${summary})` : ""}`,
      };
    }
    return { tone: "green", text: `Vault refresh done.${summary ? ` ${summary}.` : ""}` };
  }

  if (action === "set_channel_active" || action === "set_provider_active") {
    const noun = action === "set_channel_active" ? "Channel" : "Provider";
    const state = data.active === true ? "on" : data.active === false ? "off" : "unchanged";
    return { tone: "green", text: `${noun} is now ${state}.` };
  }

  if (action === "create_provider") {
    return { tone: "green", text: "Provider added to the box." };
  }

  if (action === "update_provider") {
    return { tone: "green", text: "Provider details changed." };
  }

  if (action === "delete_provider") {
    return { tone: "green", text: "Provider deleted from the box." };
  }

  if (action === "create_channel") {
    const backups = number(data.backupCount);
    const summary = backups === null ? null : `${backups} backup streams`;
    return {
      tone: "green",
      text: `Channel added to the box.${summary ? ` ${summary}.` : ""}`,
    };
  }

  if (action === "update_channel") {
    const backups = number(data.backupCount);
    const summary = backups === null ? null : `${backups} backup streams`;
    return {
      tone: "green",
      text: `Channel details changed.${summary ? ` ${summary}.` : ""}`,
    };
  }

  if (action === "delete_channel") {
    return { tone: "green", text: "Channel deleted from the box." };
  }

  if (action === "probe_channel") {
    const http = number(data.httpStatus);
    const levels = number(data.levels);
    const segments = number(data.segments);
    const tookMs = number(data.tookMs);
    const summary = parts([
      http === null ? null : `HTTP ${http}`,
      levels === null ? null : `${levels} levels`,
      segments === null ? null : `${segments} segments`,
      tookMs === null ? null : `${(tookMs / 1000).toFixed(1)} seconds`,
    ]);
    if (data.probeOk === true) {
      return { tone: "green", text: `Probe succeeded.${summary ? ` ${summary}.` : ""}` };
    }
    return {
      tone: "amber",
      text: `Probe ran, but the source did not answer.${summary ? ` ${summary}.` : ""}`,
    };
  }

  return { tone: "green", text: "The action was done." };
}
