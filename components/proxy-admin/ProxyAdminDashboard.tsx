"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  HardDrive,
  KeyRound,
  Layers,
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

function driverLabel(driver: string | null): string {
  if (driver === "mongo") return "MongoDB";
  if (driver === "memory") return "Memory (lives only while the process runs)";
  if (driver === "config") return "Config (no separate vault)";
  if (driver === "none") return "No vault (it has not been opened yet)";
  return "Unknown";
}

function ownershipLabel(mode: "process-local" | "shared-filesystem" | null): string {
  if (mode === "process-local") return "Inside this process only";
  if (mode === "shared-filesystem") return "Through a file lock on this machine";
  return "Unknown";
}

function guardLabel(mode: "permissive" | "strict" | null): string {
  if (mode === "strict") return "strict — refuses even without an Origin header";
  if (mode === "permissive") return "permissive — refuses an unknown Origin";
  return "Unknown";
}

function stateLabel(state: "serving" | "inactive" | "unusable" | null): string {
  if (state === "serving") return "Openable";
  if (state === "inactive") return "Off";
  if (state === "unusable") return "Not openable";
  return "Unknown";
}

/** What the site thinks of a box's enrollment, in the panel's words. */
function boxStateLabel(state: "pending" | "enrolled" | "revoked"): string {
  if (state === "enrolled") return "Enrolled";
  if (state === "revoked") return "Revoked";
  return "Pending";
}

function providerProblemLabel(problem: string | null): string {
  if (problem === "undecryptable") return "The password cannot be opened";
  if (problem === "unreadable") return "The stored details are not right";
  return "None";
}

function channelProblemLabel(problem: string | null): string {
  if (problem === "provider_disabled") return "Provider is off";
  if (problem === "provider_unusable") return "Provider could not be started";
  if (problem === "row_unusable") return "The channel's details are not right";
  if (problem === "unusable") return "Not usable";
  return "None";
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 border-b border-slate-800/60 last:border-0">
      <span className="text-[11px] text-slate-400 shrink-0">{label}</span>
      <span className="text-[11px] font-bold text-slate-200 text-right break-words">{value}</span>
    </div>
  );
}

