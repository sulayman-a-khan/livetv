/**
 * The panel's Bengali vocabulary for the write half of the control tier.
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
      return "ভল্ট রিফ্রেশ";
    case "set_provider_active":
      return "প্রোভাইডারের অবস্থা বদল";
    case "set_channel_active":
      return "চ্যানেলের অবস্থা বদল";
    case "probe_channel":
      return "চ্যানেল যাচাই";
    default:
      return "কাজ";
  }
}

/** Why this server could not perform the action at all. */
const SITE_FAILURES: Record<string, string> = {
  unauthorized: "অ্যাডমিন কী মিলছে না।",
  unknown_action: "এই কাজটি প্যানেল করে না।",
  invalid_target: "আইডিটি বাক্সের নিয়ম মেনে চলছে না।",
  invalid_active: "চালু না বন্ধ, তা পাঠানো হয়নি।",
  not_configured: "এই সার্ভারে বাক্সের লেখার কী নেই।",
  unreachable: "বাক্সে পৌঁছানো যায়নি।",
  unreadable_answer: "বাক্সের উত্তর পড়া যায়নি।",
  refused: "বাক্স পরিবর্তনটি গ্রহণ করেনি।",
  unknown_row: "বাক্সে এই সারি নেই।",
  refused_credential: "বাক্স এই সার্ভারের কী মেনে নিচ্ছে না।",
  box_error: "বাক্স কাজটি করতে পারেনি।",
};

/** Why the box itself refused. */
const BOX_FAILURES: Record<string, string> = {
  unknown_channel: "বাক্সে এই চ্যানেলটি নেই।",
  unknown_provider: "বাক্সে এই প্রোভাইডারটি নেই।",
  invalid_channelKey: "চ্যানেল আইডি বাক্সের নিয়ম মেনে চলছে না।",
  invalid_providerId: "প্রোভাইডার আইডি বাক্সের নিয়ম মেনে চলছে না।",
  invalid_kind: "এই প্রোভাইডারের ধরন বদলানো যায় না।",
  invalid_credential: "ক্রেডেনশিয়াল নিয়ে সমস্যা।",
  unauthorized: "বাক্স এই সার্ভারের কী মেনে নিচ্ছে না।",
  admin_disabled: "বাক্সে অ্যাডমিন সারফেস চালু নেই।",
  vault_disabled: "বাক্সে ভল্ট চালু নেই।",
  vault_failed: "ভল্ট খোলা যায়নি।",
  vault_write_failed: "ভল্টে লেখা যায়নি।",
  registry_unavailable: "বাক্সের রেজিস্ট্রি পাওয়া যায়নি।",
  provider_busy: "প্রোভাইডারের সব সংযোগ ব্যবহারে আছে।",
  provider_in_use: "প্রোভাইডারটি ব্যবহারে আছে।",
  duplicate_credential: "এই ক্রেডেনশিয়াল আগে থেকেই আছে।",
  channel_limit: "বাক্সের চ্যানেল সীমা পূর্ণ।",
  too_many_channels: "বাক্সের চ্যানেল সীমা পূর্ণ।",
  invalid_body: "বাক্স বডিটি পড়তে পারেনি।",
};

/**
 * The line for a refused action.
 *
 * The box's own code is used when there is one, because it names the reason precisely; the
 * server's code says where the refusal happened when the box gave no reason of its own.
 */
export function proxyActionFailure(
  siteCode: string | null | undefined,
  boxCode?: string | null
): ProxyActionLine {
  const boxText = boxCode ? BOX_FAILURES[boxCode] : undefined;
  if (boxText) return { tone: "red", text: boxText };
  if (siteCode && SITE_FAILURES[siteCode]) return { tone: "red", text: SITE_FAILURES[siteCode] };
  return { tone: "red", text: "বাক্স কাজটি গ্রহণ করেনি।" };
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
      providers === null ? null : `${providers} প্রোভাইডার`,
      stored === null ? null : `${stored} সংরক্ষিত চ্যানেল`,
    ]);
    if (data.hasError === true) {
      return {
        tone: "amber",
        text: `ভল্ট রিফ্রেশ হয়েছে, কিন্তু ভল্টে সমস্যা আছে — বাক্সের লগ দেখুন।${summary ? ` (${summary})` : ""}`,
      };
    }
    return { tone: "green", text: `ভল্ট রিফ্রেশ হয়েছে।${summary ? ` ${summary}.` : ""}` };
  }

  if (action === "set_channel_active" || action === "set_provider_active") {
    const noun = action === "set_channel_active" ? "চ্যানেল" : "প্রোভাইডার";
    const state = data.active === true ? "চালু" : data.active === false ? "বন্ধ" : "অপরিবর্তিত";
    return { tone: "green", text: `${noun} এখন ${state}।` };
  }

  if (action === "probe_channel") {
    const http = number(data.httpStatus);
    const levels = number(data.levels);
    const segments = number(data.segments);
    const tookMs = number(data.tookMs);
    const summary = parts([
      http === null ? null : `HTTP ${http}`,
      levels === null ? null : `${levels} লেভেল`,
      segments === null ? null : `${segments} সেগমেন্ট`,
      tookMs === null ? null : `${(tookMs / 1000).toFixed(1)} সেকেন্ড`,
    ]);
    if (data.probeOk === true) {
      return { tone: "green", text: `যাচাই সফল।${summary ? ` ${summary}.` : ""}` };
    }
    return {
      tone: "amber",
      text: `যাচাই চলেছে, কিন্তু সোর্স সাড়া দেয়নি।${summary ? ` ${summary}.` : ""}`,
    };
  }

  return { tone: "green", text: "কাজটি হয়েছে।" };
}
