/**
 * The banner the panel shows above everything else.
 *
 * It lives in its own module because it is the one part of the panel that decides what an
 * operator is told, and every state the box reading can produce has to have its own line.
 * The state that is easiest to lose is the one that matters most: a box that cannot be
 * reached has to read as "the box is down", never as "no answer yet" — and a snapshot can
 * carry that state without the panel having a word for it.
 *
 * The type-only import is erased at compile time, so this module has no runtime
 * dependency and the test runner can require it directly.
 */
import type { BoxState } from "@/lib/proxyControl";

export interface ProxyStateBanner {
  tone: "green" | "amber" | "red" | "slate";
  title: string;
  body: string;
}

export function proxyStateBanner(state: BoxState | null | undefined): ProxyStateBanner {
  switch (state) {
    case "usable":
      return {
        tone: "green",
        title: "স্ট্রিম বক্স চালু আছে এবং ভল্ট প্রস্তুত।",
        body: "বাক্স উত্তর দিয়েছে, ভল্ট পড়া যাচ্ছে এবং দেওয়া ফলে চ্যানেল খোলা আছে।",
      };
    case "degraded":
      return {
        tone: "amber",
        title: "স্ট্রিম বক্স চালু আছে, কিন্তু ভল্ট প্রস্তুত নয়।",
        body: "বাক্স নিজেকে সুস্থ বলছে, তবে ভল্ট এখনো প্রস্তুত নয় বা ভল্টে সমস্যা দেখা যাচ্ছে। এই অবস্থায় চ্যানেল খুলবে না। বিস্তারিত বাক্সের নিজস্ব লগে আছে।",
      };
    case "unusable":
      return {
        tone: "red",
        title: "স্ট্রিম বক্স উত্তর দিচ্ছে, কিন্তু নিজেকে সুস্থ বলছে না।",
        body: "বাক্স জীবিত আছে, কিন্তু নিজের স্বাস্থ্যের খবরে সমস্যা জানিয়েছে।",
      };
    case "unreachable":
      return {
        tone: "red",
        title: "স্ট্রিম বক্সে এখন পৌঁছানো যাচ্ছে না।",
        body: "বাক্স থেকে কোনো উত্তর আসেনি। বাক্স চালু আছে কি না এবং টানেল ঠিক আছে কি না আলাদাভাবে দেখুন।",
      };
    default:
      return {
        tone: "slate",
        title: "স্ট্রিম বক্সের অবস্থা এখনো জানা নেই।",
        body: "এখনো কোনো উত্তর পাওয়া যায়নি।",
      };
  }
}
