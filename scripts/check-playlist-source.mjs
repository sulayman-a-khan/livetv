#!/usr/bin/env node
/**
 * Runs one Direct HLS playlist source check against a deployment and measures it.
 *
 * WHY THIS EXISTS: the manual "Check now" button is a Vercel function with a wall-clock
 * budget, so whether a check finishes is a question about elapsed time and about whether
 * the stream reaches its `done` frame. Both are invisible from the dashboard. This script
 * prints them.
 *
 * IT DOES NOT WRITE ANYTHING UNLESS YOU SAY SO.
 *   node scripts/check-playlist-source.mjs              -> read-only: lists sources and state
 *   node scripts/check-playlist-source.mjs --index 0 --run
 *                                                       -> syncs that source for real
 *
 * A real sync mutates the live catalogue: new mirrors are attached, changed URLs are
 * swapped in, and links this source no longer provides are retired. That is the daily
 * 20:00 UTC cron's normal work, run on demand — but it is a write, so `--run` is required.
 *
 * Env:
 *   SOLUPLAY_BASE_URL   Production origin (default https://soluplay.vercel.app)
 *   ADMIN_SECRET_KEY    The admin secret. Read from the shell first, then from .env.local.
 *                       Its value is never printed by this script.
 *
 * Options:
 *   --index N    Which source to sync, from the list this script prints (default 0)
 *   --name TEXT  Select by a substring of the source name instead of by index
 *   --force      Skip the "playlist is byte-identical" short-circuit and re-probe
 *   --run        Actually perform the sync (without it, nothing is written)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.SOLUPLAY_BASE_URL || "https://soluplay.vercel.app").replace(/\/+$/, "");

function parseArgs(argv) {
  const opts = { index: 0, name: "", force: false, run: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--index" && argv[i + 1]) opts.index = Number(argv[++i]);
    else if (a === "--name" && argv[i + 1]) opts.name = argv[++i];
    else if (a === "--force") opts.force = true;
    else if (a === "--run") opts.run = true;
    else {
      console.error(`[check] unknown option: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.index) || opts.index < 0) {
    console.error("[check] --index must be a non-negative integer");
    process.exit(2);
  }
  return opts;
}

/**
 * The admin secret, or null. Never echoed, never written anywhere.
 * The shell wins; otherwise a few KEY=VALUE lines are read out of .env.local.
 */
function readSecret() {
  const fromEnv = process.env.ADMIN_SECRET_KEY?.trim();
  if (fromEnv) return fromEnv;

  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?ADMIN_SECRET_KEY\s*=\s*(.*)$/);
    if (!m) continue;
    const raw = m[1].trim();
    const value = raw.replace(/^["']|["']$/g, "").trim();
    if (value) return value;
  }
  return null;
}

