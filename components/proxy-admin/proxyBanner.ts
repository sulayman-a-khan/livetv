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
        title: "The stream box is running and the vault is ready.",
        body: "The box answered, the vault can be read, and the channels it was given are open.",
      };
    case "degraded":
      return {
        tone: "amber",
        title: "The stream box is running, but the vault is not ready.",
        body: "The box calls itself healthy, but the vault is not ready yet or the vault shows a problem. In this state the channels will not open. The details are in the box's own log.",
      };
    case "unusable":
      return {
        tone: "red",
        title: "The stream box is answering, but does not call itself healthy.",
        body: "The box is alive, but it reported a problem in its own health check.",
      };
    case "unreachable":
      return {
        tone: "red",
        title: "The stream box cannot be reached right now.",
        body: "No answer came back from the box. Check separately whether the box is running and whether the tunnel is up.",
      };
    default:
      return {
        tone: "slate",
        title: "The stream box's state is not known yet.",
        body: "No answer has come back yet.",
      };
  }
}
