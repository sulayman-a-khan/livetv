/**
 * Sports Arena Service (lib/sportsArenaService.ts)
 *
 * Dedicated service for Live Sports Arena events fed by the Local PC Server (Port 5000/5001).
 *
 * Key Architectural Rules:
 * 1. Server-Controlled Feed: The panel (Local PC Server) owns the upstream source and
 *    switches it automatically or manually; viewers receive one live URL and have no control.
 * 2. PC Bridge Integration: Polls control signals and status from the local encoder (Port 5000).
 */

export interface SportsEvent {
  id: string;
  _id?: string;
  matchTitle: string;
  sportType: string;
  startTime: string;
  endTime: string;
  status: "scheduled" | "live" | "ended";
  primaryStreamUrl: string;
  streamUrl?: string;
  backupStreamUrls?: string[];
  isLocalServerActive?: boolean;
  priorityOrder?: number;
}

export interface LocalServerStatus {
  online: boolean;
  nodeId?: string;
  activeEventsCount: number;
  uptimeSeconds?: number;
  lastHeartbeat?: string;
}

/**
 * Fetches current live/scheduled Sports Arena matches.
 */
export async function fetchLiveSportsEvents(): Promise<SportsEvent[]> {
  try {
    const t = Date.now();
    const res = await fetch(`/api/events?_t=${t}`, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
      },
    });

    let rawData: any = null;
    if (res.ok) {
      rawData = await res.json();
    } else {
      const altRes = await fetch(`/api/sports/events?_t=${t}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate", Pragma: "no-cache" },
      }).catch(() => null);

      if (altRes && altRes.ok) {
        rawData = await altRes.json();
      }
    }

    const list: any[] = Array.isArray(rawData)
      ? rawData
      : Array.isArray(rawData?.events)
      ? rawData.events
      : Array.isArray(rawData?.data)
      ? rawData.data
      : [];

    return list.map((e) => ({
      id: e.id || e._id || "",
      _id: e._id || e.id || "",
      matchTitle: e.matchTitle || "Live Match",
      sportType: e.sportType || "Live Sports",
      startTime: e.startTime || new Date().toISOString(),
      endTime: e.endTime || new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
      status: e.status || "live",
      primaryStreamUrl: e.primaryStreamUrl || e.streamUrl || "",
      streamUrl: e.streamUrl || e.primaryStreamUrl || "",
      backupStreamUrls: e.backupStreamUrls || [],
      isLocalServerActive: Boolean(e.isLocalServerActive),
      priorityOrder: e.priorityOrder ?? 99,
    }));
  } catch (err) {
    console.error("[SportsArenaService] fetchLiveSportsEvents failed:", err);
    return [];
  }
}

/**
 * Polls the status and control signals of the Local PC Bridge Server (Port 5000 / API).
 */
export async function checkLocalPcBridgeStatus(): Promise<LocalServerStatus> {
  try {
    // Attempt local bridge server ping directly or via cloud proxy
    const localRes = await fetch("http://127.0.0.1:5000/api/status", {
      signal: AbortSignal.timeout(1500),
    }).catch(() => null);

    if (localRes && localRes.ok) {
      const data = await localRes.json();
      return {
        online: true,
        nodeId: data.nodeId || "local-pc-node",
        activeEventsCount: data.eventsCount || 0,
        uptimeSeconds: data.uptime || 0,
        lastHeartbeat: new Date().toISOString(),
      };
    }

    // Fallback: check cloud sports server health
    const cloudRes = await fetch(`/api/sports/health-check?_t=${Date.now()}`, {
      cache: "no-store",
    }).catch(() => null);

    if (cloudRes && cloudRes.ok) {
      const cloudData = await cloudRes.json();
      return {
        online: Boolean(cloudData.online ?? cloudData.isLocalServerActive),
        nodeId: cloudData.nodeId,
        activeEventsCount: cloudData.activeCount ?? 0,
        lastHeartbeat: cloudData.lastHeartbeat,
      };
    }

    return { online: false, activeEventsCount: 0 };
  } catch {
    return { online: false, activeEventsCount: 0 };
  }
}