function relative(iso) {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const min = Math.floor(Math.max(0, Date.now() - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

async function listSources(secret) {
  const res = await fetch(`${BASE_URL}/api/admin/playlist-sources`, {
    headers: { "x-admin-secret": secret },
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(`list failed (${res.status}): ${data.error || "no response body"}`);
  }
  return data;
}

function printSources(data) {
  const m = data.monitor || {};
  const next = m.nextScheduledSyncAt ? new Date(m.nextScheduledSyncAt).getTime() - Date.now() : NaN;
  const nextIn = Number.isNaN(next)
    ? "unknown"
    : next <= 0
    ? "now"
    : `${Math.floor(next / 3_600_000)}h ${String(Math.floor((next % 3_600_000) / 60_000)).padStart(2, "0")}m`;

  console.log(`[check] ${BASE_URL}`);
  console.log(
    `[check] daily slot ${String(m.syncHourUtc ?? "??").padStart(2, "0")}:00 UTC · ` +
      `next in ${nextIn} · monitor ${m.running ? "active on server" : "runs from the scheduled job"}`
  );
  const totals = data.totals || {};
  console.log(
    `[check] totals: ${totals.sources ?? 0} sources, ${totals.active ?? 0} active, ` +
      `${totals.monitored ?? 0} monitored, ${totals.due ?? 0} due, ${totals.entries ?? 0} tracked entries`
  );
  console.log();

  const rows = data.sources || [];
  if (rows.length === 0) {
    console.log("[check] no playlist sources are configured");
    return rows;
  }
  rows.forEach((s, i) => {
    console.log(
      `  [${i}] ${s.name}\n` +
        `      ${s.sourceType} · ${s.active ? "active" : "INACTIVE"}/${s.monitored ? "monitored" : "manual"}\n` +
        `      last: ${s.lastStatus} · checked ${relative(s.lastCheckedAt)} · ` +
        `${s.consecutiveFetchFailures || 0} fetch failure(s)${s.lastError ? ` · ${s.lastError}` : ""}\n` +
        `      entries: ${s.counts?.present ?? 0} present / ${s.counts?.missing ?? 0} missing ` +
        `→ ${s.counts?.channels ?? 0} channel(s) · parsed ${s.entriesParsed ?? 0}\n` +
        `      url: ${s.url}`
    );
  });
  return rows;
}

function pick(rows, opts) {
  if (opts.name) {
    const found = rows.filter((s) => (s.name || "").toLowerCase().includes(opts.name.toLowerCase()));
    if (found.length === 0) throw new Error(`no source name contains "${opts.name}"`);
    if (found.length > 1) {
      throw new Error(`"${opts.name}" matches ${found.length} sources — use --index`);
    }
    return found[0];
  }
  const row = rows[opts.index];
  if (!row) throw new Error(`--index ${opts.index} is out of range (${rows.length} source(s))`);
  return row;
}

/** Streams one sync and reports what it saw, with elapsed time for every phase. */
async function syncSource(secret, source, opts) {
  const started = Date.now();
  const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

  console.log(`[check] syncing "${source.name}" (${source._id}) force=${opts.force}`);

  const res = await fetch(`${BASE_URL}/api/admin/playlist-sources/${source._id}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-secret": secret },
    body: JSON.stringify({ secretKey: secret, force: opts.force }),
  });

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`sync rejected (${res.status}): ${data.error || "no response body"}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frames = 0;
  let probes = 0;
  let sawDone = false;
  let streamError = null;
  let summary = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;

      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }

      frames++;
      switch (evt.phase) {
        case "probe":
          probes++;
          // Probes are the bulk of a real run: one line per URL would bury the rest.
          if (probes === 1 || probes % 10 === 0) {
            console.log(`  ${at()} probe ${evt.index}/${evt.total} ${evt.name} → ${evt.status}`);
          }
          break;
        default:
          console.log(`  ${at()} ${evt.phase}: ${evt.message || evt.error || ""}`);
      }

      if (evt.phase === "done") {
        sawDone = true;
        summary = evt.summary || null;
      }
      if (evt.phase === "error") streamError = evt.error || "sync error";
    }
  }

  const secs = (Date.now() - started) / 1000;
  console.log();
  console.log(`[check] stream closed after ${secs.toFixed(1)}s · ${frames} frame(s) · ${probes} probe line(s)`);

  if (streamError) console.log(`[check] the server reported: ${streamError}`);
  if (summary) {
    console.log(
      `[check] summary: status=${summary.status} changed=${summary.changed} ` +
        `parsed=${summary.entriesParsed} probes=${summary.probesRun}` +
        (summary.error ? ` error=${summary.error}` : "")
    );
    console.log(`[check] stats: ${JSON.stringify(summary.stats || {})}`);
  }

  if (!sawDone && !streamError) {
    console.log(
      "[check] NO done FRAME — the run was cut short (wall-clock budget or a dropped " +
        "connection). State written up to that point is saved; running again resumes."
    );
  }
  if (secs > 55 && !sawDone) {
    console.log("[check] it reached the 60s function ceiling, so the check needs a time budget.");
  }
  return sawDone && !streamError;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const secret = readSecret();
  if (!secret) {
    console.error(
      "[check] no ADMIN_SECRET_KEY in the environment or .env.local — refusing to guess one."
    );
    process.exit(1);
  }

  const data = await listSources(secret);
  const rows = printSources(data);

  if (!opts.run) {
    if (rows.length > 0) {
      console.log();
      console.log("[check] read-only: nothing was synced. Add --run to sync --index 0.");
    }
    return;
  }

  const target = pick(rows, opts);
  const ok = await syncSource(secret, target, opts);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(`[check] ${err.message}`);
  process.exitCode = 1;
});
