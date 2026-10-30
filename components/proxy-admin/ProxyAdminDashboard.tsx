"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Database,
  HardDrive,
  KeyRound,
  Loader2,
  Power,
  Radio,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldOff,
  Tv,
} from "lucide-react";
import type { ProxyBoxSnapshot, ProxyInspectSnapshot } from "@/lib/proxyControl";
import type { BoxRegistration } from "@/lib/boxRegistry";
import { proxyStateBanner } from "./proxyBanner";
import {
  proxyActionFailure,
  proxyActionSuccess,
  type ProxyActionLine,
} from "./proxyActionLabels";

interface ProxyAdminDashboardProps {
  secretKey: string;
}

/** Where the browser remembers the last time the box answered, so a later failure can say when it last worked. */
const LAST_SUCCESS_KEY = "freetv_proxy_admin_last_success";

/** How often the panel asks the box again. One cheap health read, not a stream. */
const REFRESH_MS = 30_000;

type Tone = "green" | "amber" | "red" | "slate";

interface Banner {
  tone: Tone;
  title: string;
  body: string;
}

const TONE_BOX: Record<Tone, string> = {
  green: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
  amber: "bg-amber-500/10 border-amber-500/30 text-amber-300",
  red: "bg-red-500/10 border-red-500/30 text-red-300",
  slate: "bg-slate-500/10 border-slate-500/30 text-slate-300",
};

const TONE_PILL: Record<Tone, string> = {
  green: "bg-emerald-500/15 text-emerald-300",
  amber: "bg-amber-500/15 text-amber-300",
  red: "bg-red-500/15 text-red-300",
  slate: "bg-slate-700/50 text-slate-400",
};

function timeAgo(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} days ${hours} hours`;
  if (hours > 0) return `${hours} hours ${minutes} minutes`;
  return `${minutes} minutes`;
}

/** A number the box did not give, said plainly rather than shown as a zero. */
function dash(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "Not known";
}

function driverLabel(driver: string | null): string {
  if (driver === "mongo") return "MongoDB";
  if (driver === "memory") return "In memory (resets on restart)";
  if (driver === "config") return "Config file";
  if (driver === "none") return "Not opened yet";
  return "Unknown";
}

function ownershipLabel(mode: "process-local" | "shared-filesystem" | null): string {
  if (mode === "process-local") return "This process only";
  if (mode === "shared-filesystem") return "File lock on this machine";
  return "Unknown";
}

function guardLabel(mode: "permissive" | "strict" | null): string {
  if (mode === "strict") return "Strict - refuses every request with no site address";
  if (mode === "permissive") return "Permissive - refuses a request from another site";
  return "Unknown";
}

function kindLabel(kind: string | null): string {
  if (kind === "xtream") return "Xtream";
  if (kind === "hls") return "HLS";
  return "Unknown";
}

function channelStateLabel(state: "serving" | "inactive" | "unusable" | null): string {
  if (state === "serving") return "Playable";
  if (state === "inactive") return "Off";
  if (state === "unusable") return "Broken";
  return "Unknown";
}

function channelStateTone(state: "serving" | "inactive" | "unusable" | null): Tone {
  if (state === "serving") return "green";
  if (state === "unusable") return "red";
  return "slate";
}

/** What the site thinks of a box's enrollment, in the panel's words. */
function boxStateLabel(state: "pending" | "enrolled" | "revoked"): string {
  if (state === "enrolled") return "Enrolled";
  if (state === "revoked") return "Revoked";
  return "Pending";
}

function boxStateTone(state: "pending" | "enrolled" | "revoked"): Tone {
  if (state === "enrolled") return "green";
  if (state === "revoked") return "red";
  return "amber";
}

/**
 * The one line under a box's name.
 *
 * The badge beside the name already says what state the box is in, so this line must never
 * say it again and must never disagree with it: a box that is enrolled is enrolled, even on
 * a day when the site never recorded the moment it was enrolled.
 */
function boxStateNote(box: BoxRegistration): string {
  if (box.state === "pending") return "Waiting for its enrollment code";
  if (box.state === "revoked") return "Its credential was withdrawn";
  if (box.enrolledAt) return `Enrolled ${new Date(box.enrolledAt).toLocaleString("en-GB")}`;
  if (box.registeredAt) {
    return `Last registered ${new Date(box.registeredAt).toLocaleString("en-GB")}`;
  }
  return "Enrolled";
}

function providerProblemLabel(problem: string | null): string {
  if (problem === "undecryptable") return "The password cannot be opened";
  if (problem === "unreadable") return "The stored details are not right";
  return "Unknown";
}

function channelProblemLabel(problem: string | null): string {
  if (problem === "provider_disabled") return "Provider is off";
  if (problem === "provider_unusable") return "Provider could not be started";
  if (problem === "row_unusable") return "The channel's details are not right";
  if (problem === "unusable") return "Not usable";
  return "Unknown";
}

/** A card: an icon, a title, one line of explanation and the control that belongs to it. */
function Card({
  icon,
  title,
  hint,
  aside,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="glass-panel rounded-2xl border border-slate-800 p-5">
      <div className="flex items-start gap-2.5 mb-3">
        <span className="text-cyan-300 mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-white">{title}</h2>
          {hint ? <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{hint}</p> : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** One label and one value, on one line. The panel's basic unit of information. */
function Facts({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <div>
      {items.map((item) => (
        <div
          key={item.label}
          className="flex items-start justify-between gap-4 py-1.5 border-b border-slate-800/60 last:border-0"
        >
          <span className="text-[11px] text-slate-400 shrink-0">{item.label}</span>
          <span className="text-[11px] font-bold text-slate-200 text-right break-words">
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** One number worth looking at, with its name under it. */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2 min-w-0">
      <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="text-xs font-bold text-slate-100 mt-1 truncate">{value}</p>
      {hint ? <p className="text-[10px] text-slate-500 mt-0.5 truncate">{hint}</p> : null}
    </div>
  );
}

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${TONE_PILL[tone]}`}
    >
      {children}
    </span>
  );
}

