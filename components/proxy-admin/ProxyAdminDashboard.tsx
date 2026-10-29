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
  if (seconds < 10) return "এইমাত্র";
  if (seconds < 60) return `${seconds} সেকেন্ড আগে`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} মিনিট আগে`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ঘণ্টা আগে`;
  return `${Math.round(hours / 24)} দিন আগে`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} দিন ${hours} ঘণ্টা`;
  if (hours > 0) return `${hours} ঘণ্টা ${minutes} মিনিট`;
  return `${minutes} মিনিট`;
}

function driverLabel(driver: string | null): string {
  if (driver === "mongo") return "MongoDB";
  if (driver === "memory") return "মেমোরি (প্রসেস চালু থাকলেই থাকে)";
  if (driver === "config") return "কনফিগ (আলাদা ভল্ট নেই)";
  if (driver === "none") return "ভল্ট নেই (এখনো খোলা হয়নি)";
  return "জানা নেই";
}

function ownershipLabel(mode: "process-local" | "shared-filesystem" | null): string {
  if (mode === "process-local") return "শুধু এই প্রসেসের মধ্যে";
  if (mode === "shared-filesystem") return "এই মেশিনের ফাইল লকের মাধ্যমে";
  return "জানা নেই";
}

function guardLabel(mode: "permissive" | "strict" | null): string {
  if (mode === "strict") return "strict — Origin না থাকলেও প্রত্যাখ্যান করে";
  if (mode === "permissive") return "permissive — অচেনা Origin প্রত্যাখ্যান করে";
  return "জানা নেই";
}

function stateLabel(state: "serving" | "inactive" | "unusable" | null): string {
  if (state === "serving") return "খোলা যাচ্ছে";
  if (state === "inactive") return "বন্ধ";
  if (state === "unusable") return "খোলা যাচ্ছে না";
  return "জানা নেই";
}

/** What the site thinks of a box's enrollment, in the panel's words. */
function boxStateLabel(state: "pending" | "enrolled" | "revoked"): string {
  if (state === "enrolled") return "এনরোল করা";
  if (state === "revoked") return "বাতিল করা";
  return "অপেক্ষমাণ";
}

function providerProblemLabel(problem: string | null): string {
  if (problem === "undecryptable") return "পাসওয়ার্ড খোলা যাচ্ছে না";
  if (problem === "unreadable") return "সংরক্ষিত তথ্য ঠিক নেই";
  return "নেই";
}

function channelProblemLabel(problem: string | null): string {
  if (problem === "provider_disabled") return "প্রোভাইডার বন্ধ";
  if (problem === "provider_unusable") return "প্রোভাইডার চালু করা যায়নি";
  if (problem === "row_unusable") return "চ্যানেলের তথ্য ঠিক নেই";
  if (problem === "unusable") return "ব্যবহারযোগ্য নয়";
  return "নেই";
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
            : "স্ট্রিম বক্সের অবস্থা পড়া যায়নি।"
        );
      }
    } catch {
      setError("স্ট্রিম বক্সের অবস্থা পড়া যায়নি।");
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
          typeof data?.error === "string" ? data.error : "ভল্টের বিস্তারিত পড়া যায়নি।"
        );
      }
    } catch {
      setInspectionError("ভল্টের বিস্তারিত পড়া যায়নি।");
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
          typeof data?.error === "string" ? data.error : "বক্সের তালিকা পড়া যায়নি।"
        );
      }
    } catch {
      setBoxesError("বক্সের তালিকা পড়া যায়নি।");
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
          text: `"${boxId}" বক্সের এনরোলমেন্ট তৈরি হয়েছে। কোডটি একবারই দেখা যাবে — এখনই নিয়ে রাখুন।`,
        });
        await loadBoxes();
      } else {
        setOutcome({
          tone: "red",
          text: typeof data?.error === "string" ? data.error : "এনরোলমেন্ট তৈরি হয়নি।",
        });
      }
    } catch {
      setOutcome({ tone: "red", text: "এনরোলমেন্ট তৈরি হয়নি।" });
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
          `"${boxId}" বক্সটি বাতিল করবেন? সাইট আর এই বক্সের সাথে কথা বলবে না।`
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
            text: `"${boxId}" বক্স বাতিল হয়েছে। সাইট আর এই বক্সের সাথে কথা বলবে না।`,
          });
          await loadBoxes();
        } else {
          setOutcome({
            tone: "red",
            text: typeof data?.error === "string" ? data.error : "বক্স বাতিল হয়নি।",
          });
        }
      } catch {
        setOutcome({ tone: "red", text: "বক্স বাতিল হয়নি।" });
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
        setOutcome({ tone: "red", text: "সার্ভারের কাজটি শেষ হয়নি।" });
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
        title: "স্ট্রিম বক্সের অবস্থা যাচাই করা হচ্ছে...",
        body: "এখন পর্যন্ত কোনো উত্তর পাওয়া যায়নি।",
      };
    }
    if (error) {
      return {
        tone: "red",
        title: "স্ট্রিম বক্সে এখন পৌঁছানো যাচ্ছে না।",
        body: "বাক্স থেকে কোনো উত্তর আসেনি। বাক্স চালু আছে কি না এবং টানেল ঠিক আছে কি না আলাদাভাবে দেখুন।",
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
        title: "ভল্টের বিস্তারিত পড়া যায়নি।",
        body: "প্যানেল বাক্সের read-only সারফেস থেকে তথ্য নিতে পারেনি।",
      };
    }
    if (!inspection) {
      return {
        tone: "slate",
        title: "ভল্টের বিস্তারিত আসছে...",
        body: "বাক্সের read-only সারফেস থেকে তথ্য আসছে।",
      };
    }
    switch (inspection.refusal) {
      case "unreachable":
        return {
          tone: "red",
          title: "বাক্সের read-only সারফেসে পৌঁছানো যাচ্ছে না।",
          body: "উপরের স্বাস্থ্যের খবর আলাদা বিষয় — বাক্স চালু থাকলেও এই সারফেসে ঢোকা যাচ্ছে না।",
        };
      case "unauthorized":
        return {
          tone: "amber",
          title: "বাক্স read-only কী মেনে নিচ্ছে না।",
          body: "বাক্সের READONLY_SERVICE_TOKEN আর এই সার্ভারের বাক্স-কী এক হতে হবে — অর্থাৎ PROXY_BOX_SECRET থেকে বের হওয়া ঐ বাক্সের নিজস্ব read-only কী।",
        };
      case "not_found":
        return {
          tone: "amber",
          title: "বাক্সে read-only সারফেস নেই।",
          body: "বাক্সে READONLY_SERVICE_TOKEN বসালে /readonly সারফেস চালু হবে।",
        };
      case "not_configured":
        return {
          tone: "amber",
          title: "এখানে বাক্সের কী বের করা যায়নি।",
          body: "এই সার্ভারে PROXY_BOX_SECRET নেই, বা কোনো বাক্স এনরোল করা নেই, বা বাক্সের ঠিকানা নেই — তাই বাক্সের বিস্তারিত পড়া হয়নি। স্বাস্থ্যের খবর উপরে আলাদা বিষয় — সেটা আপনার read-only কীর উপর নির্ভর করে না।",
        };
      case "error":
        return {
          tone: "red",
          title: "বাক্সের উত্তর বোঝা গেল না।",
          body: "বাক্স উত্তর দিয়েছে, কিন্তু এই প্যানেল তা পড়তে পারেনি।",
        };
      default:
        return {
          tone: "green",
          title: "ভল্টের বিস্তারিত পাওয়া গেছে।",
          body: "বাক্সের read-only সারফেস উত্তর দিয়েছে।",
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
            <h1 className="text-base font-bold text-white">২৪/৭ প্রক্সি কন্ট্রোল প্যানেল</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              স্ট্রিম বক্সের নিজের স্বাস্থ্যের খবর ও দৈনন্দিন কাজ।
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
              <span>এখনই দেখুন</span>
            </button>
            <Link
              href="/admin-secret-gate"
              className="text-[11px] font-bold px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:border-brand-500/40 transition-all"
            >
              প্যানেল বদলান
            </Link>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-slate-400">
          <span className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            সর্বশেষ পরীক্ষা:{" "}
            <span className="font-bold text-slate-200">
              {snapshot ? timeAgo(snapshot.checkedAt, now) : "—"}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" />
            সর্বশেষ সফল স্ন্যাপশট:{" "}
            <span className="font-bold text-slate-200">
              {lastSuccessAt ? timeAgo(lastSuccessAt, now) : "এখনো কোনোটি নয়"}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" />
            প্রতি {REFRESH_MS / 1000} সেকেন্ডে নিজে থেকে হালনাগাদ হয়
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
        <Card icon={<KeyRound className="w-4 h-4" />} title="বক্স তালিকা ও এনরোলমেন্ট">
          {boxesError ? (
            <p className="text-[11px] text-red-300">{boxesError}</p>
          ) : boxes.length === 0 ? (
            <p className="text-[11px] text-slate-400">
              এই সাইট এখনো কোনো বক্সকে এনরোল করেনি।
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
                    {box.baseUrl || "ঠিকানা এখনো জানা নেই"}
                  </p>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className="text-[10px] text-slate-500 truncate">
                      {box.enrolledAt
                        ? `এনরোল: ${new Date(box.enrolledAt).toLocaleString("bn-BD")}`
                        : "এনরোল হয়নি"}
                    </span>
                    {box.state === "enrolled" && (
                      <RowButton
                        onClick={() => revokeBox(box.boxId)}
                        disabled={busyBox !== null}
                        tone="amber"
                        title="বক্সটি বাতিল করুন"
                      >
                        {busyBox === `revoke:${box.boxId}` ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <ShieldOff className="w-3 h-3" />
                        )}
                        <span>বাতিল</span>
                      </RowButton>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 pt-3 border-t border-slate-800/60">
            <p className="text-[11px] font-bold text-slate-300">নতুন বক্স এনরোল করুন</p>
            <div className="mt-2 flex items-center gap-2">
              <input
                value={boxIdInput}
                onChange={(event) => setBoxIdInput(event.target.value)}
                placeholder="বক্সের আইডি"
                aria-label="বক্সের আইডি"
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
                <span>তৈরি করুন</span>
              </button>
            </div>
            <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
              বক্সের নিজের আইডি লিখুন — বক্সের কনফিগে লেখা{" "}
              <span className="text-slate-300">BOX_ID</span>। সাইট একটি একবারের কোড দেবে;
              সেই কোড বক্সের <span className="text-slate-300">config\enroll.code</span>{" "}
              ফাইলে বসিয়ে বক্সটি বন্ধ করে চালু করুন।
            </p>
          </div>
        </Card>

        {enrollment && (
          <Card icon={<KeyRound className="w-4 h-4" />} title="এনরোলমেন্ট কোড — একবারই দেখা যাবে">
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-[11px] font-bold text-amber-300">{enrollment.boxId}</p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  readOnly
                  value={enrollment.code}
                  aria-label="এনরোলমেন্ট কোড"
                  onFocus={(event) => event.currentTarget.select()}
                  className="flex-1 min-w-0 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 font-mono text-[11px] text-slate-100 outline-none"
                />
                <RowButton onClick={copyEnrollment} title="কোড কপি করুন">
                  {copied ? (
                    <Check className="w-3 h-3" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>{copied ? "কপি হয়েছে" : "কপি"}</span>
                </RowButton>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
              কোডটি শুধু এই একবারই দেখা যাবে — সাইট শুধু তার ছাপ রাখে, কোডটি নিজে নয়। বক্সের{" "}
              <span className="text-slate-300">config\enroll.code</span> ফাইলে কোডটি লিখে
              বক্সটি বন্ধ করে চালু করুন; বক্স নিজে সাইটের সাথে কথা বলে নিজের তিনটি
              ক্রেডেনশিয়াল নেবে, আর কোডটি একবার ব্যবহার হয়েই ফোঁটা হয়ে যাবে।
              {enrollment.expiresAt ? (
                <>
                  {" "}
                  কোডটির মেয়াদ শেষ হবে{" "}
                  <span className="text-slate-300">
                    {new Date(enrollment.expiresAt).toLocaleString("bn-BD")}
                  </span>
                  {" "}
                  তার আগে।
                </>
              ) : null}
            </p>
            <div className="mt-2">
              <RowButton onClick={() => setEnrollment(null)} title="কোডটি লুকান">
                কোডটি লুকান
              </RowButton>
            </div>
          </Card>
        )}
      </div>

      {snapshot && (
        <div className="grid lg:grid-cols-2 gap-4">
          <Card icon={<Server className="w-4 h-4" />} title="বক্স">
            <Row label="সার্ভিস" value={snapshot.service ?? "জানা নেই"} />
            <Row
              label="চালু থাকার সময়"
              value={snapshot.uptimeMs !== null ? formatDuration(snapshot.uptimeMs) : "জানা নেই"}
            />
            <Row label="কনফিগ করা সোর্স" value={snapshot.counters.sourcesConfigured} />
            <Row label="চলমান সেশন" value={snapshot.counters.sessions} />
            <Row label="সর্বোচ্চ একসাথে আপস্ট্রিম" value={snapshot.counters.maxConcurrentUpstream} />
            <Row label="মোট আপস্ট্রিম রান" value={snapshot.counters.upstreamRuns} />
            <Row label="অ্যাডমিন সারফেস" value={snapshot.surfaces.admin ? "মounted" : "নেই"} />
            <Row label="সাইনিং সারফেস" value={snapshot.surfaces.appApi ? "mounted" : "নেই"} />
          </Card>

          <Card
            icon={<Database className="w-4 h-4" />}
            title="ভল্ট"
            aside={
              <RowButton
                onClick={() => runAction("refresh_vault", null, undefined, null)}
                disabled={busyAction !== null}
                title="বাক্সকে তার ভল্ট আবার পড়তে বলুন"
              >
                {busyAction === "refresh_vault:" ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                <span>রিফ্রেশ</span>
              </RowButton>
            }
          >
            <Row label="ড্রাইভার" value={driverLabel(snapshot.vault.driver)} />
            <Row
              label="প্রস্তুত"
              value={
                snapshot.vault.ready ? (
                  <span className="text-emerald-300">হ্যাঁ</span>
                ) : (
                  <span className="text-amber-300">না</span>
                )
              }
            />
            <Row label="সংরক্ষিত প্রোভাইডার" value={snapshot.vault.stored} />
            <Row label="খোলা যায় এমন লেন" value={snapshot.vault.resolvable} />
            <Row label="পড়া যায়নি এমন প্রোভাইডার" value={snapshot.vault.unreadable} />
            <Row
              label="ভল্টে সমস্যা"
              value={
                snapshot.vault.hasError ? (
                  <span className="text-red-300">হ্যাঁ — বাক্সের লগে বিস্তারিত</span>
                ) : (
                  "নেই"
                )
              }
            />
          </Card>

          <Card icon={<ShieldAlert className="w-4 h-4" />} title="সেশনের মালিকানা">
            <Row label="ধরন" value={ownershipLabel(snapshot.ownership.mode)} />
            <Row label="এখন ধরে রাখা ক্লেইম" value={snapshot.ownership.held} />
            <Row label="মালিকানা প্রত্যাখ্যান" value={snapshot.ownership.refusals} />
            <p className="text-[11px] text-slate-400 mt-3 leading-relaxed">
              {snapshot.ownership.mode === "shared-filesystem"
                ? "এই মেশিনের সব প্রক্সি প্রসেস একই ফাইল লক মানে, তাই একই মেশিনে দ্বিতীয় প্রসেস চালু করলেও লেন দুইবার খোলা হবে না।"
                : "লকটি শুধু এই প্রসেসের মধ্যে। এই মেশিনে আরেকটি প্রক্সি প্রসেস চালু করলে সে নিজের আলাদা লেন খুলে নেবে।"}
            </p>
            <p className="text-[11px] text-amber-300/90 mt-2 leading-relaxed">
              দুটি আলাদা মেশিনের মধ্যে এই সীমা প্রয়োগ করা হয় না। সেটি এখনো বাস্তবায়িত নয়, তাই এখানে
              “নিরাপদ” বলে কিছু দেখানো হচ্ছে না।
            </p>
          </Card>

          <Card icon={<Activity className="w-4 h-4" />} title="ক্যাপাসিটি ও প্রত্যাখ্যান">
            <Row label="মোট প্রত্যাখ্যান" value={snapshot.capacity.refusals} />
            <Row label="লেন সংখ্যা" value={snapshot.capacity.lanes.length} />
            {snapshot.capacity.lanes.length > 0 && (
              <div className="mt-2 space-y-1">
                {snapshot.capacity.lanes.map((lane, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between text-[11px] text-slate-300"
                  >
                    <span>লেন {index + 1}</span>
                    <span className="font-bold">
                      {lane.channels} চ্যানেল / সর্বোচ্চ {lane.maxConnections}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {snapshot.capacity.last && (
              <div className="mt-3 pt-3 border-t border-slate-800/60 text-[11px] text-slate-400 space-y-1">
                <p className="font-bold text-slate-300">সর্বশেষ প্রত্যাখ্যান</p>
                {snapshot.capacity.last.channelKey && (
                  <p>চ্যানেল: {snapshot.capacity.last.channelKey}</p>
                )}
                {snapshot.capacity.last.code && <p>কোড: {snapshot.capacity.last.code}</p>}
                <p>
                  ধরে রাখা: {snapshot.capacity.last.holders} / সর্বোচ্চ{" "}
                  {snapshot.capacity.last.maxConnections}
                </p>
              </div>
            )}
          </Card>

          <Card icon={<ShieldAlert className="w-4 h-4" />} title="সাইট গেট">
            <Row label="মোড" value={guardLabel(snapshot.guard.mode)} />
            <Row
              label="গেট সক্রিয়"
              value={snapshot.guard.siteGateActive ? "হ্যাঁ" : "না"}
            />
            <Row label="তালিকাভুক্ত অনুরোধ" value={snapshot.guard.listed} />
            <Row label="ওয়াইল্ডকার্ড" value={snapshot.guard.wildcard} />
            <Row label="Origin ছাড়া" value={snapshot.guard.absent} />
            <Row label="বিদেশি Origin" value={snapshot.guard.foreign} />
            <Row label="Origin ছাড়া প্রত্যাখ্যান" value={snapshot.guard.absentRefused} />
          </Card>

          <Card icon={<Clock className="w-4 h-4" />} title="সময়">
            <Row
              label="এই পরীক্ষা"
              value={new Date(snapshot.checkedAt).toLocaleString("bn-BD")}
            />
            <Row
              label="সর্বশেষ সফল উত্তর"
              value={
                snapshot.lastSuccessAt
                  ? new Date(snapshot.lastSuccessAt).toLocaleString("bn-BD")
                  : "সার্ভারে নেই"
              }
            />
            <Row
              label="ব্রাউজারে সর্বশেষ সফল"
              value={lastSuccessAt ? new Date(lastSuccessAt).toLocaleString("bn-BD") : "নেই"}
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
              <Card icon={<Database className="w-4 h-4" />} title="ভল্টের প্রস্তুতি">
                <Row
                  label="সারফেসে পৌঁছানো"
                  value={
                    inspection.reachable ? (
                      <span className="text-emerald-300">হ্যাঁ</span>
                    ) : (
                      <span className="text-amber-300">না</span>
                    )
                  }
                />
                <Row label="ড্রাইভার" value={driverLabel(inspection.vault.driver)} />
                <Row
                  label="প্রস্তুত"
                  value={
                    inspection.vault.ready ? (
                      <span className="text-emerald-300">হ্যাঁ</span>
                    ) : (
                      <span className="text-amber-300">না</span>
                    )
                  }
                />
                <Row label="প্রোভাইডার সংখ্যা" value={inspection.vault.providers} />
                <Row label="সংরক্ষিত চ্যানেল" value={inspection.vault.stored} />
                <Row label="খোলা যায় এমন চ্যানেল" value={inspection.vault.resolvable} />
                <Row label="পড়া যায়নি এমন চ্যানেল" value={inspection.vault.unreadable} />
                <Row
                  label="ভল্টে সমস্যা"
                  value={
                    inspection.vault.hasError ? (
                      <span className="text-red-300">হ্যাঁ — বাক্সের লগে বিস্তারিত</span>
                    ) : (
                      "নেই"
                    )
                  }
                />
                <Row
                  label="সর্বশেষ রিফ্রেশ"
                  value={
                    inspection.vault.lastRefreshAt
                      ? new Date(inspection.vault.lastRefreshAt).toLocaleString("bn-BD")
                      : "জানা নেই"
                  }
                />
              </Card>

              <Card icon={<Layers className="w-4 h-4" />} title="লেন ও ক্যাপাসিটি">
                <Row label="প্রোভাইডার ব্যস্ত প্রত্যাখ্যান" value={inspection.capacity.providerBusy} />
                <Row label="সর্বোচ্চ একসাথে আপস্ট্রিম" value={inspection.capacity.maxConcurrentUpstream} />
                <Row label="কনফিগ করা সোর্স" value={inspection.capacity.sourcesConfigured} />
                <Row label="মোট আপস্ট্রিম রান" value={inspection.capacity.upstreamRuns} />
                <Row label="এখন ধরে রাখা ক্লেইম" value={inspection.ownership.held} />
                <Row label="মালিকানা প্রত্যাখ্যান" value={inspection.ownership.refusals} />
                {inspection.lanes.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {inspection.lanes.map((lane, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between gap-3 text-[11px] text-slate-300"
                      >
                        <span className="truncate">
                          লেন {index + 1} · {lane.providerId}
                        </span>
                        <span className="font-bold shrink-0">
                          {lane.holders.length} চ্যানেল / সর্বোচ্চ {lane.maxConnections}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {inspection.capacity.last && (
                  <div className="mt-3 pt-3 border-t border-slate-800/60 text-[11px] text-slate-400 space-y-1">
                    <p className="font-bold text-slate-300">সর্বশেষ প্রত্যাখ্যান</p>
                    {inspection.capacity.last.channelKey && (
                      <p>চ্যানেল: {inspection.capacity.last.channelKey}</p>
                    )}
                    {inspection.capacity.last.code && <p>কোড: {inspection.capacity.last.code}</p>}
                    <p>
                      ধরে রাখা: {inspection.capacity.last.holders} / সর্বোচ্চ{" "}
                      {inspection.capacity.last.maxConnections}
                    </p>
                  </div>
                )}
              </Card>

              <Card icon={<HardDrive className="w-4 h-4" />} title="প্রোভাইডার">
                {inspection.providers.length === 0 ? (
                  <p className="text-[11px] text-slate-400">কোনো প্রোভাইডার নেই।</p>
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
                            {provider.active ? "চালু" : "বন্ধ"}
                          </span>
                        </div>
                        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400">
                          <span className="truncate">
                            আইডি: <span className="text-slate-300">{provider.providerId}</span>
                          </span>
                          <span>
                            ধরন: <span className="text-slate-300">{provider.kind ?? "—"}</span>
                          </span>
                          <span className="truncate">
                            সার্ভার:{" "}
                            <span className="text-slate-300 break-all">
                              {provider.server || "—"}
                            </span>
                          </span>
                          <span className="truncate">
                            ইউজার:{" "}
                            <span className="text-slate-300">
                              {provider.usernameHint || "—"}
                            </span>
                          </span>
                          <span>
                            সর্বোচ্চ সংযোগ:{" "}
                            <span className="text-slate-300">{provider.maxConnections}</span>
                          </span>
                          <span>
                            চ্যানেল:{" "}
                            <span className="text-slate-300">{provider.channels.length}</span>
                          </span>
                        </div>
                        {provider.problem && (
                          <p className="mt-1.5 text-[11px] text-amber-300">
                            সমস্যা: {providerProblemLabel(provider.problem)}
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
                                  ? `প্রোভাইডার "${provider.label || provider.providerId}" বন্ধ করবেন? এর নিচের সব চ্যানেল আর খুলবে না।`
                                  : `প্রোভাইডার "${provider.label || provider.providerId}" চালু করবেন?`
                              )
                            }
                            disabled={busyAction !== null}
                            tone={provider.active ? "amber" : "slate"}
                            title={
                              provider.active
                                ? "প্রোভাইডার বন্ধ করুন"
                                : "প্রোভাইডার চালু করুন"
                            }
                          >
                            <Power className="w-3 h-3" />
                            <span>{provider.active ? "বন্ধ করুন" : "চালু করুন"}</span>
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

              <Card icon={<Tv className="w-4 h-4" />} title="চ্যানেল ও প্রোভাইডার">
                {inspection.channels.length === 0 ? (
                  <p className="text-[11px] text-slate-400">কোনো চ্যানেল নেই।</p>
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
                                  ? `চ্যানেল "${channel.displayName || channel.channelKey}" বন্ধ করবেন? এটি আর খুলবে না।`
                                  : `চ্যানেল "${channel.displayName || channel.channelKey}" চালু করবেন?`
                              )
                            }
                            disabled={busyAction !== null}
                            tone={channel.active ? "amber" : "slate"}
                            title={
                              channel.active ? "চ্যানেল বন্ধ করুন" : "চ্যানেল চালু করুন"
                            }
                          >
                            <Power className="w-3 h-3" />
                            <span>{channel.active ? "বন্ধ" : "চালু"}</span>
                          </RowButton>
                          <RowButton
                            onClick={() =>
                              runAction(
                                "probe_channel",
                                channel.channelKey,
                                undefined,
                                `চ্যানেল "${channel.displayName || channel.channelKey}" যাচাই করতে একটি সংযোগ খোলা হবে — প্রোভাইডারের সংযোগ সীমার একটি জায়গা নেয়।`
                              )
                            }
                            disabled={busyAction !== null}
                            title="চ্যানেলের সোর্স যাচাই করুন"
                          >
                            <Radio className="w-3 h-3" />
                            <span>যাচাই</span>
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
