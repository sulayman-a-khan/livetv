"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One channel as the account itself names it.
 *
 * The credential is not in this shape and cannot be added to it: the box asks the account's
 * own panel and answers with the stream id and the name, and the site keeps exactly that.
 */
export interface CatalogueChannel {
  streamId: string;
  name: string;
  category: string;
}

export interface ProviderCatalogueRead {
  channels: CatalogueChannel[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Reads one account's own channel list from the box.
 *
 * A closed panel does not ask: the list is a question about the box, and the box is somebody
 * else's machine, so it is read when the section that shows it is open and not otherwise.
 */
export function useProviderCatalogue(
  secretKey: string,
  providerId: string,
  active: boolean
): ProviderCatalogueRead {
  const [channels, setChannels] = useState<CatalogueChannel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!providerId) {
      setChannels([]);
      setError(null);
      setLoading(false);
      return;
    }
    const ticket = ++seq.current;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/premium/providers/${encodeURIComponent(providerId)}/channels`,
        {
          headers: { "x-admin-secret": secretKey.trim() },
          cache: "no-store",
        }
      );
      const data = await res.json();
      if (ticket !== seq.current) return;
      if (data.success) {
        setChannels(Array.isArray(data.channels) ? data.channels : []);
        setError(null);
      } else {
        setChannels([]);
        setError(data.error || `Failed to read the account's channels (${res.status})`);
      }
    } catch (err: any) {
      if (ticket !== seq.current) return;
      setChannels([]);
      setError(`Error reading the account's channels: ${err.message}`);
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
  }, [secretKey, providerId]);

  useEffect(() => {
    if (!active) return;
    reload();
  }, [active, reload]);

  return { channels, loading, error, reload };
}
