"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One provider as this site is allowed to see it.
 *
 * The credential is not in this shape and cannot be added to it: the box's admin surface sends
 * a masked address and a two-character hint, and the site keeps them exactly as they arrive.
 */
export interface BoxProvider {
  providerId: string;
  label: string;
  active: boolean;
  kind: string | null;
  server: string;
  usernameHint: string;
  maxConnections: number;
  ownHeaders: boolean;
  channels: string[];
  problem: string | null;
}

export interface BoxProviderRead {
  /** The box answered at all. */
  reachable: boolean;
  /** The box answered and accepted this server's credential. */
  authorized: boolean;
  providers: BoxProvider[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Reads the provider list from the box for the panels that need it.
 *
 * A closed panel does not ask. The list is a question about the box, and the box is somebody
 * else's machine, so it is read when the section that shows it is open and not otherwise.
 */
export function useBoxProviders(secretKey: string, active: boolean): BoxProviderRead {
  const [reachable, setReachable] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [providers, setProviders] = useState<BoxProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const ticket = ++seq.current;
    setLoading(true);
    try {
      const res = await fetch("/api/admin/premium/providers", {
        headers: { "x-admin-secret": secretKey.trim() },
        cache: "no-store",
      });
      const data = await res.json();
      if (ticket !== seq.current) return;
      if (data.success) {
        setReachable(Boolean(data.reachable));
        setAuthorized(Boolean(data.authorized));
        setProviders(Array.isArray(data.providers) ? data.providers : []);
        setError(null);
      } else {
        setError(data.error || `Failed to load the provider list (${res.status})`);
      }
    } catch (err: any) {
      if (ticket !== seq.current) return;
      setError(`Error loading the provider list: ${err.message}`);
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
  }, [secretKey]);

  useEffect(() => {
    if (!active) return;
    reload();
  }, [active, reload]);

  return { reachable, authorized, providers, loading, error, reload };
}