function Card({
  icon,
  title,
  aside,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  /** A control that belongs to this card, shown at the end of its header. */
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="glass-panel rounded-2xl border border-slate-800 p-5">
      <div className="flex items-center gap-2.5 mb-3">
        <span className="text-cyan-300">{icon}</span>
        <h2 className="text-sm font-bold text-white">{title}</h2>
        {aside ? <div className="ml-auto shrink-0">{aside}</div> : null}
      </div>
      {children}
    </section>
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

  const banner = (() => {
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

  const toneClass = {
    green: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
    amber: "bg-amber-500/10 border-amber-500/30 text-amber-300",
    red: "bg-red-500/10 border-red-500/30 text-red-300",
    slate: "bg-slate-500/10 border-slate-500/30 text-slate-300",
  }[banner.tone];

  const outcomeToneClass = {
    green: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
    amber: "bg-amber-500/10 border-amber-500/30 text-amber-300",
    red: "bg-red-500/10 border-red-500/30 text-red-300",
  }[outcome?.tone ?? "green"];

  /**
   * The inspection is reported apart from the health reading, because the two fail for
   * different reasons: a box whose read-only key is wrong is a configuration mistake, not a
   * box that is down, and an operator who is told the wrong one will go looking in the wrong
   * place.
   */
  const inspectBanner = (() => {
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

  const inspectToneClass = {
    green: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
    amber: "bg-amber-500/10 border-amber-500/30 text-amber-300",
    red: "bg-red-500/10 border-red-500/30 text-red-300",
    slate: "bg-slate-500/10 border-slate-500/30 text-slate-300",
  }[inspectBanner.tone];

  return (
    <div className="space-y-4">
      <div className="glass-panel rounded-2xl border border-slate-800 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-9 h-9 rounded-xl border bg-cyan-500/10 border-cyan-500/30 text-cyan-300 flex items-center justify-center shrink-0">
            <Server className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold text-white">24/7 Proxy Control Panel</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              The stream box&apos;s own health report and daily operations.
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

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-slate-400">
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            Last check:{" "}
            <span className="font-bold text-slate-200">
              {snapshot ? timeAgo(snapshot.checkedAt, now) : "—"}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Last successful snapshot:{" "}
            <span className="font-bold text-slate-200">
              {lastSuccessAt ? timeAgo(lastSuccessAt, now) : "none yet"}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" />
            Refreshes itself every {REFRESH_MS / 1000} seconds
          </span>
        </div>

        {outcome && (
          <div
            className={`mt-3 flex items-start gap-2 px-3 py-2 rounded-xl border ${outcomeToneClass}`}
          >
            {outcome.tone === "green" ? (
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            )}
            <p className="text-[11px] font-bold">{outcome.text}</p>
          </div>
        )}
      </div>

      <div className={`flex items-start gap-3 p-4 rounded-2xl border ${toneClass}`}>
        {banner.tone === "green" ? (
          <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
        ) : banner.tone === "slate" ? (
          <Loader2 className="w-5 h-5 shrink-0 mt-0.5 animate-spin" />
        ) : (
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
        )}
        <div className="min-w-0">
          <p className="text-sm font-bold">{banner.title}</p>
          <p className="text-[11px] opacity-80 mt-0.5">{banner.body}</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card icon={<KeyRound className="w-4 h-4" />} title="Box list and enrollment">
          {boxesError ? (
            <p className="text-[11px] text-red-300">{boxesError}</p>
          ) : boxes.length === 0 ? (
            <p className="text-[11px] text-slate-400">
              This site has not enrolled any box yet.
            </p>
          ) : (
            <div className="space-y-2">
              {boxes.map((box) => (
                <div
                  key={box.boxId}
                  className="rounded-xl border border-slate-800 bg-slate-900/40 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-100 truncate">
                      {box.boxId}
                    </span>
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                        box.state === "enrolled"
                          ? "bg-emerald-500/15 text-emerald-300"
                          : box.state === "revoked"
                            ? "bg-red-500/15 text-red-300"
                            : "bg-amber-500/15 text-amber-300"
                      }`}
                    >
                      {boxStateLabel(box.state)}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500 break-all">
                    {box.baseUrl || "address not known yet"}
                  </p>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className="text-[10px] text-slate-500 truncate">
                      {box.enrolledAt
                        ? `Enrolled: ${new Date(box.enrolledAt).toLocaleString("en-GB")}`
                        : "Not enrolled"}
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

          <div className="mt-3 pt-3 border-t border-slate-800/60">
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
                <span>Create</span>
              </button>
            </div>
            <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
              Write the box&apos;s own id - the one in the box&apos;s config as{" "}
              <span className="text-slate-300">BOX_ID</span>. The site will give a one-time code;
              put that code in the box&apos;s <span className="text-slate-300">config\enroll.code</span>{" "}
              file, then stop the box and start it again.
            </p>
          </div>
        </Card>

        {enrollment && (
          <Card icon={<KeyRound className="w-4 h-4" />} title="Enrollment code - shown only once">
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
                  {copied ? (
                    <Check className="w-3 h-3" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>{copied ? "Copied" : "Copy"}</span>
                </RowButton>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
              The code is shown only this one time - the site keeps only its hash, not the code. Write the code into the box&apos;s{" "}
              <span className="text-slate-300">config\enroll.code</span> file and
              stop the box and start it again; the box talks to the site itself and takes its three
              credentials, and the code is spent the moment it is used.
              {enrollment.expiresAt ? (
                <>
                  {" "}
                  The code expires at{" "}
                  <span className="text-slate-300">
                    {new Date(enrollment.expiresAt).toLocaleString("en-GB")}
                  </span>
                  {" "}
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
      </div>

      {snapshot && (
        <div className="grid lg:grid-cols-2 gap-4">
          <Card icon={<Server className="w-4 h-4" />} title="Box">
            <Row label="Service" value={snapshot.service ?? "Unknown"} />
            <Row
              label="Uptime"
              value={snapshot.uptimeMs !== null ? formatDuration(snapshot.uptimeMs) : "Unknown"}
            />
            <Row label="Configured sources" value={snapshot.counters.sourcesConfigured} />
            <Row label="Live sessions" value={snapshot.counters.sessions} />
            <Row label="Max concurrent upstream" value={snapshot.counters.maxConcurrentUpstream} />
            <Row label="Total upstream runs" value={snapshot.counters.upstreamRuns} />
            <Row label="Admin surface" value={snapshot.surfaces.admin ? "mounted" : "not present"} />
            <Row label="Signing surface" value={snapshot.surfaces.appApi ? "mounted" : "not present"} />
          </Card>

          <Card
            icon={<Database className="w-4 h-4" />}
            title="Vault"
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
                <span>Refresh</span>
              </RowButton>
            }
          >
            <Row label="Driver" value={driverLabel(snapshot.vault.driver)} />
            <Row
              label="Ready"
              value={
                snapshot.vault.ready ? (
                  <span className="text-emerald-300">Yes</span>
                ) : (
                  <span className="text-amber-300">No</span>
                )
              }
            />
            <Row label="Stored providers" value={snapshot.vault.stored} />
            <Row label="Resolvable lanes" value={snapshot.vault.resolvable} />
            <Row label="Unreadable providers" value={snapshot.vault.unreadable} />
            <Row
              label="Vault problem"
              value={
                snapshot.vault.hasError ? (
                  <span className="text-red-300">Yes - see the box&apos;s log</span>
                ) : (
                  "None"
                )
              }
            />
          </Card>

          <Card icon={<ShieldAlert className="w-4 h-4" />} title="Session ownership">
            <Row label="Kind" value={ownershipLabel(snapshot.ownership.mode)} />
            <Row label="Claims held now" value={snapshot.ownership.held} />
            <Row label="Ownership refusals" value={snapshot.ownership.refusals} />
            <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">
              {snapshot.ownership.mode === "shared-filesystem"
                ? "Every proxy process on this machine obeys the same file lock, so a second process on the same machine will not open a lane twice."
                : "The lock is inside this process only. If another proxy process runs on this machine, it will open its own separate lane."}
            </p>
            <p className="text-[11px] text-amber-300/90 mt-2 leading-relaxed">
              This limit is not enforced between two separate machines. That is not implemented yet, so nothing here is
              called &quot;safe&quot;.
            </p>
          </Card>

          <Card icon={<Activity className="w-4 h-4" />} title="Capacity and refusals">
            <Row label="Total refusals" value={snapshot.capacity.refusals} />
            <Row label="Number of lanes" value={snapshot.capacity.lanes.length} />
            {snapshot.capacity.lanes.length > 0 && (
              <div className="mt-2 space-y-1">
                {snapshot.capacity.lanes.map((lane, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between text-[11px] text-slate-300"
                  >
                    <span>Lane {index + 1}</span>
                    <span className="font-bold">
                      {lane.channels} channels / max {lane.maxConnections}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {snapshot.capacity.last && (
              <div className="mt-3 pt-3 border-t border-slate-800/60 text-[11px] text-slate-400 space-y-1">
                <p className="font-bold text-slate-300">Last refusal</p>
                {snapshot.capacity.last.channelKey && (
                  <p>Channel: {snapshot.capacity.last.channelKey}</p>
                )}
                {snapshot.capacity.last.code && <p>Code: {snapshot.capacity.last.code}</p>}
                <p>
                  Held: {snapshot.capacity.last.holders} / max{" "}
                  {snapshot.capacity.last.maxConnections}
                </p>
              </div>
            )}
          </Card>

          <Card icon={<ShieldAlert className="w-4 h-4" />} title="Site gate">
            <Row label="Mode" value={guardLabel(snapshot.guard.mode)} />
            <Row
              label="Gate active"
              value={snapshot.guard.siteGateActive ? "Yes" : "No"}
            />
            <Row label="Listed requests" value={snapshot.guard.listed} />
            <Row label="Wildcard" value={snapshot.guard.wildcard} />
            <Row label="No Origin" value={snapshot.guard.absent} />
            <Row label="Foreign Origin" value={snapshot.guard.foreign} />
            <Row label="Refused without Origin" value={snapshot.guard.absentRefused} />
          </Card>

          <Card icon={<Clock className="w-4 h-4" />} title="Time">
            <Row
              label="This check"
              value={new Date(snapshot.checkedAt).toLocaleString("en-GB")}
            />
            <Row
              label="Last successful answer"
              value={
                snapshot.lastSuccessAt
                  ? new Date(snapshot.lastSuccessAt).toLocaleString("en-GB")
                  : "Not on the server"
              }
            />
            <Row
              label="Last success in this browser"
              value={lastSuccessAt ? new Date(lastSuccessAt).toLocaleString("en-GB") : "None"}
            />
          </Card>
        </div>
      )}

      {(inspection || inspectionError) && (
        <div className="space-y-4">
          <div className={`flex items-start gap-3 p-4 rounded-2xl border ${inspectToneClass}`}>
            {inspectBanner.tone === "green" ? (
              <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
            ) : inspectBanner.tone === "slate" ? (
              <Loader2 className="w-5 h-5 shrink-0 mt-0.5 animate-spin" />
            ) : (
              <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-bold">{inspectBanner.title}</p>
              <p className="text-[11px] opacity-80 mt-0.5">{inspectBanner.body}</p>
            </div>
          </div>

          {inspection && (
            <div className="grid lg:grid-cols-2 gap-4">
              <Card icon={<Database className="w-4 h-4" />} title="Vault readiness">
                <Row
                  label="Surface reachable"
                  value={
                    inspection.reachable ? (
                      <span className="text-emerald-300">Yes</span>
                    ) : (
                      <span className="text-amber-300">No</span>
                    )
                  }
                />
                <Row label="Driver" value={driverLabel(inspection.vault.driver)} />
                <Row
                  label="Ready"
                  value={
                    inspection.vault.ready ? (
                      <span className="text-emerald-300">Yes</span>
                    ) : (
                      <span className="text-amber-300">No</span>
                    )
                  }
                />
                <Row label="Providers" value={inspection.vault.providers} />
                <Row label="Stored channels" value={inspection.vault.stored} />
                <Row label="Openable channels" value={inspection.vault.resolvable} />
                <Row label="Unreadable channels" value={inspection.vault.unreadable} />
                <Row
                  label="Vault problem"
                  value={
                    inspection.vault.hasError ? (
                      <span className="text-red-300">Yes - see the box&apos;s log</span>
                    ) : (
                      "None"
                    )
                  }
                />
                <Row
                  label="Last refresh"
                  value={
                    inspection.vault.lastRefreshAt
                      ? new Date(inspection.vault.lastRefreshAt).toLocaleString("en-GB")
                      : "Unknown"
                  }
                />
              </Card>

              <Card icon={<Layers className="w-4 h-4" />} title="Lanes and capacity">
                <Row label="Provider-busy refusals" value={inspection.capacity.providerBusy} />
                <Row label="Max concurrent upstream" value={inspection.capacity.maxConcurrentUpstream} />
                <Row label="Configured sources" value={inspection.capacity.sourcesConfigured} />
                <Row label="Total upstream runs" value={inspection.capacity.upstreamRuns} />
                <Row label="Claims held now" value={inspection.ownership.held} />
                <Row label="Ownership refusals" value={inspection.ownership.refusals} />
                {inspection.lanes.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {inspection.lanes.map((lane, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between gap-3 text-[11px] text-slate-300"
                      >
                        <span className="truncate">
                          Lane {index + 1} · {lane.providerId}
                        </span>
                        <span className="font-bold shrink-0">
                          {lane.holders.length} channels / max {lane.maxConnections}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {inspection.capacity.last && (
                  <div className="mt-3 pt-3 border-t border-slate-800/60 text-[11px] text-slate-400 space-y-1">
                    <p className="font-bold text-slate-300">Last refusal</p>
                    {inspection.capacity.last.channelKey && (
                      <p>Channel: {inspection.capacity.last.channelKey}</p>
                    )}
                    {inspection.capacity.last.code && <p>Code: {inspection.capacity.last.code}</p>}
                    <p>
                      Held: {inspection.capacity.last.holders} / max{" "}
                      {inspection.capacity.last.maxConnections}
                    </p>
                  </div>
                )}
              </Card>

              <Card icon={<HardDrive className="w-4 h-4" />} title="Providers">
                {inspection.providers.length === 0 ? (
                  <p className="text-[11px] text-slate-400">No providers.</p>
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
                          <span
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                              provider.active
                                ? "bg-emerald-500/15 text-emerald-300"
                                : "bg-slate-700/40 text-slate-400"
                            }`}
                          >
                            {provider.active ? "On" : "Off"}
                          </span>
                        </div>
                        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400">
                          <span className="truncate">
                            Id: <span className="text-slate-300">{provider.providerId}</span>
                          </span>
                          <span>
                            Kind: <span className="text-slate-300">{provider.kind ?? "-"}</span>
                          </span>
                          <span className="truncate">
                            Server:{" "}
                            <span className="text-slate-300 break-all">
                              {provider.server || "—"}
                            </span>
                          </span>
                          <span className="truncate">
                            User:{" "}
                            <span className="text-slate-300">
                              {provider.usernameHint || "—"}
                            </span>
                          </span>
                          <span>
                            Max connections:{" "}
                            <span className="text-slate-300">{provider.maxConnections}</span>
                          </span>
                          <span>
                            Channels:{" "}
                            <span className="text-slate-300">{provider.channels.length}</span>
                          </span>
                        </div>
                        {provider.problem && (
                          <p className="mt-1.5 text-[11px] text-amber-300">
                            Problem: {providerProblemLabel(provider.problem)}
                          </p>
                        )}
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
                            title={
                              provider.active
                                ? "Turn the provider off"
                                : "Turn the provider on"
                            }
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

              <Card icon={<Tv className="w-4 h-4" />} title="Channels and providers">
                {inspection.channels.length === 0 ? (
                  <p className="text-[11px] text-slate-400">No channels.</p>
                ) : (
                  <div className="space-y-1.5">
                    {inspection.channels.slice(0, 100).map((channel) => (
                      <div
                        key={channel.channelKey}
                        className="flex items-center justify-between gap-3 rounded-lg border border-slate-800/70 bg-slate-900/40 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-slate-100 truncate">
                            {channel.displayName || channel.channelKey}
                          </p>
                          <p className="text-[10px] text-slate-500 truncate">
                            {channel.channelKey} · {channel.providerId || "—"}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <div className="text-right">
                            <p
                              className={`text-[10px] font-bold ${
                                channel.state === "serving"
                                  ? "text-emerald-300"
                                  : channel.state === "inactive"
                                    ? "text-slate-400"
                                    : "text-red-300"
                              }`}
                            >
                              {stateLabel(channel.state)}
                            </p>
                            {channel.problem && (
                              <p className="text-[10px] text-amber-300">
                                {channelProblemLabel(channel.problem)}
                              </p>
                            )}
                          </div>
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
                            title={
                              channel.active ? "Turn the channel off" : "Turn the channel on"
                            }
                          >
                            <Power className="w-3 h-3" />
                            <span>{channel.active ? "Off" : "On"}</span>
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
                            title="Check the channel's source"
                          >
                            <Radio className="w-3 h-3" />
                            <span>Probe</span>
                          </RowButton>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
