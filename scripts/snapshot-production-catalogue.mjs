#!/usr/bin/env node
/**
 * Captures the production channel catalogue into a local snapshot file.
 *
 * READ-ONLY BY CONSTRUCTION. The only thing this script talks to is the public
 * catalogue API — `GET /api/channels` and `GET /api/channels/<id>` — which
 * answers without a secret and never returns the server-side `headers` field
 * (the upstream Referer/Origin and provider credentials a link may need). There
 * is no code path in this file that can write, pin, reorder or delete anything,
 * and it never connects to MongoDB at all: the snapshot is a file, not a
 * database connection.
 *
 * WHAT LANDS IN THE FILE — the public catalogue fields only:
 *   channels: _id, name, logo, category, isPinned, priorityOrder, tags
 *   streams:  _id, channelId, url, priority, status, latency, failedAttempts
 * The per-channel route is the same curated-only, viewer-visible ladder the
 * watch page receives, so the snapshot reproduces what a viewer actually gets.
 *
 * Usage:
 *   node scripts/snapshot-production-catalogue.mjs [--out <path>]
 *
 * Env:
 *   SOLUPLAY_BASE_URL   Production origin to read (default https://soluplay.vercel.app)
 */

import fs from "fs";
import path from "path";

const BASE_URL = (process.env.SOLUPLAY_BASE_URL || "https://soluplay.vercel.app").replace(/\/+$/, "");
const DEFAULT_OUT = path.join("data", "prod-snapshot.json");

/** Field whitelist for a channel record. Anything else is dropped. */
const CHANNEL_FIELDS = ["_id", "name", "logo", "category", "isPinned", "priorityOrder", "tags"];
/** Field whitelist for a stream record. `headers` is deliberately absent. */
const STREAM_FIELDS = ["_id", "url", "priority", "status", "latency", "failedAttempts"];

function parseArgs(argv) {
  const out = { file: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) out.file = argv[++i];
  }
  return out;
}

function pick(source, fields) {
  const picked = {};
  for (const field of fields) {
    if (source && source[field] !== undefined) picked[field] = source[field];
  }
  return picked;
}

async function getJson(pathname) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    headers: { "User-Agent": "SoluPlay-Snapshot/1.0" },
  });
  if (!res.ok) {
    throw new Error(`GET ${pathname} -> HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function main() {
  const { file } = parseArgs(process.argv.slice(2));

  console.log(`[snapshot] reading catalogue from ${BASE_URL}`);

  const catalogue = await getJson("/api/channels");
  const channels = Array.isArray(catalogue?.channels) ? catalogue.channels : [];
  if (channels.length === 0) {
    throw new Error("The catalogue came back empty — nothing to snapshot.");
  }
  console.log(`[snapshot] catalogue: ${channels.length} pinned channels`);

  const outChannels = [];
  const outStreams = [];
  let failed = 0;

  for (const channel of channels) {
    const record = pick(channel, CHANNEL_FIELDS);
    record.isPinned = true;
    record.priorityOrder =
      typeof channel.priorityOrder === "number" ? channel.priorityOrder : outChannels.length + 1;
    record.tags = Array.isArray(channel.tags) ? channel.tags : [];

    let detail = null;
    try {
      detail = await getJson(`/api/channels/${encodeURIComponent(channel._id)}`);
    } catch (err) {
      // One channel failing must not lose the other 99.
      failed++;
      console.warn(`[snapshot]   skipped ${channel.name}: ${err.message}`);
      continue;
    }

    const ladder = Array.isArray(detail?.channel?.streams) ? detail.channel.streams : [];
    for (const stream of ladder) {
      const link = pick(stream, STREAM_FIELDS);
      link.channelId = String(channel._id);
      link.priority = typeof stream.priority === "number" ? stream.priority : outStreams.length + 1;
      link.status = stream.status || "active";
      link.latency = typeof stream.latency === "number" ? stream.latency : 0;
      link.failedAttempts = typeof stream.failedAttempts === "number" ? stream.failedAttempts : 0;
      outStreams.push(link);
    }

    outChannels.push(record);
  }

  // The whole point of the whitelist above: prove the file cannot carry a
  // provider credential. A failure here means the source route changed shape.
  for (const link of outStreams) {
    if ("headers" in link) {
      throw new Error("Refusing to write a snapshot containing upstream headers.");
    }
  }

  const snapshot = {
    capturedAt: new Date().toISOString(),
    source: BASE_URL,
    note: "Read-only capture of the public catalogue for local testing. No secrets, no upstream headers.",
    channels: outChannels,
    streams: outStreams,
  };

  const target = path.resolve(process.cwd(), file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(snapshot, null, 2), "utf-8");

  const byCategory = {};
  for (const channel of outChannels) {
    byCategory[channel.category] = (byCategory[channel.category] || 0) + 1;
  }

  console.log(`[snapshot] wrote ${target}`);
  console.log(`[snapshot] ${outChannels.length} channels, ${outStreams.length} stream links`);
  console.log(`[snapshot] categories: ${JSON.stringify(byCategory)}`);
  if (failed) console.log(`[snapshot] ${failed} channel(s) could not be read and were skipped`);
}

main().catch((err) => {
  console.error(`[snapshot] failed: ${err.message}`);
  process.exit(1);
});
