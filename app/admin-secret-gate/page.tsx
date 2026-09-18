"use client";

import { useState, useEffect } from "react";
import Header from "@/components/Header";
import AdminDashboard from "@/components/AdminDashboard";
import { KeyRound, Lock, AlertCircle, LogOut, RefreshCw } from "lucide-react";

const STORAGE_KEY = "freetv_admin_secret";

export default function AdminGatePage() {
  const [passcode, setPasscode] = useState("");
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [hydrating, setHydrating] = useState(true);

  // Restore session from localStorage on mount
  useEffect(() => {
    const storedKey = localStorage.getItem(STORAGE_KEY);
    if (storedKey) {
      // Validate the stored key against the backend
      validateKey(storedKey)
        .then((valid) => {
          if (valid) {
            setPasscode(storedKey);
            setIsAuthorized(true);
          } else {
            // Stored key is invalid/expired, clear it
            localStorage.removeItem(STORAGE_KEY);
          }
        })
        .finally(() => setHydrating(false));
    } else {
      setHydrating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const validateKey = async (key: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/admin/stats?secretKey=${encodeURIComponent(key)}`, {
        headers: { "x-admin-secret": key },
      });
      const data = await res.json();
      return data.success === true;
    } catch {
      return false;
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPasscode = passcode.trim();
    if (!cleanPasscode) return;

    setVerifying(true);
    setErrorMsg(null);

    try {
      const res = await fetch(`/api/admin/stats?secretKey=${encodeURIComponent(cleanPasscode)}`, {
        headers: { "x-admin-secret": cleanPasscode },
      });
      const data = await res.json();

      if (data.success) {
        setPasscode(cleanPasscode);
        setIsAuthorized(true);
        // Persist to localStorage
        localStorage.setItem(STORAGE_KEY, cleanPasscode);
      } else if (res.status === 401) {
        setErrorMsg("Access Denied: Invalid Admin Secret Key");
      } else {
        setErrorMsg(data.error || "Server error verifying admin key");
      }
    } catch {
      setErrorMsg("Error verifying admin credentials");
    } finally {
      setVerifying(false);
    }
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
        {/* Loading state while restoring session */}
        {hydrating ? (
          <div className="max-w-md mx-auto my-12 text-center">
            <div className="glass-panel p-8 rounded-3xl border border-slate-800 shadow-2xl">
              <RefreshCw className="w-8 h-8 text-brand-500 animate-spin mx-auto mb-3" />
              <p className="text-sm font-bold text-white">Restoring Admin Session...</p>
              <p className="text-xs text-slate-400 mt-1">Validating stored credentials</p>
            </div>
          </div>
        ) : !isAuthorized ? (
          <div className="max-w-md mx-auto my-12">
            <div className="glass-panel p-8 rounded-3xl border border-slate-800 shadow-2xl text-center">
              <div className="w-14 h-14 rounded-2xl bg-brand-600/10 border border-brand-500/30 text-brand-500 flex items-center justify-center mx-auto mb-4">
                <Lock className="w-7 h-7" />
              </div>

              <h1 className="text-xl font-bold text-white mb-2">Hidden Admin Gate</h1>
              <p className="text-xs text-slate-400 mb-6">
                Enter your <code className="text-brand-400 font-mono">ADMIN_SECRET_KEY</code> to access M3U stream ingestion & worker controls.
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
                  {verifying ? "Verifying Secret..." : "Unlock Admin Gate"}
                </button>
              </form>
            </div>
          </div>
        ) : (
          <div>
            {/* Logout Bar */}
            <div className="flex items-center justify-end mb-4">
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-slate-900 text-slate-400 hover:text-red-400 border border-slate-800 hover:border-red-500/40 transition-all"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Logout Admin</span>
              </button>
            </div>
            <AdminDashboard secretKey={passcode} />
          </div>
        )}
      </main>
    </div>
  );
}
