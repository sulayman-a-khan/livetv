"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { getChannelLogo, getCountryFlag } from "@/lib/utils";
import ChannelEditModal, { EditableChannel } from "@/components/ChannelEditModal";
import { CATEGORIES, getCategoryBySlug, isChannelInCategory } from "@/lib/categories";
import {
  ShieldAlert,
  Database,
  Activity,
  CheckCircle2,
  AlertTriangle,
  Trash2,
  PlusCircle,
  RefreshCw,
  Zap,
  Radio,
  FileCode,
  Layers,
  CheckSquare,
  Square,
  Search,
  Filter,
  X,
  ArrowUpDown,
  SlidersHorizontal,
  Pin,
  PinOff,
  GripVertical,
  MoveUp,
  MoveDown,
  Save,
  Check,
  Upload,
  Image as ImageIcon,
  Edit2,
  Wrench,
  Clock,
  ChevronDown,
  Loader2,
} from "lucide-react";

interface AdminDashboardProps {
  secretKey: string;
}

interface StatsData {
  totalChannels: number;
  totalStreams: number;
  activeStreams: number;
  degradedStreams: number;
  brokenStreams: number;
}

interface ChannelWithStreams {
  _id: string;
  name: string;
  normalizedName: string;
  category: string;
  country: string;
  logo: string;
  isPinned?: boolean;
  priorityOrder?: number;
  subCategory?: string;
  tags?: string[];
  isManuallyEdited?: boolean;
  streams: Array<{
    _id: string;
    url: string;
    status: "active" | "degraded" | "broken";
    latency: number;
    failedAttempts: number;
    priority?: number;
  }>;
}

interface IngestProgress {
  phase: string;
  message: string;
  lines: string[];
  current: number;
  total: number;
  percent: number;
  done: boolean;
}

interface HealthSchedule {
  running: boolean;
  pinnedIntervalMinutes: number;
  fullIntervalMinutes: number;
  lastCheckAt: string;
  lastFullCheckAt: string;
}

/** Short labels for the six fixed categories, matching the player filters. */
const ADMIN_CATEGORY_LABELS: Record<string, string> = {
  "sports-tv": "Sports",
  "bangladeshi-tv": "Bangla",
  "indian-tv": "Indian",
  "pakistani-tv": "Pakistani",
  "news-tv": "News",
  "global-tv": "Global",
};

/** True when a channel belongs to the given pinned-board tab ("all" or a category slug). */
function channelInPinnedTab(
  ch: { category?: string; country?: string; name?: string },
  tabId: string
): boolean {
  if (tabId === "all") return true;
  const cfg = getCategoryBySlug(tabId);
  return cfg ? isChannelInCategory(ch, cfg) : true;
}

