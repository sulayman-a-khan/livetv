/**
 * The premium tier's refusals, in the two vocabularies this project speaks.
 *
 * The server answers a viewer in words a machine can match — a code from the list below —
 * because a code can be reasoned about and a sentence cannot. The viewer reads a Bengali line
 * instead, because a Bengali screen that answers in English is a screen the reader cannot
 * use: the refusal is translated on the client, from the code, and the server's own English
 * sentence stays in the response body for the log and for anything else reading it.
 *
 * Both halves live in one file so a refusal cannot be added to one side and forgotten on the
 * other. A code with no line would put an empty box on the screen; a line the server never
 * sends would be a sentence nobody can reach.
 *
 * Nothing here holds a source line, a host or a credential. These are sentences about the
 * state of one channel, and that is all a viewer is told.
 */

/** Every reason the play route can refuse, as a stable code. */
export const PREMIUM_PLAY_FAILURES = [
  "not_found",
  "off_air",
  "not_pushed",
  "box_unavailable",
  "sign_failed",
  "box_unreachable",
] as const;

export type PremiumPlayFailure = (typeof PREMIUM_PLAY_FAILURES)[number];

/**
 * What a viewer is told, in the app's own language.
 *
 * The line for a source that is not on the box yet carries the promise the match card makes:
 * the source goes to the box before kickoff, so the live stream arrives with the match. The
 * line for a box that cannot answer says what the viewer can do about it — try again — and
 * does not blame the viewer for an outage they cannot see.
 */
const LINES: Record<PremiumPlayFailure, string> = {
  not_found: "চ্যানেলটি খুঁজে পাওয়া যায়নি।",
  off_air: "চ্যানেলটি এখন অফ-এয়ার।",
  not_pushed:
    "এই চ্যানেলের স্ট্রিম এখনও স্ট্রিম বক্সে যোগ করা হয়নি। খেলা শুরু হলেই লাইভ স্ট্রিম চালু হবে।",
  box_unavailable:
    "প্রিমিয়াম স্ট্রিম বক্স এখন চালু নেই। স্ট্রিম চালু হলে এখানেই দেখা যাবে — কিছুক্ষণ পরে আবার চেষ্টা করুন।",
  sign_failed: "স্ট্রিম বক্স স্ট্রিমের ঠিকানা দিতে পারেনি। কিছুক্ষণ পরে আবার চেষ্টা করুন।",
  box_unreachable: "স্ট্রিম বক্স সাড়া দেয়নি। কিছুক্ষণ পরে আবার চেষ্টা করুন।",
};

/**
 * The line for a refusal this build does not recognise, and for a failure of the client's own.
 *
 * It is a sentence rather than an empty box, and it never shows the code: a code is for the
 * machine that matched it, and a viewer has no use for one.
 */
const UNKNOWN = "স্ট্রিমটি এখন চালু করা যাচ্ছে না। কিছুক্ষণ পরে আবার চেষ্টা করুন।";

/** Whether a string is one of this build's codes. */
export function isPremiumPlayFailure(code: string): code is PremiumPlayFailure {
  return (PREMIUM_PLAY_FAILURES as readonly string[]).includes(code);
}

/**
 * The Bengali line for a code.
 *
 * A code this build does not know, or none at all, still has to read as a sentence: the
 * viewer is never shown the code, and an unrecognised refusal is never shown as an empty box.
 */
export function premiumPlayFailureText(code: string | null | undefined): string {
  if (typeof code !== "string") return UNKNOWN;
  if (!isPremiumPlayFailure(code)) return UNKNOWN;
  return LINES[code];
}
