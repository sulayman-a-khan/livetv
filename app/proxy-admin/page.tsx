"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Header from "@/components/Header";
import ProxyAdminDashboard from "@/components/proxy-admin/ProxyAdminDashboard";
import { AlertCircle, KeyRound, Lock, LogOut, RefreshCw } from "lucide-react";

/** The same admin secret the other two panels use — one credential, three panels. */
const STORAGE_KEY = "freetv_admin_secret";

/**
 * The 24/7 proxy control panel, on its own route.
 *
 * Verification here goes to `/api/admin/proxy/session` only: this page never calls a Direct
 * HLS route or the premium tier's route, so the panel can be opened, used and signed out of
 * without the other admin surfaces being loaded, asked anything, or changed.
 *
 * The panel reads the box and can ask this server to perform a named action on it. It holds
 * no proxy credential: the browser carries the site admin secret and nothing else, and the
 * box's write token stays on the server.
 */
export default function ProxyAdminPage() {
  const [passcode, setPasscode] = useState("");
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [hydrating, setHydrating] = useState(true);

  const verify = useCallback(async (key: string): Promise<boolean> => {
    try {
      const res = await fetch("/api/admin/proxy/session", {
        headers: { "x-admin-secret": key },
        cache: "no-store",
      });
      const data = await res.json();
      return data.success === true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      setHydrating(false);
      return;
    }
    verify(stored)
      .then((valid) => {
        if (valid) {
          setPasscode(stored);
          setIsAuthorized(true);
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      })
      .finally(() => setHydrating(false));
  }, [verify]);

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = passcode.trim();
    if (!clean) return;

    setVerifying(true);
    setErrorMsg(null);
    const valid = await verify(clean);
    if (valid) {
      localStorage.setItem(STORAGE_KEY, clean);
      setIsAuthorized(true);
    } else {
      setErrorMsg("Access Denied: Invalid Admin Secret Key");
    }
    setVerifying(false);
  };

  const handleLogout = () => {
    localStorage.removeItem(STORAGE_KEY);
    setIsAuthorized(false);
    setPasscode("");
    setErrorMsg(null);
  };

  return (
    <div className="min-h-screen">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {hydrating ? (
          <div className="max-w-md mx-auto my-12 text-center">
            <div className="glass-panel p-8 rounded-3xl border border-slate-800 shadow-2xl">
              <RefreshCw className="w-8 h-8 text-brand-500 animate-spin mx-auto mb-3" />
              <p className="text-sm font-bold text-white">সেশন ফিরিয়ে আনা হচ্ছে...</p>
              <p className="text-xs text-slate-400 mt-1">আগের কী যাচাই করা হচ্ছে</p>
            </div>
          </div>
        ) : !isAuthorized ? (
          <div className="max-w-md mx-auto my-12">
            <div className="glass-panel p-8 rounded-3xl border border-slate-800 shadow-2xl text-center">
              <div className="w-14 h-14 rounded-2xl bg-cyan-600/10 border border-cyan-500/30 text-cyan-300 flex items-center justify-center mx-auto mb-4">
                <Lock className="w-7 h-7" />
              </div>

              <h1 className="text-xl font-bold text-white mb-2">২৪/৭ প্রক্সি কন্ট্রোল</h1>
              <p className="text-xs text-slate-400 mb-6">
                স্ট্রিম বক্সের অবস্থা দেখতে{" "}
                <code className="text-brand-400 font-mono">ADMIN_SECRET_KEY</code> দিন।
              </p>

              <form onSubmit={handleVerify} className="space-y-4">
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    placeholder="Enter Admin Secret Key..."
                    value={passcode}
                    onChange={(e) => setPasscode(e.target.value)}
                    className="w-full bg-slate-900 text-sm text-white placeholder-slate-600 pl-9 pr-4 py-3 rounded-xl border border-slate-800 focus:outline-none focus:border-brand-500"
                  />
                </div>

                {errorMsg && (
                  <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{errorMsg}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={verifying || !passcode.trim()}
                  className="w-full py-3 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-brand-600/30 disabled:opacity-50"
                >
                  {verifying ? "Verifying Secret..." : "Unlock Proxy Control"}
                </button>
              </form>

              <div className="mt-5 pt-5 border-t border-slate-800">
                <Link
                  href="/admin-secret-gate"
                  className="text-[11px] font-bold text-slate-400 hover:text-white transition-colors"
                >
                  Back to admin panel choice
                </Link>
              </div>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-end gap-2 mb-4">
              <Link
                href="/admin-secret-gate"
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-slate-900 text-slate-400 hover:text-white border border-slate-800 hover:border-brand-500/40 transition-all"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Switch Panel</span>
              </Link>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-slate-900 text-slate-400 hover:text-red-400 border border-slate-800 hover:border-red-500/40 transition-all"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Logout Admin</span>
              </button>
            </div>
            <ProxyAdminDashboard secretKey={passcode} />
          </div>
        )}
      </main>
    </div>
  );
}