export default function AdminDashboard({ secretKey }: AdminDashboardProps) {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [channels, setChannels] = useState<ChannelWithStreams[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Multi-select / Mark & Delete state
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  // Filter & Search states
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "hidden" | "degraded">("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sortBy, setSortBy] = useState<"name-asc" | "name-desc" | "streams-desc" | "active-desc">("name-asc");

  // M3U Ingestion Form State
  const [m3uText, setM3uText] = useState("");
  const [m3uUrl, setM3uUrl] = useState("");
  const [ingestLoading, setIngestLoading] = useState(false);
  const [ingestLog, setIngestLog] = useState<string | null>(null);
  const [ingestProgress, setIngestProgress] = useState<IngestProgress | null>(null);

  // Health check button loading state
  const [healthCheckLoading, setHealthCheckLoading] = useState(false);
  const [healthCheckLog, setHealthCheckLog] = useState<string | null>(null);

  // Auto health-checker schedule (for the next-probe countdown timer)
  const [schedule, setSchedule] = useState<HealthSchedule | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  // Pinning & Reordering states
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [reorderSaved, setReorderSaved] = useState(false);
  const [pinnedExpanded, setPinnedExpanded] = useState(false);
  const [pinnedOrder, setPinnedOrder] = useState<ChannelWithStreams[]>([]);
  const [pinCategoryTab, setPinCategoryTab] = useState<string>("all");
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  // Manual Logo Edit & File Upload states
  const [editingChannel, setEditingChannel] = useState<{ id: string; name: string; logo: string } | null>(null);
  const [logoInput, setLogoInput] = useState("");
  const [savingLogo, setSavingLogo] = useState(false);

  // Full channel editor (metadata + manual server links)
  const [editorChannelId, setEditorChannelId] = useState<string | null>(null);

  // Catalogue maintenance pass
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);
  const [maintenanceLog, setMaintenanceLog] = useState<string | null>(null);

  // Fetch admin dashboard statistics and channel breakdown
  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const cleanKey = secretKey.trim();
      const res = await fetch(`/api/admin/stats?secretKey=${encodeURIComponent(cleanKey)}`, {
        headers: {
          "x-admin-secret": cleanKey,
        },
      });
      const data = await res.json();
      if (data.success) {
        setStats(data.stats);
        setChannels(data.channels);
        const pinned = (data.channels as ChannelWithStreams[])
          .filter((c) => c.isPinned)
          .sort((a, b) => (a.priorityOrder ?? 99) - (b.priorityOrder ?? 99));
        setPinnedOrder(pinned);
      }
    } catch (err) {
      console.error("Failed to load admin stats:", err);
    } finally {
      setLoading(false);
    }
  }, [secretKey]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Fetch the auto health-checker schedule, then keep a local 1s clock ticking
  // so the "next probe" countdown updates every second without re-fetching.
  const fetchSchedule = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/health-status", { cache: "no-store" });
      const data = await res.json();
      if (data.success && data.autoHealthChecker) {
        setSchedule(data.autoHealthChecker as HealthSchedule);
      }
    } catch (err) {
      console.error("Failed to load health schedule:", err);
    }
  }, []);

  useEffect(() => {
    fetchSchedule();
  }, [fetchSchedule]);

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Countdown to the next pinned probe (5 min) and next full scan (10 min),
  // derived from the server's last-run timestamps.
  const nextProbe = useMemo(() => {
    const fmt = (ms: number) => {
      const clamped = Math.max(0, ms);
      const totalSec = Math.floor(clamped / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    };
    const nextFrom = (lastAt: string, intervalMin: number): number | null => {
      const t = Date.parse(lastAt);
      return Number.isNaN(t) ? null : t + intervalMin * 60 * 1000;
    };
    if (!schedule) {
      return { pinned: null as string | null, full: null as string | null, soonest: null as string | null, running: false };
    }
    const pinnedNext = schedule.lastCheckAt ? nextFrom(schedule.lastCheckAt, schedule.pinnedIntervalMinutes) : null;
    const fullNext = schedule.lastFullCheckAt ? nextFrom(schedule.lastFullCheckAt, schedule.fullIntervalMinutes) : null;
    const candidates = [pinnedNext, fullNext].filter((x): x is number => x !== null);
    const soonest = candidates.length ? Math.min(...candidates) : null;
    return {
      pinned: pinnedNext !== null ? fmt(pinnedNext - nowTick) : null,
      full: fullNext !== null ? fmt(fullNext - nowTick) : null,
      soonest: soonest !== null ? fmt(soonest - nowTick) : null,
      running: schedule.running,
    };
  }, [schedule, nowTick]);

  // The six fixed display categories (Sports, Bangla, Indian, Pakistani, News,
  // Global). The admin filter offers exactly these and matches channels with the
  // same logic the player uses — no ad-hoc categories from raw data.
  const categories = CATEGORIES;

  // Compute filtered and sorted channel list
  const filteredChannels = useMemo(() => {
    return channels
      .filter((ch) => {
        // Search filter (channel name, normalized slug, or category)
        if (searchTerm.trim()) {
          const term = searchTerm.toLowerCase();
          const matchName = ch.name.toLowerCase().includes(term);
          const matchNorm = ch.normalizedName.toLowerCase().includes(term);
          const matchCat = ch.category.toLowerCase().includes(term);
          if (!matchName && !matchNorm && !matchCat) return false;
        }

        // Status filter
        const activeCount = ch.streams.filter((s) => s.status === "active").length;
        const degradedCount = ch.streams.filter((s) => s.status === "degraded").length;

        if (statusFilter === "active" && activeCount === 0) return false;
        if (statusFilter === "hidden" && activeCount > 0) return false;
        if (statusFilter === "degraded" && degradedCount === 0) return false;

        // Category filter (one of the six fixed categories)
        if (categoryFilter !== "all") {
          const cfg = getCategoryBySlug(categoryFilter);
          if (cfg && !isChannelInCategory(ch, cfg)) return false;
        }

        return true;
      })
      .sort((a, b) => {
        if (sortBy === "name-asc") return a.name.localeCompare(b.name);
        if (sortBy === "name-desc") return b.name.localeCompare(a.name);
        if (sortBy === "streams-desc") return b.streams.length - a.streams.length;
        if (sortBy === "active-desc") {
          const aAct = a.streams.filter((s) => s.status === "active").length;
          const bAct = b.streams.filter((s) => s.status === "active").length;
          return bAct - aAct;
        }
        return 0;
      });
  }, [channels, searchTerm, statusFilter, categoryFilter, sortBy]);

  const hasActiveFilters =
    searchTerm.trim() !== "" ||
    statusFilter !== "all" ||
    categoryFilter !== "all" ||
    sortBy !== "name-asc";

  const clearAllFilters = () => {
    setSearchTerm("");
    setStatusFilter("all");
    setCategoryFilter("all");
    setSortBy("name-asc");
  };

  const isAllSelected =
    filteredChannels.length > 0 &&
    filteredChannels.every((c) => selectedIds.includes(c._id));

  // Mark / Select logic for filtered channels
  const toggleSelectAll = () => {
    if (isAllSelected) {
      const filteredIdSet = new Set(filteredChannels.map((c) => c._id));
      setSelectedIds((prev) => prev.filter((id) => !filteredIdSet.has(id)));
    } else {
      const newIds = new Set(selectedIds);
      filteredChannels.forEach((c) => newIds.add(c._id));
      setSelectedIds(Array.from(newIds));
    }
  };

  const toggleSelectChannel = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  // Bulk Delete Marked Channels
  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    if (
      !confirm(
        `Are you sure you want to permanently delete ${selectedIds.length} marked channels and all associated stream links?`
      )
    ) {
      return;
    }

    setBulkDeleting(true);
    try {
      const res = await fetch("/api/admin/channels/bulk-delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": secretKey.trim(),
        },
        body: JSON.stringify({ ids: selectedIds }),
      });
      const data = await res.json();
      if (data.success) {
        setSelectedIds([]);
        fetchStats();
      } else {
        alert(`Bulk delete failed: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Error performing bulk delete: ${err.message}`);
    } finally {
      setBulkDeleting(false);
    }
  };

  // Handle M3U Ingestion
  const handleIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!m3uText.trim() && !m3uUrl.trim()) return;

    setIngestLoading(true);
    setIngestLog(null);
    setIngestProgress({
      phase: "Connecting",
      message: "Contacting server...",
      lines: [],
      current: 0,
      total: 0,
      percent: 0,
      done: false,
    });

    const pushLine = (line: string) =>
      setIngestProgress((p) => (p ? { ...p, lines: [...p.lines.slice(-80), line] } : p));

    try {
      const res = await fetch("/api/admin/ingest-m3u", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": secretKey.trim(),
        },
        body: JSON.stringify({ m3uText, m3uUrl }),
      });

      // Auth / validation failures come back as plain JSON, not a stream.
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalSummary: any = null;
      let streamError: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";

        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let evt: any;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }

          switch (evt.phase) {
            case "fetch":
              setIngestProgress((p) => (p ? { ...p, phase: "Downloading", message: evt.message } : p));
              pushLine(evt.message);
              break;
            case "parse":
              setIngestProgress((p) =>
                p ? { ...p, phase: "Parsing", message: evt.message, total: evt.total ?? p.total } : p
              );
              pushLine(evt.message);
              break;
            case "mode":
              setIngestProgress((p) => (p ? { ...p, phase: "Probing", message: evt.message } : p));
              pushLine(evt.message);
              break;
            case "probe": {
              const label =
                evt.status === "active"
                  ? "ACTIVE"
                  : evt.status === "broken"
                  ? "broken"
                  : evt.status === "skipped"
                  ? "duplicate (skipped)"
                  : evt.status;
              setIngestProgress((p) =>
                p
                  ? {
                      ...p,
                      phase: "Probing streams",
                      current: evt.index,
                      total: evt.total,
                      percent: evt.percent ?? p.percent,
                      message: `Probing ${evt.index}/${evt.total} — ${evt.name}`,
                    }
                  : p
              );
              pushLine(`[${evt.index}/${evt.total}] ${evt.name} → ${label}`);
              break;
            }
            case "maintenance":
              setIngestProgress((p) => (p ? { ...p, phase: "Cleaning up", message: evt.message, percent: 100 } : p));
              pushLine(evt.message);
              break;
            case "done":
              finalSummary = evt.summary;
              setIngestProgress((p) =>
                p ? { ...p, phase: "Complete", message: "Ingestion finished.", percent: 100, done: true } : p
              );
              break;
            case "error":
              streamError = evt.error || "Unknown ingestion error";
              break;
          }
        }
      }

      if (streamError) {
        throw new Error(streamError);
      }

      if (finalSummary) {
        setIngestLog(
          `Success! Processed ${finalSummary.totalParsed} streams → Created ${finalSummary.channelsCreated} new channels, Added ${finalSummary.activeLinksAdded} working backup links (${finalSummary.brokenLinksAdded} broken, ${finalSummary.linksSkipped} duplicates skipped).`
        );
        setM3uText("");
        setM3uUrl("");
        await fetchStats();
        fetchSchedule();
      }
    } catch (err: any) {
      setIngestLog(`Ingestion failed: ${err.message}`);
      setIngestProgress((p) => (p ? { ...p, phase: "Failed", message: err.message, done: true } : p));
    } finally {
      setIngestLoading(false);
    }
  };

  // Trigger a full catalogue health check.
  const handleTriggerHealthCheck = async () => {
    setHealthCheckLoading(true);
    setHealthCheckLog(null);
    try {
      let before: string | undefined;
      let checked = 0;
      let active = 0;
      let degraded = 0;
      let broken = 0;
      let hasMore = true;

      while (hasMore) {
        const res = await fetch("/api/admin/health-check", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-admin-secret": secretKey.trim(),
          },
          body: JSON.stringify(before ? { before } : {}),
        });
        const raw = await res.text();
        let data: any;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error(`Server returned ${res.status} instead of JSON. Please try again; the batch did not finish.`);
        }
        if (!res.ok || !data.success) {
          throw new Error(data.error || `Health check failed (${res.status})`);
        }

        before = data.runStartedAt;
        checked += data.summary.checkedCount;
        active += data.summary.activeCount;
        degraded += data.summary.degradedCount;
        broken += data.summary.brokenCount;
        hasMore = data.hasMore === true;
        setHealthCheckLog(`Checking all links... ${checked} tested so far.`);
      }

      setHealthCheckLog(
        `Health check finished! Tested ${checked} links: ${active} Active, ${degraded} Degraded, ${broken} Broken.`
      );
      fetchStats();
      fetchSchedule();
    } catch (err: any) {
      setHealthCheckLog(`Error running health check: ${err.message}`);
    } finally {
      setHealthCheckLoading(false);
    }
  };

  // Manual Delete Channel
  const handleDeleteChannel = async (channelId: string, channelName: string) => {
    if (!confirm(`Are you sure you want to permanently delete channel "${channelName}" and all its stream links?`)) {
      return;
    }

    setDeletingId(channelId);
    try {
      const res = await fetch(`/api/admin/channels/${channelId}`, {
        method: "DELETE",
        headers: {
          "x-admin-secret": secretKey.trim(),
        },
      });
      const data = await res.json();
      if (data.success) {
        fetchStats();
      } else {
        alert(`Failed to delete channel: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Error deleting channel: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  // Manual Delete Individual Stream Link
  const handleDeleteStream = async (streamId: string) => {
    if (!confirm("Are you sure you want to delete this stream mirror link?")) {
      return;
    }

    setDeletingId(streamId);
    try {
      const res = await fetch(`/api/admin/streams/${streamId}`, {
        method: "DELETE",
        headers: {
          "x-admin-secret": secretKey.trim(),
        },
      });
      const data = await res.json();
      if (data.success) {
        fetchStats();
      } else {
        alert(`Failed to delete stream link: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Error deleting stream: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  // Toggle channel pinned status
  const handleTogglePin = async (channelId: string, currentPinned: boolean) => {
    setPinningId(channelId);
    try {
      const newPinned = !currentPinned;
      const res = await fetch("/api/admin/channels/pin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": secretKey.trim(),
        },
        body: JSON.stringify({
          channelId,
          isPinned: newPinned,
          priorityOrder: newPinned ? (pinnedOrder.length + 1) : 99,
        }),
      });
      const data = await res.json();
      if (data.success) {
        await fetchStats();
      } else {
        alert(`Failed to update pin: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Error updating pin: ${err.message}`);
    } finally {
      setPinningId(null);
    }
  };

  // Move pinned item up/down
  const handleMovePinned = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= pinnedOrder.length) return;
    const updated = [...pinnedOrder];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    setPinnedOrder(updated);
  };

  // Save reordered pinned channels
  const handleSavePinnedOrder = async () => {
    if (pinnedOrder.length === 0) return;
    setReordering(true);
    setReorderSaved(false);
    try {
      const orderedIds = pinnedOrder.map((c) => c._id);
      const res = await fetch("/api/admin/channels/reorder", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": secretKey.trim(),
        },
        body: JSON.stringify({ orderedIds }),
      });
      const data = await res.json();
      if (data.success) {
        setReorderSaved(true);
        setTimeout(() => setReorderSaved(false), 3000);
        await fetchStats();
      } else {
        alert(`Failed to save order: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Error saving order: ${err.message}`);
    } finally {
      setReordering(false);
    }
  };

  // Drag & drop handlers for pinned channels
  const handleDragStart = (index: number) => {
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;
    const updated = [...pinnedOrder];
    const [draggedItem] = updated.splice(draggedIndex, 1);
    updated.splice(index, 0, draggedItem);
    setDraggedIndex(index);
    setPinnedOrder(updated);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
  };

  // Open logo editor modal
  /**
   * Runs the catalogue pass on demand: normalize names → merge duplicates →
   * purge test links → promote the fastest working link to Server 1.
   * The same routine runs automatically after each ingest and health check.
   */
  const handleRunMaintenance = async () => {
    setMaintenanceLoading(true);
    setMaintenanceLog(null);
    try {
      const res = await fetch("/api/admin/maintenance", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": secretKey.trim(),
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.success) {
        const r = data.report;
        setMaintenanceLog(
          `Mode: ${r.mode} • Merged ${r.channelsMerged} duplicate channels • ` +
            `Removed ${r.duplicateLinksRemoved} duplicate links • ` +
            `Purged ${r.placeholderLinksPurged} test links • ` +
            `Re-sorted ${r.channelsReordered} channels • ` +
            `${r.channelsBefore} → ${r.channelsAfter} channels, ${r.streamsBefore} → ${r.streamsAfter} links`
        );
        await fetchStats();
      } else {
        setMaintenanceLog(`Failed: ${data.error}`);
      }
    } catch (err: any) {
      setMaintenanceLog(`Error: ${err.message}`);
    } finally {
      setMaintenanceLoading(false);
    }
  };

  const handleOpenLogoEdit = (id: string, name: string, logo: string) => {
    setEditingChannel({ id, name, logo });
    setLogoInput(logo || "");
  };

  // Save updated logo (via URL or uploaded File)
  const handleSaveChannelLogo = async (newLogoUrl: string) => {
    if (!editingChannel || !newLogoUrl.trim()) return;
    setSavingLogo(true);
    try {
      const res = await fetch(`/api/admin/channels/${editingChannel.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": secretKey.trim(),
        },
        body: JSON.stringify({ logo: newLogoUrl.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setEditingChannel(null);
        setLogoInput("");
        await fetchStats();
      } else {
        alert(`Failed to update logo: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Error saving logo: ${err.message}`);
    } finally {
      setSavingLogo(false);
    }
  };

  // Local Image File to Base64 Data URL converter
  const handleImageFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      alert("Please select an image file under 2MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const base64Url = event.target?.result as string;
      if (base64Url) {
        setLogoInput(base64Url);
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-8">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 glass-panel p-6 rounded-2xl">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <ShieldAlert className="w-6 h-6 text-brand-500" />
            <h1 className="text-xl font-bold text-white tracking-tight">Admin Secret Gate & Controls</h1>
          </div>
          <p className="text-xs text-slate-400">
            Automated Channel Deduplication, M3U Playlist Ingestion & Batch Health Checker.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleTriggerHealthCheck}
            disabled={healthCheckLoading}
            className="flex items-center gap-2 px-4 py-2.5 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-brand-600/30 disabled:opacity-50"
          >
            <Activity className={`w-4 h-4 ${healthCheckLoading ? "animate-spin" : ""}`} />
            <span>{healthCheckLoading ? "Probing All Links..." : "Run Health Check (All Links)"}</span>
          </button>

          <button
            onClick={handleRunMaintenance}
            disabled={maintenanceLoading}
            title="Normalize names, merge duplicates, purge test links, promote fastest server"
            className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-emerald-600/30 disabled:opacity-50"
          >
            <Wrench className={`w-4 h-4 ${maintenanceLoading ? "animate-spin" : ""}`} />
            <span>{maintenanceLoading ? "Cleaning Catalogue..." : "Run Cleanup & Merge"}</span>
          </button>

          <button
            onClick={fetchStats}
            disabled={loading}
            className="p-2.5 bg-slate-900 text-slate-300 hover:text-white rounded-xl border border-slate-800 hover:border-slate-700 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Next auto-probe countdown timer */}
      <div className="glass-panel px-5 py-3.5 rounded-2xl border border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-xl border flex items-center justify-center ${
              healthCheckLoading
                ? "bg-brand-500/15 border-brand-500/40 text-brand-400"
                : "bg-slate-900 border-slate-800 text-emerald-400"
            }`}
          >
            {healthCheckLoading ? (
              <Activity className="w-5 h-5 animate-spin" />
            ) : (
              <Clock className="w-5 h-5" />
            )}
          </div>
          <div>
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              {healthCheckLoading ? "Health Check Running" : "Next Auto-Probe"}
            </p>
            <p className="text-xs text-slate-500">
              {nextProbe.running
                ? "Auto health checker is active on the server."
                : "Auto health checker not detected on this instance."}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
          <div className="flex-1 sm:flex-none text-center px-4 py-2 rounded-xl bg-slate-900/70 border border-slate-800 min-w-[92px]">
            <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Pinned (5m)</p>
            <p className="text-lg font-black tabular-nums text-emerald-400 leading-tight">
              {healthCheckLoading ? "--:--" : nextProbe.pinned ?? "--:--"}
            </p>
          </div>
          <div className="flex-1 sm:flex-none text-center px-4 py-2 rounded-xl bg-slate-900/70 border border-slate-800 min-w-[92px]">
            <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Full Scan (10m)</p>
            <p className="text-lg font-black tabular-nums text-brand-400 leading-tight">
              {healthCheckLoading ? "--:--" : nextProbe.full ?? "--:--"}
            </p>
          </div>
          <div className="flex-1 sm:flex-none text-center px-4 py-2 rounded-xl bg-slate-900/70 border border-slate-800 min-w-[92px]">
            <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Next Probe</p>
            <p className="text-lg font-black tabular-nums text-white leading-tight">
              {healthCheckLoading ? "--:--" : nextProbe.soonest ?? "--:--"}
            </p>
          </div>
        </div>
      </div>

      {maintenanceLog && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-mono">
          {maintenanceLog}
        </div>
      )}

      {healthCheckLog && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-mono">
          {healthCheckLog}
        </div>
      )}

      {/* Metrics Cards */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="glass-card p-5 rounded-2xl flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex items-center justify-center">
              <Radio className="w-6 h-6" />
            </div>
            <div>
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Total Channels</p>
              <h3 className="text-xl font-black text-white">{stats.totalChannels}</h3>
            </div>
          </div>

          <div className="glass-card p-5 rounded-2xl flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20 flex items-center justify-center">
              <Database className="w-6 h-6" />
            </div>
            <div>
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Total Stream Links</p>
              <h3 className="text-xl font-black text-white">{stats.totalStreams}</h3>
            </div>
          </div>

          <div className="glass-card p-5 rounded-2xl flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <div>
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Active Links</p>
              <h3 className="text-xl font-black text-emerald-400">{stats.activeStreams}</h3>
            </div>
          </div>

          <div className="glass-card p-5 rounded-2xl flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center justify-center">
              <Zap className="w-6 h-6" />
            </div>
            <div>
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Degraded Links</p>
              <h3 className="text-xl font-black text-amber-400">{stats.degradedStreams}</h3>
            </div>
          </div>

          <div className="glass-card p-5 rounded-2xl flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-red-500/10 text-red-400 border border-red-500/20 flex items-center justify-center">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div>
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Broken Links</p>
              <h3 className="text-xl font-black text-red-400">{stats.brokenStreams}</h3>
            </div>
          </div>
        </div>
      )}

      {/* M3U Ingestion Console */}
      <div className="glass-panel p-6 rounded-2xl border border-slate-800">
        <div className="flex items-center gap-2 mb-4">
          <FileCode className="w-5 h-5 text-brand-500" />
          <h2 className="text-base font-bold text-white">Ingest M3U Playlist</h2>
        </div>

        <form onSubmit={handleIngest} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">
              Option 1: Paste M3U URL
            </label>
            <input
              type="url"
              placeholder="https://example.com/playlist.m3u"
              value={m3uUrl}
              onChange={(e) => setM3uUrl(e.target.value)}
              className="w-full bg-slate-900 text-xs text-white placeholder-slate-600 px-4 py-2.5 rounded-xl border border-slate-800 focus:outline-none focus:border-brand-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">
              Option 2: Paste Raw M3U Playlist Text
            </label>
            <textarea
              rows={5}
              placeholder={`#EXTM3U\n#EXTINF:-1 tvg-name="T Sports" tvg-logo="https://..." group-title="Sports", T Sports HD\nhttps://stream-url.m3u8`}
              value={m3uText}
              onChange={(e) => setM3uText(e.target.value)}
              className="w-full bg-slate-900 text-xs font-mono text-slate-200 placeholder-slate-600 p-4 rounded-xl border border-slate-800 focus:outline-none focus:border-brand-500"
            />
          </div>

          <button
            type="submit"
            disabled={ingestLoading || (!m3uText.trim() && !m3uUrl.trim())}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-500 text-white rounded-xl text-xs font-bold transition-all disabled:opacity-50 shadow-lg shadow-brand-600/25"
          >
            {ingestLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <PlusCircle className="w-4 h-4" />
            )}
            <span>
              {ingestLoading
                ? ingestProgress
                  ? `${ingestProgress.phase}...`
                  : "Working..."
                : "Ingest M3U Stream Links"}
            </span>
          </button>
        </form>

        {/* Live ingestion progress console */}
        {ingestProgress && (
          <div className="mt-4 rounded-xl bg-slate-950 border border-slate-800 overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-slate-800 bg-slate-900/60">
              <div className="flex items-center gap-2 min-w-0">
                {ingestProgress.done ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                ) : (
                  <Loader2 className="w-4 h-4 text-brand-400 animate-spin shrink-0" />
                )}
                <span className="text-xs font-bold text-white truncate">{ingestProgress.phase}</span>
              </div>
              <span className="text-[11px] font-mono font-bold text-slate-400 shrink-0">
                {ingestProgress.total > 0
                  ? `${ingestProgress.current}/${ingestProgress.total} • ${ingestProgress.percent}%`
                  : `${ingestProgress.percent}%`}
              </span>
            </div>

            {/* Progress bar */}
            <div className="h-1.5 w-full bg-slate-900">
              <div
                className={`h-full transition-all duration-300 ${
                  ingestProgress.done ? "bg-emerald-500" : "bg-brand-500"
                }`}
                style={{ width: `${Math.min(100, Math.max(2, ingestProgress.percent))}%` }}
              />
            </div>

            <div className="px-4 py-2 text-[11px] font-mono text-slate-400 border-b border-slate-800/60 truncate">
              {ingestProgress.message}
            </div>

            {/* Scrolling live log (newest at the bottom) */}
            <div className="max-h-48 overflow-y-auto px-4 py-2 space-y-0.5 text-[11px] font-mono">
              {ingestProgress.lines.map((line, i) => {
                const isActive = line.includes("→ ACTIVE");
                const isBroken = line.includes("→ broken");
                return (
                  <div
                    key={i}
                    className={
                      isActive
                        ? "text-emerald-400"
                        : isBroken
                        ? "text-red-400/80"
                        : "text-slate-400"
                    }
                  >
                    {line}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {ingestLog && (
          <div className="mt-4 p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300">
            {ingestLog}
          </div>
        )}
      </div>



      {/* ========================================================= */}
      {/* 📌 MANAGE & REORDER PINNED CHANNELS SECTION */}
      {/* ========================================================= */}
      <div className="glass-panel p-6 rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/5 via-slate-900/40 to-slate-950 space-y-4">
        {/* Collapsible header — click to expand/collapse the pinned board */}
        <button
          type="button"
          onClick={() => setPinnedExpanded((v) => !v)}
          aria-expanded={pinnedExpanded}
          className="w-full flex items-center justify-between gap-4 text-left group"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shrink-0">
              <Pin className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white truncate">Manage & Reorder Pinned Channels</h2>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 shrink-0">
                  {pinnedOrder.length} Pinned
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5 hidden sm:block truncate">
                {pinnedExpanded
                  ? "Drag or click arrows to reorder. Pinned channels lead the Home & Category pages."
                  : "Click to expand and manage the pinned channel order."}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {reorderSaved && (
              <span className="hidden sm:flex items-center gap-1 text-xs font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-3 py-1.5 rounded-xl animate-fade-in">
                <Check className="w-3.5 h-3.5" /> Saved!
              </span>
            )}
            <span
              className={`w-8 h-8 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 group-hover:text-white transition-transform ${
                pinnedExpanded ? "rotate-180" : ""
              }`}
            >
              <ChevronDown className="w-4 h-4" />
            </span>
          </div>
        </button>

        {pinnedExpanded && (
          <>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={handleSavePinnedOrder}
                disabled={reordering || pinnedOrder.length === 0}
                className="flex items-center gap-2 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-xl text-xs font-bold transition-all shadow-lg shadow-amber-500/20 disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                <span>{reordering ? "Saving Order..." : "Save Custom Order"}</span>
              </button>
            </div>

        {/* Category Tabs for Pinned Channels */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {[
            { id: "all", label: "All", badge: "🌟" },
            ...CATEGORIES.map((c) => ({
              id: c.slug,
              label: ADMIN_CATEGORY_LABELS[c.slug] || c.name,
              badge: c.badge,
            })),
          ].map((tab) => {
            const isActive = pinCategoryTab === tab.id;
            const count = pinnedOrder.filter((ch) => channelInPinnedTab(ch, tab.id)).length;

            return (
              <button
                key={tab.id}
                onClick={() => setPinCategoryTab(tab.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all shrink-0 ${
                  isActive
                    ? "bg-amber-500 text-slate-950 shadow-md font-extrabold"
                    : "bg-slate-900/80 text-slate-400 border border-slate-800 hover:text-white hover:border-slate-700"
                }`}
              >
                <span>{tab.badge}</span>
                <span>{tab.label}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                    isActive ? "bg-slate-950/20 text-slate-950 font-bold" : "bg-slate-950 text-slate-500"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {pinnedOrder.length === 0 ? (
          <div className="py-8 text-center bg-slate-900/40 rounded-xl border border-slate-800">
            <Pin className="w-8 h-8 text-slate-600 mx-auto mb-2" />
            <p className="text-xs font-bold text-slate-300">No channels are currently pinned</p>
            <p className="text-[11px] text-slate-500 mt-1">
              Click the <span className="text-amber-400 font-semibold">Pin icon</span> next to any channel in the table below to pin it here.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {pinnedOrder
              .map((ch, originalIdx) => ({ ch, originalIdx }))
              .filter(({ ch }) => channelInPinnedTab(ch, pinCategoryTab))
              .map(({ ch, originalIdx }, categoryIdx) => (
                <div
                  key={ch._id}
                  draggable
                  onDragStart={() => handleDragStart(originalIdx)}
                  onDragOver={(e) => handleDragOver(e, originalIdx)}
                  onDragEnd={handleDragEnd}
                  className={`flex items-center justify-between gap-3 p-3 rounded-xl border transition-all cursor-move select-none ${
                    draggedIndex === originalIdx
                      ? "bg-amber-500/20 border-amber-400 shadow-lg scale-[1.01]"
                      : "bg-slate-900/80 border-slate-800 hover:border-slate-700"
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex items-center gap-1.5 text-slate-500 shrink-0">
                      <GripVertical className="w-4 h-4" />
                      <span className="w-6 h-6 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 font-black text-xs flex items-center justify-center">
                        #{originalIdx + 1}
                      </span>
                    </div>

                    <div className="w-8 h-8 rounded-lg bg-white p-1 flex items-center justify-center shrink-0 overflow-hidden">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={getChannelLogo(ch.name, ch.logo)}
                        alt={ch.name}
                        className="max-w-full max-h-full object-contain"
                        onError={(e) => {
                          const target = e.target as HTMLImageElement;
                          if (!target.dataset.fallback) {
                            target.dataset.fallback = "true";
                            const initials = ch.name.substring(0, 2).toUpperCase();
                            target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=0284c7&color=ffffff&size=200&bold=true`;
                          }
                        }}
                      />
                    </div>

                    <div className="truncate">
                      <span className="text-xs font-bold text-white">{ch.name}</span>
                      <span className="block text-[10px] text-slate-400">
                        {ch.category} • {getCountryFlag(ch.country)} {ch.country}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => handleMovePinned(originalIdx, originalIdx - 1)}
                      disabled={originalIdx === 0}
                      className="p-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-400 hover:text-white disabled:opacity-30 transition-colors"
                      title="Move Up"
                    >
                      <MoveUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleMovePinned(originalIdx, originalIdx + 1)}
                      disabled={originalIdx === pinnedOrder.length - 1}
                      className="p-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-400 hover:text-white disabled:opacity-30 transition-colors"
                      title="Move Down"
                    >
                      <MoveDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleTogglePin(ch._id, true)}
                      disabled={pinningId === ch._id}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500 hover:text-white transition-all ml-1 disabled:opacity-50"
                      title="Unpin channel"
                    >
                      <PinOff className="w-3.5 h-3.5" />
                      <span>Unpin</span>
                    </button>
                  </div>
                </div>
              ))}
          </div>
        )}
          </>
        )}
      </div>

      {/* Managed Channels Breakdown Table with Filter & Bulk Actions */}
      <div className="glass-panel p-6 rounded-2xl border border-slate-800 space-y-5">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-white">Channel & Stream Links Manager</h2>
              <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-slate-900 border border-slate-800 text-brand-400">
                {filteredChannels.length} of {channels.length} Channels
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Filter by name, status, category, or region, toggle pins, and mark checkboxes to perform bulk actions.
            </p>
          </div>

          {/* Bulk Delete Bar */}
          {selectedIds.length > 0 && (
            <div className="flex items-center gap-3 bg-red-500/10 border border-red-500/30 px-4 py-2 rounded-xl animate-fade-in">
              <span className="text-xs font-bold text-red-400">
                {selectedIds.length} {selectedIds.length === 1 ? "Channel" : "Channels"} Marked
              </span>
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-red-600 hover:bg-red-500 text-white transition-all shadow-lg disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{bulkDeleting ? "Deleting Marked..." : `Delete Marked (${selectedIds.length})`}</span>
              </button>
            </div>
          )}
        </div>

        {/* ========== FILTER CONTROLS TOOLBAR ========== */}
        <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800/80 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3">
            {/* Search Input (4 cols) */}
            <div className="lg:col-span-4 relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                placeholder="Search channel name, slug..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-8 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 transition-colors"
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Status Filter (2 cols) */}
            <div className="lg:col-span-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as any)}
                className="w-full py-2 px-3 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-300 focus:outline-none focus:border-brand-500 transition-colors cursor-pointer"
              >
                <option value="all">All Statuses</option>
                <option value="active">Active Only</option>
                <option value="hidden">Hidden / Broken</option>
                <option value="degraded">Degraded Only</option>
              </select>
            </div>

            {/* Category Filter (2 cols) — the six fixed categories only */}
            <div className="lg:col-span-2">
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="w-full py-2 px-3 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-300 focus:outline-none focus:border-brand-500 transition-colors cursor-pointer"
              >
                <option value="all">All Categories</option>
                {categories.map((cat) => (
                  <option key={cat.slug} value={cat.slug}>
                    {cat.badge} {ADMIN_CATEGORY_LABELS[cat.slug] || cat.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Sort Dropdown (2 cols) */}
            <div className="lg:col-span-2">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="w-full py-2 px-3 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-300 focus:outline-none focus:border-brand-500 transition-colors cursor-pointer"
              >
                <option value="name-asc">Name (A-Z)</option>
                <option value="name-desc">Name (Z-A)</option>
                <option value="streams-desc">Most Mirrors</option>
                <option value="active-desc">Most Active</option>
              </select>
            </div>
          </div>

          {/* Active Filters Pill Bar & Reset button */}
          {hasActiveFilters && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/60">
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                <Filter className="w-3.5 h-3.5 text-brand-400" />
                <span>Active Filters:</span>

                {searchTerm && (
                  <span className="px-2 py-0.5 rounded-md bg-brand-500/10 border border-brand-500/30 text-brand-300 text-[10px] font-medium">
                    Search: &ldquo;{searchTerm}&rdquo;
                  </span>
                )}
                {statusFilter !== "all" && (
                  <span className="px-2 py-0.5 rounded-md bg-brand-500/10 border border-brand-500/30 text-brand-300 text-[10px] font-medium capitalize">
                    Status: {statusFilter}
                  </span>
                )}
                {categoryFilter !== "all" && (
                  <span className="px-2 py-0.5 rounded-md bg-brand-500/10 border border-brand-500/30 text-brand-300 text-[10px] font-medium">
                    Category: {ADMIN_CATEGORY_LABELS[categoryFilter] || categoryFilter}
                  </span>
                )}
                {sortBy !== "name-asc" && (
                  <span className="px-2 py-0.5 rounded-md bg-brand-500/10 border border-brand-500/30 text-brand-300 text-[10px] font-medium">
                    Sort: {sortBy}
                  </span>
                )}
              </div>

              <button
                onClick={clearAllFilters}
                className="flex items-center gap-1 text-[11px] font-bold text-red-400 hover:text-red-300 transition-colors"
              >
                <X className="w-3 h-3" />
                <span>Clear All Filters</span>
              </button>
            </div>
          )}
        </div>

        <div className="w-full">
          <table className="w-full text-left text-xs text-slate-300 table-fixed">
            <thead className="bg-slate-900/80 text-slate-400 uppercase text-[10px] font-bold tracking-wider">
              <tr>
                <th className="px-2 py-3 rounded-l-xl w-8 text-center">
                  <button
                    onClick={toggleSelectAll}
                    className="text-slate-400 hover:text-white transition-colors"
                    title={isAllSelected ? "Unmark All" : "Mark All"}
                  >
                    {isAllSelected ? (
                      <CheckSquare className="w-4 h-4 text-brand-400" />
                    ) : (
                      <Square className="w-4 h-4" />
                    )}
                  </button>
                </th>
                <th className="px-2 py-3 w-[22%]">Channel</th>
                <th className="px-2 py-3 w-[12%]">Pin / Priority</th>
                <th className="px-2 py-3 w-[18%]">Category / Region</th>
                <th className="px-2 py-3 w-[28%]">Stream Mirrors</th>
                <th className="px-2 py-3 w-[11%]">Status</th>
                <th className="px-2 py-3 rounded-r-xl w-[9%] text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredChannels.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <Filter className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                    <p className="text-xs font-bold text-slate-300">No channels match the selected filters</p>
                    <p className="text-[11px] text-slate-500 mt-1">Try adjusting your search keywords, status, or category options.</p>
                    {hasActiveFilters && (
                      <button
                        onClick={clearAllFilters}
                        className="mt-3 px-3.5 py-1.5 bg-brand-600 hover:bg-brand-500 text-white rounded-lg text-xs font-bold transition-all"
                      >
                        Reset All Filters
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                filteredChannels.map((ch) => {
                  const isSelected = selectedIds.includes(ch._id);
                  const isPinned = ch.isPinned === true;
                  return (
                    <tr
                      key={ch._id}
                      className={`transition-colors ${
                        isSelected ? "bg-brand-500/10" : "hover:bg-slate-900/40"
                      }`}
                    >
                      <td className="px-2 py-2.5 text-center align-middle">
                        <button
                          onClick={() => toggleSelectChannel(ch._id)}
                          className="text-slate-400 hover:text-white transition-colors"
                        >
                          {isSelected ? (
                            <CheckSquare className="w-4 h-4 text-brand-400" />
                          ) : (
                            <Square className="w-4 h-4 text-slate-600" />
                          )}
                        </button>
                      </td>

                      <td className="px-2 py-2.5 font-semibold text-white align-middle">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-7 h-7 rounded-lg bg-white p-0.5 flex items-center justify-center shrink-0 overflow-hidden">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={getChannelLogo(ch.name, ch.logo)}
                              alt={ch.name}
                              className="max-w-full max-h-full object-contain"
                              onError={(e) => {
                                const target = e.target as HTMLImageElement;
                                if (!target.dataset.fallback) {
                                  target.dataset.fallback = "true";
                                  const initials = ch.name.substring(0, 2).toUpperCase();
                                  target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=0284c7&color=ffffff&size=200&bold=true`;
                                }
                              }}
                            />
                          </div>
                          <div className="min-w-0 truncate">
                            <div className="flex items-center gap-1.5 truncate">
                              <span className="truncate text-xs" title={ch.name}>{ch.name}</span>
                              {isPinned && (
                                <span className="px-1 py-0.1 rounded bg-amber-500/10 border border-amber-500/30 text-[9px] text-amber-400 font-bold shrink-0">
                                  #{ch.priorityOrder ?? 1}
                                </span>
                              )}
                            </div>
                            <span className="block text-[10px] text-slate-500 font-mono truncate">{ch.normalizedName}</span>
                          </div>
                        </div>
                      </td>

                      <td className="px-2 py-2.5 align-middle">
                        <button
                          onClick={() => handleTogglePin(ch._id, isPinned)}
                          disabled={pinningId === ch._id}
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold transition-all disabled:opacity-50 ${
                            isPinned
                              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40 hover:bg-amber-500/30"
                              : "bg-slate-900 text-slate-400 border border-slate-800 hover:text-amber-400 hover:border-amber-500/30"
                          }`}
                          title={isPinned ? "Unpin channel" : "Pin channel to top"}
                        >
                          <Pin className={`w-3 h-3 ${isPinned ? "fill-amber-400 text-amber-400" : ""}`} />
                          <span>{isPinned ? "Pinned" : "Pin"}</span>
                        </button>
                      </td>

                      <td className="px-2 py-2.5 align-middle">
                        <span className="inline-block px-2 py-0.5 rounded bg-slate-900 text-slate-300 font-medium text-[11px] truncate max-w-full">
                          {ch.category} ({getCountryFlag(ch.country)} {ch.country})
                        </span>
                      </td>

                      <td className="px-2 py-2.5 align-middle">
                        <div className="space-y-1">
                          <div className="flex items-center gap-1 text-slate-400 font-mono text-[10px]">
                            <Layers className="w-3 h-3 text-brand-400 inline shrink-0" />
                            <span>{ch.streams.length} Mirrors</span>
                          </div>
                          {ch.streams.map((st, idx) => (
                            <div
                              key={st._id}
                              className="flex items-center justify-between gap-1.5 px-1.5 py-0.5 rounded bg-slate-950/80 border border-slate-800 text-[10px] font-mono min-w-0"
                            >
                              <div className="flex items-center gap-1 min-w-0 truncate">
                                <span
                                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                    st.status === "active"
                                      ? "bg-emerald-400"
                                      : st.status === "degraded"
                                      ? "bg-amber-400"
                                      : "bg-red-400"
                                  }`}
                                />
                                <span className="truncate text-[10px]" title={st.url}>
                                  #{idx + 1}: {st.url.replace(/^https?:\/\//, "").substring(0, 20)}...
                                </span>
                              </div>

                              <button
                                onClick={() => handleDeleteStream(st._id)}
                                disabled={deletingId === st._id}
                                className="text-red-400 hover:text-red-300 transition-colors p-0.5 shrink-0"
                                title="Delete this stream mirror link"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </td>

                      <td className="px-2 py-2.5 align-middle">
                        {ch.streams.filter((s) => s.status === "active").length > 0 ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 whitespace-nowrap">
                            <CheckCircle2 className="w-3 h-3 shrink-0" /> Active ({ch.streams.filter((s) => s.status === "active").length})
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-red-500/10 text-red-400 border border-red-500/20 whitespace-nowrap">
                            <AlertTriangle className="w-3 h-3 shrink-0" /> Hidden (0)
                          </span>
                        )}
                      </td>

                      <td className="px-2 py-2.5 text-right align-middle">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => setEditorChannelId(ch._id)}
                            className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500 hover:text-white transition-all shrink-0"
                            title="Edit name, category, tags & server links"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>

                          <button
                            onClick={() => handleOpenLogoEdit(ch._id, ch.name, ch.logo)}
                            className="p-1.5 rounded-lg bg-brand-500/10 text-brand-400 border border-brand-500/20 hover:bg-brand-500 hover:text-white transition-all shrink-0"
                            title="Edit channel logo"
                          >
                            <ImageIcon className="w-3.5 h-3.5" />
                          </button>

                          <button
                            onClick={() => handleDeleteChannel(ch._id, ch.name)}
                            disabled={deletingId === ch._id}
                            className="p-1.5 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500 hover:text-white transition-all disabled:opacity-50 shrink-0"
                            title="Delete entire channel"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ========================================================= */}
      {/* ✏️ FULL CHANNEL EDITOR (metadata + manual server links)   */}
      {/* ========================================================= */}
      {editorChannelId && (() => {
        const target = channels.find((c) => c._id === editorChannelId);
        if (!target) return null;
        return (
          <ChannelEditModal
            channel={target as unknown as EditableChannel}
            secretKey={secretKey}
            onClose={() => setEditorChannelId(null)}
            onSaved={fetchStats}
          />
        );
      })()}

      {/* ========================================================= */}
      {/* 🖼️ MANUAL CHANNEL LOGO EDIT & UPLOAD MODAL */}
      {/* ========================================================= */}
      {editingChannel && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-lg w-full space-y-5 shadow-2xl animate-fade-in relative">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div className="flex items-center gap-2">
                <ImageIcon className="w-5 h-5 text-brand-400" />
                <h3 className="text-base font-bold text-white">Manual Channel Logo Editor</h3>
              </div>
              <button
                onClick={() => setEditingChannel(null)}
                className="text-slate-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div>
              <p className="text-xs text-slate-400 mb-1 font-semibold">Editing channel:</p>
              <p className="text-sm font-bold text-white">{editingChannel.name}</p>
            </div>

            {/* Logo Preview */}
            <div className="flex items-center gap-4 bg-slate-950 p-4 rounded-xl border border-slate-800">
              <div className="w-16 h-16 rounded-xl bg-white p-2 flex items-center justify-center shrink-0 overflow-hidden shadow-inner">
                {logoInput ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoInput} alt="Preview" className="max-w-full max-h-full object-contain" />
                ) : (
                  <Radio className="w-6 h-6 text-slate-400" />
                )}
              </div>
              <div className="text-xs text-slate-400">
                <p className="font-semibold text-slate-300">Live Logo Preview</p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Paste an image URL below or upload a PNG/JPG/SVG file from your device.
                </p>
              </div>
            </div>

            {/* Option 1: Image URL */}
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-300">
                Option 1: Image URL
              </label>
              <input
                type="url"
                placeholder="https://example.com/logo.png"
                value={logoInput}
                onChange={(e) => setLogoInput(e.target.value)}
                className="w-full bg-slate-950 text-xs text-white placeholder-slate-600 px-4 py-2.5 rounded-xl border border-slate-800 focus:outline-none focus:border-brand-500 font-mono"
              />
            </div>

            {/* Option 2: Upload Image File */}
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-300">
                Option 2: Upload File (PNG/JPG/SVG max 2MB)
              </label>
              <label className="flex items-center justify-center gap-2 w-full bg-slate-950 hover:bg-slate-800 text-slate-300 px-4 py-3 rounded-xl border border-dashed border-slate-700 hover:border-brand-500 cursor-pointer transition-colors text-xs font-semibold">
                <Upload className="w-4 h-4 text-brand-400" />
                <span>Browse & Upload Device Image</span>
                <input
                  type="file"
                  accept="image/png, image/jpeg, image/webp, image/svg+xml"
                  onChange={handleImageFileUpload}
                  className="hidden"
                />
              </label>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setEditingChannel(null)}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={() => handleSaveChannelLogo(logoInput)}
                disabled={savingLogo || !logoInput.trim()}
                className="flex items-center gap-2 px-5 py-2 rounded-xl text-xs font-bold bg-brand-600 hover:bg-brand-500 text-white transition-all shadow-lg shadow-brand-600/25 disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                <span>{savingLogo ? "Saving Logo..." : "Save Logo"}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
