"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  HardDrive,
  Layers,
  Loader2,
  RefreshCw,
  Server,
  ShieldAlert,
  Tv,
} from "lucide-react";
import type { ProxyBoxSnapshot, ProxyInspectSnapshot } from "@/lib/proxyControl";

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
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="glass-panel rounded-2xl border border-slate-800 p-5">
      <div className="flex items-center gap-2.5 mb-3">
        <span className="text-cyan-300">{icon}</span>
        <h2 className="text-sm font-bold text-white">{title}</h2>
      </div>
      {children}
    </section>
  );
}

/**
 * The 24/7 proxy control panel.
 *
 * Read-only by construction: it asks the box what it can see and shows it. It has no button
 * that changes anything upstream, no field that could carry a credential, and no credential
 * of its own — the browser holds the site admin secret and nothing else. The health route
 * asks for no token at all, and the inspection routes are read with a token that stays on
 * this server, so this panel cannot leak one even if the whole page were copied.
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

  const refreshAll = useCallback(async () => {
    await Promise.all([load(), loadInspection()]);
  }, [load, loadInspection]);

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
      default:
        return {
          tone: "slate",
          title: "স্ট্রিম বক্সের অবস্থা এখনো জানা নেই।",
          body: "এখনো কোনো উত্তর পাওয়া যায়নি।",
        };
    }
  })();

  const toneClass = {
    green: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
    amber: "bg-amber-500/10 border-amber-500/30 text-amber-300",
    red: "bg-red-500/10 border-red-500/30 text-red-300",
    slate: "bg-slate-500/10 border-slate-500/30 text-slate-300",
  }[banner.tone];

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
          body: "বাক্সের READONLY_SERVICE_TOKEN আর এখানকার PROXY_READONLY_TOKEN এক হতে হবে, অথবা একটিই বসানো হয়নি।",
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
          title: "এখানে read-only কী বসানো নেই।",
          body: "এই সার্ভারে PROXY_READONLY_TOKEN নেই, তাই বাক্সের বিস্তারিত পড়া হয়নি। স্বাস্থ্যের খবর উপরে আলাদা বিষয় — সেটা আপনার read-only কীর উপর নির্ভর করে না।",
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
          body: "বাক্সের read-only সারফেস উত্তর দিয়েছে। এখানে কোনো লেখা বা বদলানোর বাটন নেই।",
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
              স্ট্রিম বক্সের নিজের স্বাস্থ্যের খবর। এই প্যানেল কোনো কিছু বদলায় না — শুধু পড়ে ও দেখায়।
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

          <Card icon={<Database className="w-4 h-4" />} title="ভল্ট">
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
                        <div className="text-right shrink-0">
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