/** A small control on a row: the box's own rows are read-only, these are how they change. */
function RowButton({
  onClick,
  disabled,
  title,
  children,
  tone = "slate",
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
  tone?: "slate" | "amber";
}) {
  const toneClass =
    tone === "amber"
      ? "bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20"
      : "bg-slate-900 border-slate-800 text-slate-300 hover:text-white hover:border-cyan-500/40";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold border transition-all disabled:opacity-50 ${toneClass}`}
    >
      {children}
    </button>
  );
}

/**
 * The 24/7 proxy control panel.
 *
 * It reads the box's health and the box's read-only surface, and it can ask this server to
 * perform one of four named actions on the box: re-read the vault, take a provider or a
 * channel out of service, or put one back, or check whether a channel's source still
 * answers.
 *
 * What the panel cannot do is hold a proxy credential. The browser carries the site admin
 * secret and nothing else; every write goes through the server, which keeps the box's write
 * token in its own environment. So a page that changes the box is still a page that cannot
 * leak a credential, because the credential is not in it.
 *
 * The four states are kept apart on purpose. "The box answered" is not "the service works":
 * the box reports `ok: true` even while its vault is broken, and that is exactly the
 * failure an operator has to see.
 */
export default function ProxyAdminDashboard({ secretKey }: ProxyAdminDashboardProps) {
  const [snapshot, setSnapshot] = useState<ProxyBoxSnapshot | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<ProxyInspectSnapshot | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [outcome, setOutcome] = useState<ProxyActionLine | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<BoxRegistration[]>([]);
  const [boxesError, setBoxesError] = useState<string | null>(null);
  const [boxIdInput, setBoxIdInput] = useState("");
  const [enrollment, setEnrollment] = useState<{ boxId: string; code: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyBox, setBusyBox] = useState<string | null>(null);

  /**
   * The last time the box answered, kept in the browser as well as on the server: a serverless
   * host forgets between requests, and an operator who comes back after an outage needs to
   * know when the box last worked, not only that it is not working now.
   */
  const rememberSuccess = useCallback((at: number) => {
    setLastSuccessAt(at);
    try {
      localStorage.setItem(LAST_SUCCESS_KEY, String(at));
    } catch {
      // Private mode can refuse storage; the panel still works for this visit.
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/proxy/status", {
        headers: { "x-admin-secret": secretKey.trim() },
        cache: "no-store",
      });
      const data = await res.json();
      if (data?.success === true && data.snapshot) {
        setSnapshot(data.snapshot as ProxyBoxSnapshot);
        setError(null);
        // A box that answered is a success even when it says it is broken — the reading is
        // what was asked for.
        rememberSuccess(data.snapshot.checkedAt as number);
      } else {
        setError(
          typeof data?.error === "string"
            ? data.error
            : "The stream box's state could not be read."
        );
      }
    } catch {
      setError("The stream box's state could not be read.");
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, [rememberSuccess, secretKey]);

  /**
   * The second reading: the box's read-only surface, which reports the vault, the provider
   * rows, the channel-to-provider mapping and the lanes. It is asked separately from the
   * health read because it can be refused for a different reason — a missing or wrong
   * read-only key on the box — and a panel that merged the two would say "the box is down"
   * when the truth is "the key is wrong".
   */
  const loadInspection = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/proxy/inspect", {
        headers: { "x-admin-secret": secretKey.trim() },
        cache: "no-store",
      });
      const data = await res.json();
      if (data?.success === true && data.inspection) {
        setInspection(data.inspection as ProxyInspectSnapshot);
        setInspectionError(null);
      } else {
        setInspectionError(
          typeof data?.error === "string" ? data.error : "The vault details could not be read."
        );
      }
    } catch {
      setInspectionError("The vault details could not be read.");
    }
  }, [secretKey]);

  /**
   * The list of boxes this site knows, whatever state each one is in.
   *
   * It is read apart from the health reading on purpose: a box that is not answering is
   * exactly the case in which an operator needs to see whether the box is enrolled at all,
   * and a merged reading would show "the box is down" where the truth is "the box was never
   * admitted". Nothing secret is in it — a box's name, its address and the state of its
   * enrollment. The tokens a box holds are derived by the server and never travel here.
   */
  const loadBoxes = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/proxy/boxes", {
        headers: { "x-admin-secret": secretKey.trim() },
        cache: "no-store",
      });
      const data = await res.json();
      if (data?.success === true && Array.isArray(data.boxes)) {
        setBoxes(data.boxes as BoxRegistration[]);
        setBoxesError(null);
      } else {
        setBoxesError(
          typeof data?.error === "string" ? data.error : "The box list could not be read."
        );
      }
    } catch {
      setBoxesError("The box list could not be read.");
    }
  }, [secretKey]);

  const refreshAll = useCallback(async () => {
    await Promise.all([load(), loadInspection(), loadBoxes()]);
  }, [load, loadInspection, loadBoxes]);

  /**
   * Admit a box: ask the site for a one-time enrollment code for a name.
   *
   * The code comes back once and is shown once. The browser never holds a box credential —
   * it holds the site admin secret, and the code it receives is spent by the box, not by
   * this page. What the operator does with it is write it into the box's folder.
   */
  const enrollBox = useCallback(async () => {
    const boxId = boxIdInput.trim();
    if (!boxId) return;
    setBusyBox("enroll");
    try {
      const res = await fetch("/api/admin/proxy/boxes", {
        method: "POST",
        headers: { "x-admin-secret": secretKey.trim(), "content-type": "application/json" },
        body: JSON.stringify({ boxId }),
        cache: "no-store",
      });
      const data = await res.json();
      if (data?.success === true && typeof data.enrollmentCode === "string") {
        setEnrollment({
          boxId: typeof data.boxId === "string" ? data.boxId : boxId,
          code: data.enrollmentCode,
          expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : "",
        });
        setCopied(false);
        setBoxIdInput("");
        setOutcome({
          tone: "green",
          text: `Enrollment created for box "${boxId}". The code is shown only once — take it now.`,
        });
        await loadBoxes();
      } else {
        setOutcome({
          tone: "red",
          text: typeof data?.error === "string" ? data.error : "The enrollment could not be created.",
        });
      }
    } catch {
      setOutcome({ tone: "red", text: "The enrollment could not be created." });
    } finally {
      setBusyBox(null);
    }
  }, [boxIdInput, loadBoxes, secretKey]);

  /**
   * Withdraw a box: the site stops deriving tokens for it and stops talking to it.
   *
   * One row, one call, and nothing has to be done to the box itself — a credential the
   * site no longer derives is not a credential the site will accept.
   */
  const revokeBox = useCallback(
    async (boxId: string) => {
      if (
        !window.confirm(
          `Revoke box "${boxId}"? The site will stop talking to this box.`
        )
      ) {
        return;
      }
      setBusyBox(`revoke:${boxId}`);
      try {
        const res = await fetch(`/api/admin/proxy/boxes/${encodeURIComponent(boxId)}/revoke`, {
          method: "POST",
          headers: { "x-admin-secret": secretKey.trim() },
          cache: "no-store",
        });
        const data = await res.json();
        if (data?.success === true) {
          setOutcome({
            tone: "green",
            text: `Box "${boxId}" revoked. The site will stop talking to this box.`,
          });
          await loadBoxes();
        } else {
          setOutcome({
            tone: "red",
            text: typeof data?.error === "string" ? data.error : "The box could not be revoked.",
          });
        }
      } catch {
        setOutcome({ tone: "red", text: "The box could not be revoked." });
      } finally {
        setBusyBox(null);
      }
    },
    [loadBoxes, secretKey]
  );

  /** Copies the enrollment code to the clipboard, so it can be pasted into the box. */
  const copyEnrollment = useCallback(async () => {
    if (!enrollment) return;
    try {
      await navigator.clipboard.writeText(enrollment.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [enrollment]);

  /**
   * Asks the server to perform one action on the box.
   *
   * The browser names the action and the row; the server holds the credential and builds the
   * request. Nothing is sent to the box from here, so a panel that is copied, or a request
   * that is replayed, still cannot carry a proxy token.
   *
   * Every action that changes something asks first. The refresh does not, because it changes
   * nothing: it only makes the box look at its own vault again.
   */
  const runAction = useCallback(
    async (
      action: string,
      target: string | null,
      active: boolean | undefined,
      confirmText: string | null
    ) => {
      if (confirmText && !window.confirm(confirmText)) return;
      setBusyAction(`${action}:${target ?? ""}`);
      try {
        const res = await fetch("/api/admin/proxy/action", {
          method: "POST",
          headers: { "x-admin-secret": secretKey.trim(), "content-type": "application/json" },
          body: JSON.stringify({ action, target, active }),
          cache: "no-store",
        });
        const data = await res.json();
        if (data?.success === true) {
          setOutcome(
            proxyActionSuccess(data.result?.action ?? action, data.result?.detail)
          );
          // The box's state has changed, so what the panel is showing is no longer the
          // truth until it is read again.
          await refreshAll();
        } else {
          setOutcome(
            proxyActionFailure(data?.code ?? null, data?.result?.code ?? null)
          );
        }
      } catch {
        setOutcome({ tone: "red", text: "The server did not finish the action." });
      } finally {
        setBusyAction(null);
      }
    },
    [refreshAll, secretKey]
  );

  useEffect(() => {
    try {
      const stored = localStorage.getItem(LAST_SUCCESS_KEY);
      if (stored) {
        const parsed = Number(stored);
        if (Number.isFinite(parsed) && parsed > 0) setLastSuccessAt(parsed);
      }
    } catch {
      // A missing preference is not worth an error banner.
    }
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const timer = setInterval(() => {
      refreshAll();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshAll]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const state = snapshot?.state ?? (error ? "unreachable" : null);

  const banner = ((): Banner => {
    if (loading && !snapshot) {
      return {
        tone: "slate",
        title: "Checking the stream box's state...",
        body: "No answer has come back yet.",
      };
    }
    if (error) {
      return {
        tone: "red",
        title: "The stream box cannot be reached right now.",
        body: "No answer came back from the box. Check separately whether the box is running and whether the tunnel is up.",
      };
    }
    return proxyStateBanner(state);
  })();

  /** The one-word state of the whole box, for the badge next to the title. */
  const statusPill = (() => {
    if (loading && !snapshot) return { tone: "slate" as Tone, text: "Checking" };
    if (error) return { tone: "red" as Tone, text: "Down" };
    if (state === "usable") return { tone: "green" as Tone, text: "Working" };
    if (state === "degraded") return { tone: "amber" as Tone, text: "Not ready" };
    if (state === "unusable") return { tone: "red" as Tone, text: "Not healthy" };
    if (state === "unreachable") return { tone: "red" as Tone, text: "Down" };
    return { tone: "slate" as Tone, text: "Unknown" };
  })();

  /**
   * The inspection is reported apart from the health reading, because the two fail for
   * different reasons: a box whose read-only key is wrong is a configuration mistake, not a
   * box that is down, and an operator who is told the wrong one will go looking in the wrong
   * place.
   */
  const inspectBanner = ((): Banner => {
    if (inspectionError) {
      return {
        tone: "red",
        title: "The vault details could not be read.",
        body: "The panel could not get the details from the box's read-only surface.",
      };
    }
    if (!inspection) {
      return {
        tone: "slate",
        title: "The vault details are coming...",
        body: "The details are coming from the box's read-only surface.",
      };
    }
    switch (inspection.refusal) {
      case "unreachable":
        return {
          tone: "red",
          title: "The box's read-only surface cannot be reached.",
          body: "This is separate from the health report above - the box may be running and this surface still may not be enterable.",
        };
      case "unauthorized":
        return {
          tone: "amber",
          title: "The box does not accept the read-only key.",
          body: "The box's READONLY_SERVICE_TOKEN and this server's box key have to be the same one - that is, the box's own read-only key derived from PROXY_BOX_SECRET.",
        };
      case "not_found":
        return {
          tone: "amber",
          title: "The box has no read-only surface.",
          body: "Put READONLY_SERVICE_TOKEN on the box and the /readonly surface comes up.",
        };
      case "not_configured":
        return {
          tone: "amber",
          title: "This server cannot work out the box's key.",
          body: "There is no PROXY_BOX_SECRET on this server, or no box is enrolled, or the box has no address - so the box's details were not read. The health report above is a separate matter - it does not depend on your read-only key.",
        };
      case "error":
        return {
          tone: "red",
          title: "The box's answer could not be understood.",
          body: "The box answered, but this panel could not read the answer.",
        };
      default:
        return {
          tone: "green",
          title: "The vault details were received.",
          body: "The box's read-only surface answered.",
        };
    }
  })();

  /**
   * The read-only surface answered with its data.
   *
   * This is the flag that decides where a number comes from. The box answers on two doors —
   * its health report and its read-only surface — and both of them describe the same vault,
   * the same lanes and the same ownership. The read-only door is the better one: it names
   * the provider a lane belongs to and it counts the providers. So where the two overlap,
   * this panel takes the read-only reading and falls back to the health reading only when
   * the read-only door is closed. A number is left out rather than shown twice from two
   * doors, because two numbers for one idea is worse than one.
   */
  const inspected = inspection?.authorized === true;

  /**
   * The health reading only counts when the box actually answered.
   *
   * A reading that could not be made comes back with zeroes in it, and a zero is a fact
   * about the world: "0 channels stored" says the vault is empty, while "the box did not
   * answer" says nothing at all. So every number taken from this door is taken from
   * `snap`, which is empty unless the box answered, and a number that is missing is
   * printed as "Not known" rather than as a zero.
   */
  const snap = snapshot?.reachable === true ? snapshot : null;

  const vaultReady = inspected ? inspection.vault.ready : (snap?.vault.ready ?? null);
  const vaultHasError = inspected ? inspection.vault.hasError : (snap ? snap.vault.hasError : null);
  const vaultDriver = inspected ? inspection.vault.driver : (snap?.vault.driver ?? null);
  const vaultLastRead = inspected ? inspection.vault.lastRefreshAt : null;
  const providersStored = inspected ? inspection.vault.providers : null;
  const channelsStored = inspected ? inspection.vault.stored : (snap?.vault.stored ?? null);
  const channelsPlayable = inspected ? inspection.vault.resolvable : (snap?.vault.resolvable ?? null);
  const channelsBroken = inspected ? inspection.vault.unreadable : (snap?.vault.unreadable ?? null);

  const lanes = inspected
    ? inspection.lanes.map((lane) => ({
        name: lane.providerId,
        open: lane.holders.length,
        max: lane.maxConnections,
      }))
    : (snap?.capacity.lanes ?? []).map((lane, index) => ({
        name: `Lane ${index + 1}`,
        open: lane.channels,
        max: lane.maxConnections,
      }));

  const providerBusy = inspected
    ? inspection.capacity.providerBusy
    : (snap?.capacity.refusals ?? null);
  const maxConcurrent = inspected
    ? inspection.capacity.maxConcurrentUpstream
    : (snap?.counters.maxConcurrentUpstream ?? null);
  const lastRefusal = inspected ? inspection.capacity.last : (snap?.capacity.last ?? null);

  const ownershipMode = inspected ? inspection.ownership.mode : (snap?.ownership.mode ?? null);
  const ownershipHeld = inspected ? inspection.ownership.held : (snap?.ownership.held ?? null);
  const ownershipRefusals = inspected
    ? inspection.ownership.refusals
    : (snap?.ownership.refusals ?? null);

  const answered = Boolean(snap) || inspected;

  /**
   * Why a list is empty, in the plainest words that fit.
   *
   * "Being read" and "could not be read" are different situations and an operator has to be
   * able to tell them apart at a glance, so the reason the read failed is named rather
   * than left as a generic waiting message.
   */
  const listUnavailableText = (what: string): string => {
    if (inspectionError) return inspectionError;
    if (inspection && inspection.refusal !== null) {
      return `The box could not give the ${what} list - see the notice above.`;
    }
    return `The ${what} list is being read from the box.`;
  };

  return (
    <div className="space-y-4">
      {/* ---------- The one screen an operator looks at first ---------- */}
      <section className="glass-panel rounded-2xl border border-slate-800 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-9 h-9 rounded-xl border bg-cyan-500/10 border-cyan-500/30 text-cyan-300 flex items-center justify-center shrink-0">
            <Server className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-bold text-white">24/7 Proxy Control</h1>
              <Pill tone={statusPill.tone}>{statusPill.text}</Pill>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Your stream box, the providers it holds and the channels they serve.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={refreshAll}
              disabled={loading}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-[11px] font-bold bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:border-cyan-500/40 transition-all disabled:opacity-60"
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              <span>Refresh now</span>
            </button>
            <Link
              href="/admin-secret-gate"
              className="text-[11px] font-bold px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:border-brand-500/40 transition-all"
            >
              Switch panel
            </Link>
          </div>
        </div>

        <div
          className={`mt-4 flex items-start gap-3 rounded-xl border p-3 ${TONE_BOX[banner.tone]}`}
        >
          {banner.tone === "green" ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          ) : banner.tone === "slate" ? (
            <Loader2 className="w-4 h-4 shrink-0 mt-0.5 animate-spin" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0">
            <p className="text-xs font-bold">{banner.title}</p>
            <p className="text-[11px] opacity-80 mt-0.5 leading-relaxed">{banner.body}</p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Stat
            label="Uptime"
            value={
              snap && snap.uptimeMs !== null ? formatDuration(snap.uptimeMs) : "Not known"
            }
          />
          <Stat
            label="Live sessions"
            value={snap ? String(snap.counters.sessions) : "Not known"}
          />
          <Stat
            label="Last checked"
            value={snapshot ? timeAgo(snapshot.checkedAt, now) : "Not yet"}
            hint={`Asks again every ${REFRESH_MS / 1000}s`}
          />
          <Stat
            label="Last working"
            value={lastSuccessAt ? timeAgo(lastSuccessAt, now) : "Not yet"}
          />
        </div>

        {outcome && (
          <div
            className={`mt-3 flex items-start gap-2 px-3 py-2 rounded-xl border ${TONE_BOX[outcome.tone]}`}
          >
            {outcome.tone === "green" ? (
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            )}
            <p className="text-[11px] font-bold">{outcome.text}</p>
          </div>
        )}
      </section>

      {/* ---------- Only shown when the read-only surface has something to say ---------- */}
      {inspectionError || (inspection && inspection.refusal !== null) ? (
        <div
          className={`flex items-start gap-3 rounded-xl border p-3 ${TONE_BOX[inspectBanner.tone]}`}
        >
          {inspectBanner.tone === "green" ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          ) : inspectBanner.tone === "slate" ? (
            <Loader2 className="w-4 h-4 shrink-0 mt-0.5 animate-spin" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0">
            <p className="text-xs font-bold">{inspectBanner.title}</p>
            <p className="text-[11px] opacity-80 mt-0.5 leading-relaxed">{inspectBanner.body}</p>
          </div>
        </div>
      ) : null}

      {/* ---------- The boxes this site knows ---------- */}
      <Card
        icon={<KeyRound className="w-4 h-4" />}
        title="Boxes"
        hint="A box is the machine that holds the provider accounts and serves the streams."
      >
        {boxesError ? (
          <p className="text-[11px] text-red-300">{boxesError}</p>
        ) : boxes.length === 0 ? (
          <p className="text-[11px] text-slate-400">No box is enrolled yet.</p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-2">
            {boxes.map((box) => (
              <div
                key={box.boxId}
                className="rounded-xl border border-slate-800 bg-slate-900/40 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-100 truncate">{box.boxId}</span>
                  <Pill tone={boxStateTone(box.state)}>{boxStateLabel(box.state)}</Pill>
                </div>
                <p className="mt-1 text-[10px] text-slate-500 break-all">
                  {box.baseUrl || "Address not known yet"}
                </p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-slate-500 truncate">
                    {boxStateNote(box)}
                  </span>
                  {box.state === "enrolled" && (
                    <RowButton
                      onClick={() => revokeBox(box.boxId)}
                      disabled={busyBox !== null}
                      tone="amber"
                      title="Revoke this box"
                    >
                      {busyBox === `revoke:${box.boxId}` ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <ShieldOff className="w-3 h-3" />
                      )}
                      <span>Revoke</span>
                    </RowButton>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 pt-3 border-t border-slate-800/60">
          <p className="text-[11px] font-bold text-slate-300">Enroll a new box</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              value={boxIdInput}
              onChange={(event) => setBoxIdInput(event.target.value)}
              placeholder="Box id"
              aria-label="Box id"
              className="flex-1 min-w-0 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 outline-none focus:border-cyan-500/50"
            />
            <button
              type="button"
              onClick={enrollBox}
              disabled={busyBox !== null || !boxIdInput.trim()}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-bold bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/20 transition-all disabled:opacity-50 shrink-0"
            >
              {busyBox === "enroll" ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <KeyRound className="w-3 h-3" />
              )}
              <span>Create code</span>
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
            Use the box&apos;s own id - the <span className="text-slate-300">BOX_ID</span> in its
            config. The site gives a one-time code; write it into the box&apos;s{" "}
            <span className="text-slate-300">config\enroll.code</span> file, then stop the box
            and start it again.
          </p>
        </div>
      </Card>

      {enrollment && (
        <Card
          icon={<KeyRound className="w-4 h-4" />}
          title="Enrollment code - shown only once"
        >
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-[11px] font-bold text-amber-300">{enrollment.boxId}</p>
            <div className="mt-2 flex items-center gap-2">
              <input
                readOnly
                value={enrollment.code}
                aria-label="Enrollment code"
                onFocus={(event) => event.currentTarget.select()}
                className="flex-1 min-w-0 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 font-mono text-[11px] text-slate-100 outline-none"
              />
              <RowButton onClick={copyEnrollment} title="Copy the code">
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? "Copied" : "Copy"}</span>
              </RowButton>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
            The code is shown only this one time - the site keeps only its hash, not the code.
            Write the code into the box&apos;s{" "}
            <span className="text-slate-300">config\enroll.code</span> file and stop the box and
            start it again; the box talks to the site itself and takes its three credentials,
            and the code is spent the moment it is used.
            {enrollment.expiresAt ? (
              <>
                {" "}
                The code expires at{" "}
                <span className="text-slate-300">
                  {new Date(enrollment.expiresAt).toLocaleString("en-GB")}
                </span>{" "}
                at the latest.
              </>
            ) : null}
          </p>
          <div className="mt-2">
            <RowButton onClick={() => setEnrollment(null)} title="Hide the code">
              Hide the code
            </RowButton>
          </div>
        </Card>
      )}

      {/* ---------- What the box holds, and what an operator can switch ---------- */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card
          icon={<HardDrive className="w-4 h-4" />}
          title="Providers"
          hint="One provider is one upstream account. Turning a provider off closes every channel under it."
        >
          {!inspected ? (
            <p className="text-[11px] text-slate-400">{listUnavailableText("provider")}</p>
          ) : inspection.providers.length === 0 ? (
            <p className="text-[11px] text-slate-400">No provider in the box&apos;s vault.</p>
          ) : (
            <div className="space-y-2">
              {inspection.providers.slice(0, 50).map((provider) => (
                <div
                  key={provider.providerId}
                  className="rounded-xl border border-slate-800 bg-slate-900/40 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-100 truncate">
                      {provider.label || provider.providerId}
                    </span>
                    <Pill tone={provider.active ? "green" : "slate"}>
                      {provider.active ? "On" : "Off"}
                    </Pill>
                  </div>
                  {provider.label && provider.label !== provider.providerId ? (
                    <p className="mt-0.5 text-[10px] text-slate-500 truncate">
                      {provider.providerId}
                    </p>
                  ) : null}
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400">
                    <span className="truncate">
                      Server:{" "}
                      <span className="text-slate-300 break-all">{provider.server || "—"}</span>
                    </span>
                    <span className="truncate">
                      User:{" "}
                      <span className="text-slate-300">{provider.usernameHint || "—"}</span>
                    </span>
                    <span>
                      Type: <span className="text-slate-300">{kindLabel(provider.kind)}</span>
                    </span>
                    <span>
                      Channels:{" "}
                      <span className="text-slate-300">{provider.channels.length}</span>
                    </span>
                  </div>
                  {provider.problem ? (
                    <p className="mt-1.5 text-[11px] text-amber-300">
                      {providerProblemLabel(provider.problem)}
                    </p>
                  ) : null}
                  <div className="mt-2 flex items-center gap-1.5">
                    <RowButton
                      onClick={() =>
                        runAction(
                          "set_provider_active",
                          provider.providerId,
                          !provider.active,
                          provider.active
                            ? `Turn provider "${provider.label || provider.providerId}" off? Every channel under it will stop opening.`
                            : `Turn provider "${provider.label || provider.providerId}" on?`
                        )
                      }
                      disabled={busyAction !== null}
                      tone={provider.active ? "amber" : "slate"}
                      title={provider.active ? "Turn the provider off" : "Turn the provider on"}
                    >
                      <Power className="w-3 h-3" />
                      <span>{provider.active ? "Turn off" : "Turn on"}</span>
                    </RowButton>
                    {busyAction === `set_provider_active:${provider.providerId}` && (
                      <Loader2 className="w-3 h-3 animate-spin text-cyan-300" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          icon={<Tv className="w-4 h-4" />}
          title="Channels"
          hint="A channel is one card a viewer can open. Probe checks that its source still answers."
        >
          {!inspected ? (
            <p className="text-[11px] text-slate-400">{listUnavailableText("channel")}</p>
          ) : inspection.channels.length === 0 ? (
            <p className="text-[11px] text-slate-400">No channel in the box&apos;s vault.</p>
          ) : (
            <div className="space-y-1.5">
              {inspection.channels.slice(0, 100).map((channel) => (
                <div
                  key={channel.channelKey}
                  className="rounded-xl border border-slate-800 bg-slate-900/40 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-slate-100 truncate">
                        {channel.displayName || channel.channelKey}
                      </p>
                      <p className="text-[10px] text-slate-500 truncate">
                        {channel.providerId || "No provider"}
                        {channel.displayName &&
                        channel.displayName !== channel.channelKey &&
                        channel.channelKey !== channel.providerId
                          ? ` · ${channel.channelKey}`
                          : ""}
                      </p>
                    </div>
                    <Pill tone={channelStateTone(channel.state)}>
                      {channelStateLabel(channel.state)}
                    </Pill>
                  </div>
                  {channel.problem ? (
                    <p className="mt-1 text-[11px] text-amber-300">
                      {channelProblemLabel(channel.problem)}
                    </p>
                  ) : null}
                  <div className="mt-2 flex items-center gap-1.5">
                    <RowButton
                      onClick={() =>
                        runAction(
                          "set_channel_active",
                          channel.channelKey,
                          !channel.active,
                          channel.active
                            ? `Turn channel "${channel.displayName || channel.channelKey}" off? It will stop opening.`
                            : `Turn channel "${channel.displayName || channel.channelKey}" on?`
                        )
                      }
                      disabled={busyAction !== null}
                      tone={channel.active ? "amber" : "slate"}
                      title={channel.active ? "Turn the channel off" : "Turn the channel on"}
                    >
                      <Power className="w-3 h-3" />
                      <span>{channel.active ? "Turn off" : "Turn on"}</span>
                    </RowButton>
                    <RowButton
                      onClick={() =>
                        runAction(
                          "probe_channel",
                          channel.channelKey,
                          undefined,
                          `Probing channel "${channel.displayName || channel.channelKey}" opens one connection - it takes one slot of the provider's connection limit.`
                        )
                      }
                      disabled={busyAction !== null}
                      title="Check that the source still answers"
                    >
                      <Radio className="w-3 h-3" />
                      <span>Probe</span>
                    </RowButton>
                    {busyAction === `set_channel_active:${channel.channelKey}` && (
                      <Loader2 className="w-3 h-3 animate-spin text-cyan-300" />
                    )}
                    {busyAction === `probe_channel:${channel.channelKey}` && (
                      <Loader2 className="w-3 h-3 animate-spin text-cyan-300" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ---------- How much the box can carry, and what it holds ---------- */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card
          icon={<Activity className="w-4 h-4" />}
          title="Capacity"
          hint="How many streams the box may open at once, and when it had to say no."
        >
          {!answered ? (
            <p className="text-[11px] text-slate-400">
              The box did not answer, so its capacity is unknown.
            </p>
          ) : (
            <>
              <Facts
                items={[
                  { label: "Streams at once", value: dash(maxConcurrent) },
                  { label: "Refused - no free connection", value: dash(providerBusy) },
                ]}
              />
              {lanes.length > 0 ? (
                <div className="mt-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                    Connection slots per provider
                  </p>
                  <div className="mt-1.5 space-y-1.5">
                    {lanes.map((lane, index) => (
                      <div
                        key={`${lane.name}-${index}`}
                        className="flex items-center justify-between gap-3 text-[11px]"
                      >
                        <span className="text-slate-400 truncate">{lane.name}</span>
                        <span className="font-bold text-slate-200 shrink-0">
                          {lane.open} of {lane.max} open
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {lastRefusal ? (
                <div className="mt-3 pt-3 border-t border-slate-800/60 text-[11px] text-slate-400 space-y-1">
                  <p className="font-bold text-slate-300">Last refusal</p>
                  {lastRefusal.channelKey ? <p>Channel: {lastRefusal.channelKey}</p> : null}
                  {lastRefusal.code ? <p>Reason: {lastRefusal.code}</p> : null}
                  <p>
                    Connections in use: {lastRefusal.holders} of {lastRefusal.maxConnections}
                  </p>
                </div>
              ) : null}
            </>
          )}
        </Card>

        <Card
          icon={<Database className="w-4 h-4" />}
          title="Vault"
          hint="The box's own store of providers and channels."
          aside={
            <RowButton
              onClick={() => runAction("refresh_vault", null, undefined, null)}
              disabled={busyAction !== null}
              title="Ask the box to read its vault again"
            >
              {busyAction === "refresh_vault:" ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              <span>Re-read</span>
            </RowButton>
          }
        >
          {!answered ? (
            <p className="text-[11px] text-slate-400">
              The box did not answer, so its vault is unknown.
            </p>
          ) : (
            <Facts
              items={[
                {
                  label: "Ready to play",
                  value:
                    vaultReady === null ? (
                      "Not known"
                    ) : vaultReady ? (
                      <span className="text-emerald-300">Yes</span>
                    ) : (
                      <span className="text-amber-300">No</span>
                    ),
                },
                { label: "Providers stored", value: dash(providersStored) },
                { label: "Channels stored", value: dash(channelsStored) },
                { label: "Channels playable", value: dash(channelsPlayable) },
                { label: "Channels with a problem", value: dash(channelsBroken) },
                {
                  label: "Vault problem",
                  value:
                    vaultHasError === null ? (
                      "Not known"
                    ) : vaultHasError ? (
                      <span className="text-red-300">Yes - see the box log</span>
                    ) : (
                      "None"
                    ),
                },
              ]}
            />
          )}
        </Card>
      </div>

      {/* ---------- Who may reach the box, and what it holds against a second process ---------- */}
      <Card
        icon={<ShieldAlert className="w-4 h-4" />}
        title="Access and safety"
        hint="Who may reach the box, and how it keeps two processes off the same account."
      >
        <Facts
          items={[
            { label: "Site gate", value: guardLabel(snap?.guard.mode ?? null) },
            {
              label: "Gate active",
              value: snap
                ? snap.guard.siteGateActive
                  ? "Yes"
                  : "No"
                : "Not known",
            },
            {
              label: "Refused - no site address",
              value: dash(snap?.guard.absentRefused ?? null),
            },
            { label: "Connection lock", value: ownershipLabel(ownershipMode) },
            { label: "Locks held now", value: dash(ownershipHeld) },
            { label: "Lock refusals", value: dash(ownershipRefusals) },
          ]}
        />
        <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">
          {ownershipMode === "shared-filesystem"
            ? "Every proxy process on this machine obeys the same file lock, so a second process here will not open the same account twice."
            : ownershipMode === "process-local"
              ? "The lock is inside this process only. A second proxy process on this machine would open its own copy of the same account."
              : "The lock could not be read, so it is not known how this box keeps two processes off the same account."}
        </p>
        <p className="text-[11px] text-amber-300/90 mt-2 leading-relaxed">
          This limit is not enforced between two separate machines, so nothing here is called
          safe.
        </p>
      </Card>

      {/* ---------- The numbers an operator rarely needs ---------- */}
      <details className="group glass-panel rounded-2xl border border-slate-800">
        <summary className="flex items-center gap-2 px-5 py-4 cursor-pointer text-xs font-bold text-slate-300 hover:text-white list-none marker:hidden">
          <ChevronDown className="w-4 h-4 transition-transform group-open:rotate-180" />
          More details
        </summary>
        <div className="px-5 pb-5 grid md:grid-cols-2 gap-x-8 gap-y-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              The box
            </p>
            <Facts
              items={[
                { label: "Service name", value: snap?.service ?? "Not known" },
                { label: "Vault storage", value: driverLabel(vaultDriver) },
                {
                  label: "Admin surface",
                  value: snap
                    ? snap.surfaces.admin
                      ? "Mounted"
                      : "Not present"
                    : "Not known",
                },
                {
                  label: "Signing surface",
                  value: snap
                    ? snap.surfaces.appApi
                      ? "Mounted"
                      : "Not present"
                    : "Not known",
                },
                {
                  label: "Total upstream runs",
                  value: dash(snap?.counters.upstreamRuns ?? null),
                },
              ]}
            />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Requests
            </p>
            <Facts
              items={[
                { label: "Allowed requests", value: dash(snap?.guard.listed ?? null) },
                { label: "Wildcard requests", value: dash(snap?.guard.wildcard ?? null) },
                { label: "Requests with no site address", value: dash(snap?.guard.absent ?? null) },
                {
                  label: "Requests from another site",
                  value: dash(snap?.guard.foreign ?? null),
                },
              ]}
            />
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1 mt-4">
              Times
            </p>
            <Facts
              items={[
                {
                  label: "Last check",
                  value: snapshot
                    ? new Date(snapshot.checkedAt).toLocaleString("en-GB")
                    : "Not known",
                },
                {
                  label: "Last working (server)",
                  value: snapshot?.lastSuccessAt
                    ? new Date(snapshot.lastSuccessAt).toLocaleString("en-GB")
                    : "Not on the server",
                },
                {
                  label: "Last working (this browser)",
                  value: lastSuccessAt
                    ? new Date(lastSuccessAt).toLocaleString("en-GB")
                    : "None",
                },
                {
                  label: "Vault last read",
                  value: vaultLastRead
                    ? new Date(vaultLastRead).toLocaleString("en-GB")
                    : "Not known",
                },
              ]}
            />
          </div>
        </div>
      </details>
    </div>
  );
}
