#!/usr/bin/env node
"use strict";

/**
 * Local PC Control Server
 * ============================================================================
 * Runs on the PC that hosts the OBS / FFmpeg encoder. It provides:
 *
 *   1. Multi-Event Manager  – web UI (http://localhost:5000) to create, edit,
 *                             delete and reorder any number of event cards.
 *   2. HLS Stream Forwarder – /live/<streamId>.m3u8 proxies the local encoder's
 *                             HLS output (playlists are rewritten, segments are
 *                             streamed through) with custom request/response
 *                             headers and CORS.
 *   3. One-Click Cloud Sync – upserts the cards into the `sportsevents`
 *                             collection of the cloud MongoDB used by the
 *                             Next.js app, and keeps `isLocalServerActive`
 *                             accurate with a heartbeat.
 *
 * Two listeners (security by design):
 *   ADMIN  127.0.0.1:5000  admin UI + API (+ forwarder, handy for local tests)
 *   PUBLIC 0.0.0.0:5001    ONLY /live/* and /healthz – expose this one.
 *
 * Start:  cp .env.example .env && npm install && npm start
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const { Readable, pipeline } = require("stream");
const { spawn } = require("child_process");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const mongoose = require("mongoose");

const VERSION = "1.0.0";

function isAbortError(err) {
  if (!err) return false;
  return (
    err.name === "AbortError" ||
    err.name === "DOMException" ||
    err.code === "ERR_STREAM_PREMATURE_CLOSE" ||
    err.code === "ECONNRESET" ||
    err.code === "EPIPE" ||
    err.code === 20 ||
    err.code === "ECANCELED" ||
    (typeof err.message === "string" && err.message.toLowerCase().includes("aborted")) ||
    (err.cause && isAbortError(err.cause))
  );
}

// Global safety net for client stream disconnects and aborts
process.on("uncaughtException", (err) => {
  if (isAbortError(err)) {
    return;
  }
  console.error("[uncaughtException]", err);
});

/* ========================================================================== *
 * Configuration
 * ========================================================================== */

function slugify(input, max) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max || 40)
    .replace(/-+$/g, "");
}

function envInt(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn("[config] " + name + "=" + raw + " is invalid (expected " + min + ".." + max + "); using " + fallback);
    return fallback;
  }
  return n;
}

function envBool(env, name, fallback) {
  const raw = (env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function envHeaders(env, name) {
  const raw = (env[name] || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return sanitizeHeaderMap(parsed, []);
  } catch (e) {
    console.warn("[config] " + name + " is not valid JSON – ignored (" + e.message + ")");
    return {};
  }
}

function trimSlash(s) {
  return String(s || "").trim().replace(/\/+$/, "");
}

function loadConfig(env) {
  const adminPort = envInt(env, "ADMIN_PORT", envInt(env, "PORT", 5000, 1, 65535), 1, 65535);
  const adminHost = (env.ADMIN_HOST || "127.0.0.1").trim();

  const allowedHosts = new Set(["localhost:" + adminPort, "127.0.0.1:" + adminPort, "[::1]:" + adminPort]);
  allowedHosts.add(adminHost.toLowerCase() + ":" + adminPort);
  (env.ADMIN_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .forEach((h) => allowedHosts.add(h));

  return {
    adminHost: adminHost,
    adminPort: adminPort,
    publicHost: (env.PUBLIC_HOST || "0.0.0.0").trim(),
    publicPort: envInt(env, "PUBLIC_PORT", 5001, 0, 65535),
    adminPassword: env.ADMIN_UI_PASSWORD || "",
    adminAllowedHosts: allowedHosts,

    nodeId: slugify(env.LOCAL_NODE_ID || os.hostname(), 60) || "local-pc",
    publicStreamBaseUrl: trimSlash(env.PUBLIC_STREAM_BASE_URL),

    mongoUri: (env.MONGODB_URI || "").trim(),
    cloudAppUrl: trimSlash(env.CLOUD_APP_URL),
    localServerSecret: (env.LOCAL_SERVER_SECRET || "").trim(),
    streamTokenSecret: (env.STREAM_TOKEN_SECRET || env.LOCAL_SERVER_SECRET || crypto.randomBytes(32).toString("hex")).trim(),
    streamTokenTtlSec: envInt(env, "STREAM_TOKEN_TTL_SEC", 55, 15, 300),
    allowedOrigins: (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    autoHeartbeat: envBool(env, "AUTO_HEARTBEAT", true),
    heartbeatIntervalSec: envInt(env, "HEARTBEAT_INTERVAL_SEC", 30, 5, 3600),

    xtreamServerUrl: trimSlash(env.XTREAM_SERVER_URL || ""),
    xtreamUsername: (env.XTREAM_USERNAME || "").trim(),
    xtreamPassword: (env.XTREAM_PASSWORD || "").trim(),

    corsOrigins: (env.CORS_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean),
    upstreamHeaders: envHeaders(env, "UPSTREAM_HEADERS_JSON"),
    responseHeaders: envHeaders(env, "RESPONSE_HEADERS_JSON"),
    upstreamTimeoutMs: envInt(env, "UPSTREAM_TIMEOUT_SEC", 10, 1, 120) * 1000,

    dataFile: path.resolve(__dirname, env.DATA_FILE || "data/events.json"),
  };
}

const CONFIG = loadConfig(process.env);

/* ---------- Startup env validation for Xtream Codes credentials ---------- */
(function validateXtreamEnv() {
  const missing = [];
  if (!CONFIG.xtreamServerUrl) missing.push("XTREAM_SERVER_URL");
  if (!CONFIG.xtreamUsername)  missing.push("XTREAM_USERNAME");
  if (!CONFIG.xtreamPassword)  missing.push("XTREAM_PASSWORD");
  if (missing.length) {
    console.error("╔══════════════════════════════════════════════════════════════╗");
    console.error("║  ⚠️  CRITICAL: Missing Xtream Codes env variable(s):        ║");
    missing.forEach((v) => {
      console.error(`║    → ${v.padEnd(50)}     ║`);
    });
    console.error("║                                                              ║");
    console.error("║  Xtream stream URLs will be BROKEN without these values.     ║");
    console.error("║  Set them in  local-pc-server/.env  and restart the server.  ║");
    console.error("╚══════════════════════════════════════════════════════════════╝");
  } else {
    console.log(`[xtream:env] ✅ Xtream credentials loaded — Server: ${CONFIG.xtreamServerUrl}, User: ${CONFIG.xtreamUsername}, Password: ${"•".repeat(CONFIG.xtreamPassword.length)} (${CONFIG.xtreamPassword.length} chars)`);
  }
})();

/* ========================================================================== *
 * Small utilities
 * ========================================================================== */

const STATUSES = ["scheduled", "live", "ended"];
const STREAM_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const MAX_BACKUPS = 10;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

/** Header names that must never be taken from configuration. */
const FORBIDDEN_UPSTREAM_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade", "te"]);

function httpError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (details) err.details = details;
  return err;
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (e) {
    return false;
  }
}

function redactUri(uri) {
  try {
    const u = new URL(uri);
    return u.protocol + "//" + u.host + u.pathname;
  } catch (e) {
    return "(invalid URI)";
  }
}

function scrub(message) {
  let m = String(message || "");
  if (CONFIG.mongoUri) m = m.split(CONFIG.mongoUri).join("<MONGODB_URI>");
  return m;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keeps only valid header names/values from an arbitrary object. */
function sanitizeHeaderMap(input, errors) {
  const out = {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    errors.push("headers must be a JSON object of header-name: value pairs");
    return out;
  }
  const keys = Object.keys(input);
  if (keys.length > 20) errors.push("headers can contain at most 20 entries");
  keys.slice(0, 20).forEach((k) => {
    const v = input[k];
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k)) {
      errors.push("invalid header name: " + k.slice(0, 40));
    } else if (typeof v !== "string" || /[\r\n\0]/.test(v) || v.length > 1024) {
      errors.push("invalid value for header " + k);
    } else {
      out[k] = v;
    }
  });
  return out;
}

function lowerKeys(obj) {
  const out = {};
  Object.keys(obj || {}).forEach((k) => {
    out[k.toLowerCase()] = obj[k];
  });
  return out;
}

function dirOf(pathname) {
  return pathname.replace(/[^/]*$/, "");
}

/* ========================================================================== *
 * Event store (JSON file, atomic writes)
 * ========================================================================== */

class EventStore {
  constructor(file) {
    this.file = file;
    this.events = [];
    this.meta = { lastSync: null };
    this._chain = Promise.resolve();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.events = Array.isArray(parsed.events) ? parsed.events : [];
      this.meta = Object.assign({ lastSync: null }, parsed.meta || {});
      this.normalizeOrder();
    } catch (e) {
      if (e.code === "ENOENT") return;
      const backup = this.file + ".corrupt-" + Date.now();
      try {
        fs.renameSync(this.file, backup);
        console.error("[store] " + this.file + " was unreadable (" + e.message + "). Moved to " + backup + " – starting empty.");
      } catch (e2) {
        console.error("[store] could not read " + this.file + ": " + e.message);
      }
      this.events = [];
    }
  }

  save() {
    const snapshot = JSON.stringify({ version: 1, meta: this.meta, events: this.events }, null, 2);
    const run = async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = this.file + "." + process.pid + ".tmp";
      await fs.promises.writeFile(tmp, snapshot, "utf8");
      await fs.promises.rename(tmp, this.file);
    };
    this._chain = this._chain.catch(() => {}).then(run);
    return this._chain;
  }

  normalizeOrder() {
    this.events.forEach((e, i) => {
      e.priorityOrder = i + 1;
    });
  }

  byId(id) {
    return this.events.find((e) => e.id === id) || null;
  }

  byStreamId(streamId) {
    return this.events.find((e) => e.streamId === streamId) || null;
  }
}

const store = new EventStore(CONFIG.dataFile);

/* ========================================================================== *
 * Event validation
 * ========================================================================== */

function parseIso(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isValidStreamInput(v) {
  if (!v || typeof v !== "string") return false;
  const s = v.trim();
  if (/^\d+$/.test(s)) return true; // Xtream Stream ID (e.g. 98231)
  if (s.includes("://") || s.includes("{SERVER}") || s.includes("[SERVER]") || s.includes("{USER}")) return true;
  return isHttpUrl(s);
}

function parseUrlList(input, errors) {
  let list;
  if (Array.isArray(input)) list = input;
  else if (typeof input === "string") list = input.split(/\r?\n/);
  else {
    errors.push("backupStreamUrls must be an array or newline-separated text");
    return [];
  }
  const out = [];
  list.forEach((item) => {
    const v = typeof item === "string" ? item.trim() : "";
    if (!v) return;
    if (v.length > 2048 || !isValidStreamInput(v)) {
      errors.push("invalid backup stream URL/ID: " + v.slice(0, 80));
      return;
    }
    if (out.indexOf(v) === -1) out.push(v);
  });
  if (out.length > MAX_BACKUPS) errors.push("at most " + MAX_BACKUPS + " backup URLs are allowed");
  return out;
}

/**
 * Validates a create/update payload and returns { errors, value }.
 * `existing` = the stored event when updating (partial payloads allowed).
 */
function validateEventInput(body, existing, takenStreamIds) {
  const errors = [];
  const v = {};
  const src = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!src) return { errors: ["Request body must be a JSON object"], value: {} };
  const creating = !existing;
  const has = (k) => src[k] !== undefined;

  function text(key, max) {
    if (!has(key)) {
      if (creating) errors.push(key + " is required");
      return;
    }
    if (typeof src[key] !== "string" || !src[key].trim()) {
      errors.push(key + " must be a non-empty string");
      return;
    }
    const s = src[key].trim();
    if (s.length > max) {
      errors.push(key + " must be at most " + max + " characters");
      return;
    }
    v[key] = s;
  }

  text("matchTitle", 200);
  text("sportType", 60);

  ["startTime", "endTime"].forEach((key) => {
    if (!has(key)) {
      if (creating) errors.push(key + " is required");
      return;
    }
    const iso = parseIso(src[key]);
    if (iso) v[key] = iso;
    else errors.push(key + " must be a valid date");
  });

  if (has("status")) {
    if (STATUSES.indexOf(src.status) !== -1) v.status = src.status;
    else errors.push("status must be one of: " + STATUSES.join(", "));
  }

  if (has("primaryStreamUrl")) {
    const u = typeof src.primaryStreamUrl === "string" ? src.primaryStreamUrl.trim() : "";
    if (u && u.length <= 2048 && isValidStreamInput(u)) v.primaryStreamUrl = u;
    else errors.push("primaryStreamUrl must be an absolute http(s) URL or Xtream Stream ID");
  } else if (creating) {
    errors.push("primaryStreamUrl is required");
  }

  if (has("backupStreamUrls")) v.backupStreamUrls = parseUrlList(src.backupStreamUrls, errors);

  if (has("activeStreamIndex")) {
    const idx = Number(src.activeStreamIndex);
    if (Number.isInteger(idx) && idx >= 0 && idx < 20) v.activeStreamIndex = idx;
  }

  if (has("useForwarder")) {
    if (typeof src.useForwarder === "boolean") v.useForwarder = src.useForwarder;
    else errors.push("useForwarder must be true or false");
  }

  if (has("headers")) {
    let h = src.headers;
    if (typeof h === "string") {
      if (!h.trim()) h = {};
      else {
        try {
          h = JSON.parse(h);
        } catch (e) {
          errors.push("headers must be valid JSON");
          h = null;
        }
      }
    }
    if (h !== null) v.headers = sanitizeHeaderMap(h, errors);
  }

  if (has("stagedSource")) {
    const s = typeof src.stagedSource === "string" ? src.stagedSource.trim() : "";
    if (!s) {
      v.stagedSource = null;
    } else if (s.length <= 2048 && isValidStreamInput(s)) {
      v.stagedSource = s;
    } else {
      errors.push("stagedSource must be a valid http(s) URL or Xtream Stream ID");
    }
  }

  if (creating) {
    if (has("streamId") && String(src.streamId).trim() !== "") {
      const sid = String(src.streamId).trim().toLowerCase();
      if (!STREAM_ID_RE.test(sid)) errors.push("streamId must be 2-64 chars: a-z 0-9 - _ (start with a letter or digit)");
      else if (takenStreamIds.has(sid)) errors.push("streamId \"" + sid + "\" is already used");
      else v.streamId = sid;
    }
  }

  // Cross-field: end after start (using the merged values).
  const start = v.startTime || (existing && existing.startTime);
  const end = v.endTime || (existing && existing.endTime);
  if (start && end && new Date(end).getTime() <= new Date(start).getTime()) {
    errors.push("endTime must be later than startTime");
  }

  return { errors: errors, value: v };
}

function newStreamId(title, taken) {
  const base = slugify(title, 40) || "event";
  for (let i = 0; i < 20; i++) {
    const candidate = base + "-" + crypto.randomBytes(2).toString("hex");
    if (!taken.has(candidate)) return candidate;
  }
  return base + "-" + crypto.randomBytes(6).toString("hex");
}

/* ========================================================================== *
 * URL helpers
 * ========================================================================== */

/* ========================================================================== *
 * Xtream Codes & URL helpers
 * ========================================================================== */

function localForwarderBase() {
  const port = CONFIG.publicPort > 0 ? CONFIG.publicPort : 5001;
  return "http://localhost:" + port;
}

/** Resolves an Xtream Stream ID or URL template into a valid upstream stream URL */
function resolveXtreamUrl(input) {
  if (!input || typeof input !== "string") return "";
  let raw = input.trim();
  if (!raw) return "";

  // Pure numeric stream ID (e.g., "98231")
  if (/^\d+$/.test(raw)) {
    const srv = CONFIG.xtreamServerUrl || "http://play.dgix.top:8080";
    const usr = CONFIG.xtreamUsername || "sulayman9991";
    const pwd = CONFIG.xtreamPassword || "";
    return `${srv}/live/${usr}/${pwd}/${raw}.m3u8`;
  }

  // Replace placeholders if used
  if (CONFIG.xtreamServerUrl) {
    raw = raw.replace(/\{SERVER\}/gi, CONFIG.xtreamServerUrl).replace(/\[SERVER\]/gi, CONFIG.xtreamServerUrl);
  }
  if (CONFIG.xtreamUsername) {
    raw = raw.replace(/\{USER\}/gi, CONFIG.xtreamUsername).replace(/\[USER\]/gi, CONFIG.xtreamUsername).replace(/\{USERNAME\}/gi, CONFIG.xtreamUsername);
  }
  if (CONFIG.xtreamPassword) {
    raw = raw.replace(/\{PASS\}/gi, CONFIG.xtreamPassword).replace(/\[PASS\]/gi, CONFIG.xtreamPassword).replace(/\{PASSWORD\}/gi, CONFIG.xtreamPassword);
  }

  return raw;
}

/** Masks raw credentials in URLs to prevent exposure */
function maskCredentials(url) {
  if (!url || typeof url !== "string") return "";
  return url.replace(/\/live\/([^/]+)\/([^/]+)\//g, (m, u, p) => `/live/${u}/••••••••/`);
}

/** Returns all candidate stream channels for an event */
function getEventCandidates(ev) {
  const list = [ev.primaryStreamUrl].concat(ev.backupStreamUrls || []).filter(Boolean);
  return list.map((raw, idx) => {
    const resolved = resolveXtreamUrl(raw);
    return {
      index: idx,
      label: idx === 0 ? "Channel 1 (Primary)" : `Channel ${idx + 1} (Backup ${idx})`,
      rawUrl: raw,
      resolvedUrl: resolved,
      maskedUrl: maskCredentials(resolved),
    };
  });
}

/** URL viewers should use for a forwarded stream. */
function forwarderPath(ev) {
  return "/live/" + ev.streamId + ".m3u8";
}

/** What gets written to the cloud as primaryStreamUrl. */
function cloudPrimaryUrl(ev) {
  if (!ev.useForwarder) return ev.primaryStreamUrl;
  let base = (CONFIG.publicStreamBaseUrl || localForwarderBase()).trim().replace(/\/+$/, "");
  if (base.startsWith("http://") && !looksLocal(base)) {
    base = "https://" + base.slice(7);
  }
  return base + forwarderPath(ev);
}

function looksLocal(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      h === "localhost" ||
      h === "::1" ||
      h === "[::1]" ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      h.endsWith(".local")
    );
  } catch (e) {
    return false;
  }
}

/* ========================================================================== *
 * Strict Single-Active Stream Enforcer, Smart Failover & Broadcasting Hub
 * ========================================================================== */

class StrictStreamManager {
  constructor() {
    this.activeStream = null; // { streamId, candidateIndex, resolvedUrl, label, controller, status, lastDataAt, failures, viewers: Set }
    this.lockQueue = Promise.resolve();
    this.segmentCache = new Map(); // url -> { buffer, contentType, headers, expiresAt }
    this.playlistCache = new Map(); // streamId -> { text, upstreamUrl, primaryHref, fetchedAt, expiresAt }
    this.idleCheckTimer = null;
    this.startIdleWatcher();
  }

  // Mutex Lock to strictly serialize stream teardown and startup
  async withLock(fn) {
    let release;
    const nextLock = new Promise((resolve) => (release = resolve));
    const currentLock = this.lockQueue;
    this.lockQueue = this.lockQueue.then(() => nextLock);
    await currentLock;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // Gracefully and completely terminates active upstream connection before opening any new one
  async closeActiveStream(reason) {
    if (!this.activeStream) return;
    const s = this.activeStream;
    console.log(`[xtream:enforcer] 🛑 Gracefully closing upstream connection for "${s.streamId}" (${s.label}) – Reason: ${reason}`);
    s.status = "closed";
    if (s.controller) {
      try {
        s.controller.abort();
      } catch (e) {
        /* ignore */
      }
    }
    this.activeStream = null;
    // Safety pause: ensure remote Xtream server releases socket before opening a new connection
    await sleep(500);
  }

  // Switches to a specific candidate channel (or opens initial connection) with strict single-connection guarantee
  async switchToCandidate(ev, candidateIndex, reason) {
    return this.withLock(async () => {
      const candidates = getEventCandidates(ev);
      if (!candidates.length) throw new Error("No stream candidates available for event");
      const targetIndex = ((candidateIndex % candidates.length) + candidates.length) % candidates.length;
      const target = candidates[targetIndex];

      // If already connected to this target with exact same URL, keep it!
      if (
        this.activeStream &&
        this.activeStream.streamId === ev.streamId &&
        this.activeStream.candidateIndex === targetIndex &&
        this.activeStream.resolvedUrl === target.resolvedUrl &&
        this.activeStream.status === "active"
      ) {
        return this.activeStream;
      }

      // STRICT ENFORCER: Close previous stream BEFORE opening new one
      await this.closeActiveStream(reason || "Channel switch");

      const controller = new AbortController();
      this.activeStream = {
        streamId: ev.streamId,
        candidateIndex: targetIndex,
        resolvedUrl: target.resolvedUrl,
        label: target.label,
        controller: controller,
        status: "active",
        lastDataAt: Date.now(),
        failures: 0,
        viewers: new Set(),
      };

      ev.activeStreamIndex = targetIndex;
      store.save().catch(() => {});
      console.log(`[xtream:enforcer] 🔒 Single connection locked on ${target.label} for "${ev.matchTitle}"`);
      return this.activeStream;
    });
  }

  // Problem-triggered failover: Triggered ONLY when active stream crashes or stalls for > 4.5s
  async triggerFailover(ev, reason) {
    return this.withLock(async () => {
      const candidates = getEventCandidates(ev);
      if (candidates.length <= 1) {
        console.warn(`[xtream:failover] ⚠️ Stream issue detected (${reason}), but no backup channels configured.`);
        return null;
      }

      const currentIndex = this.activeStream ? this.activeStream.candidateIndex : (ev.activeStreamIndex || 0);
      const nextIndex = (currentIndex + 1) % candidates.length;
      const nextCandidate = candidates[nextIndex];

      console.warn(`[xtream:failover] ⚡ Stream failure on Channel #${currentIndex + 1} (${reason})! Auto-switching to ${nextCandidate.label}...`);

      // Gracefully close active connection first
      await this.closeActiveStream(`Failover from Channel #${currentIndex + 1} (${reason})`);

      const controller = new AbortController();
      this.activeStream = {
        streamId: ev.streamId,
        candidateIndex: nextIndex,
        resolvedUrl: nextCandidate.resolvedUrl,
        label: nextCandidate.label,
        controller: controller,
        status: "active",
        lastDataAt: Date.now(),
        failures: 0,
        viewers: new Set(),
      };

      ev.activeStreamIndex = nextIndex;
      store.save().catch(() => {});

      // Lock onto the new backup channel
      console.log(`[xtream:failover] 🔒 Switched and locked onto ${nextCandidate.label} for "${ev.matchTitle}"`);
      return this.activeStream;
    });
  }

  // Active viewer tracking
  registerViewer(streamId, viewerId) {
    if (!this.activeStream || this.activeStream.streamId !== streamId) return;
    this.activeStream.viewers.add(viewerId || "client-" + Date.now());
    this.activeStream.lastDataAt = Date.now();
  }

  getViewersCount(streamId) {
    if (this.activeStream && this.activeStream.streamId === streamId && this.activeStream.status === "active") {
      return this.activeStream.viewers.size;
    }
    return 0;
  }

  // In-memory cache for high-throughput shared broadcasting
  getCachedPlaylist(streamId) {
    const entry = this.playlistCache.get(streamId);
    if (entry && Date.now() < entry.expiresAt) return entry.text;
    return null;
  }

  setCachedPlaylist(streamId, text, upstreamUrl, primaryHref) {
    this.playlistCache.set(streamId, {
      text,
      upstreamUrl,
      primaryHref,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + 1500, // 1.5s cache for seamless multi-user playlist sync
    });
  }

  getCachedSegment(url) {
    const entry = this.segmentCache.get(url);
    if (entry && Date.now() < entry.expiresAt) return entry;
    return null;
  }

  setCachedSegment(url, buffer, contentType, headers) {
    // Keep max 100 segments in memory (~100MB max)
    if (this.segmentCache.size > 100) {
      const oldest = this.segmentCache.keys().next().value;
      this.segmentCache.delete(oldest);
    }
    this.segmentCache.set(url, {
      buffer,
      contentType,
      headers,
      expiresAt: Date.now() + 30000, // 30s TTL
    });
  }

  // Flushes playlist and segment caches when switching/promoting sources
  flushCache(streamId) {
    if (streamId) this.playlistCache.delete(streamId);
    else this.playlistCache.clear();
    this.segmentCache.clear();
    console.log(`[xtream:enforcer] 🧹 Flushed playlist & segment caches${streamId ? ` for "${streamId}"` : ""}`);
  }

  startIdleWatcher() {
    if (this.idleCheckTimer) clearInterval(this.idleCheckTimer);
    // Runs every 10s to check if active stream has had 0 viewers for 180s (3 minutes)
    this.idleCheckTimer = setInterval(() => {
      if (!this.activeStream || this.activeStream.status !== "active") return;
      const now = Date.now();
      const idleMs = now - (this.activeStream.lastDataAt || now);

      if (idleMs > 180000) {
        console.log(`[xtream:idle] 💤 0 active clients for 3m on "${this.activeStream.streamId}". Gracefully disconnecting upstream Xtream connection.`);
        this.closeActiveStream("Idle disconnect (0 viewers for 3m)");
      } else {
        // Clear viewers set periodically so stale closed tabs don't artificially keep it alive
        if (idleMs > 60000) this.activeStream.viewers.clear();
      }
    }, 10000);
  }

  getActiveInfo() {
    if (!this.activeStream || this.activeStream.status !== "active") return null;
    return {
      streamId: this.activeStream.streamId,
      candidateIndex: this.activeStream.candidateIndex,
      label: this.activeStream.label,
      maskedUrl: maskCredentials(this.activeStream.resolvedUrl),
      viewers: this.activeStream.viewers.size,
      status: this.activeStream.status,
      lastDataAgoSec: Math.round((Date.now() - this.activeStream.lastDataAt) / 1000),
    };
  }
}

const strictStreamManager = new StrictStreamManager();

/* ========================================================================== *
 * Health probing (Origin Encoder & Cloud URL)
 * ========================================================================== */

const originState = new Map(); // event.id -> { online, checkedAt, latencyMs, httpStatus, error }
const cloudState = new Map();  // event.id -> { online, checkedAt, latencyMs, httpStatus, error, url }

function basicAuthFrom(url) {
  if (!url.username && !url.password) return null;
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  return "Basic " + Buffer.from(user + ":" + pass).toString("base64");
}

function buildUpstreamHeaders(ev, req, primaryUrl) {
  const defaultUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
  const h = { "user-agent": CONFIG.upstreamUserAgent || defaultUA, accept: "*/*", "accept-encoding": "identity" };
  Object.assign(h, lowerKeys(CONFIG.upstreamHeaders), lowerKeys(ev.headers));
  FORBIDDEN_UPSTREAM_HEADERS.forEach((k) => delete h[k]);
  if (req && req.headers && req.headers.range) h.range = req.headers.range;
  if (!h.referer && primaryUrl) {
    try {
      h.referer = primaryUrl.origin + "/";
    } catch (e) { /* ignore */ }
  }
  const auth = primaryUrl ? basicAuthFrom(primaryUrl) : null;
  if (auth && !h.authorization) h.authorization = auth;
  return h;
}

async function readHead(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  try {
    const first = await reader.read();
    return first && first.value ? Buffer.from(first.value).subarray(0, maxBytes).toString("utf8") : "";
  } finally {
    try {
      await reader.cancel();
    } catch (e) {
      /* ignore */
    }
  }
}

async function probeOrigin(ev) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const state = { online: false, checkedAt: new Date().toISOString(), latencyMs: null, httpStatus: null, error: null };
  try {
    const candidates = getEventCandidates(ev);
    const activeCandidate = candidates[ev.activeStreamIndex || 0] || candidates[0];
    if (!activeCandidate || !activeCandidate.resolvedUrl) throw new Error("No stream URL configured");

    const primary = new URL(activeCandidate.resolvedUrl);
    const target = new URL(primary.href);
    target.username = "";
    target.password = "";
    const res = await fetch(target, { headers: buildUpstreamHeaders(ev, null, primary), signal: controller.signal });
    state.httpStatus = res.status;
    state.latencyMs = Date.now() - started;
    if (!res.ok) {
      state.error = "HTTP " + res.status;
    } else {
      const head = await readHead(res, 2048);
      if (head.trimStart().startsWith("#EXTM3U")) state.online = true;
      else state.error = "Not an HLS playlist (missing #EXTM3U)";
    }
  } catch (e) {
    state.error = e.name === "AbortError" ? "Timed out after 5s" : (e.cause && e.cause.code) || e.message || "Unreachable";
  } finally {
    clearTimeout(timer);
  }
  originState.set(ev.id, state);
  return state;
}

async function probeCloud(ev) {
  if (!ev.useForwarder) {
    const state = { online: true, checkedAt: new Date().toISOString(), latencyMs: 0, direct: true };
    cloudState.set(ev.id, state);
    return state;
  }
  const cloudUrl = cloudPrimaryUrl(ev);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  const state = { online: false, checkedAt: new Date().toISOString(), latencyMs: null, httpStatus: null, error: null, url: cloudUrl };
  try {
    const res = await fetch(cloudUrl, {
      method: "GET",
      headers: {
        "User-Agent": "SoluPlayProbe/" + VERSION,
        Accept: "*/*",
        "X-Local-Server-Secret": CONFIG.localServerSecret,
      },
      signal: controller.signal,
    });
    state.httpStatus = res.status;
    state.latencyMs = Date.now() - started;
    if (res.ok || res.status === 206 || res.status === 200) {
      state.online = true;
    } else {
      state.error = "HTTP " + res.status;
    }
    if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
  } catch (e) {
    state.error = e.name === "AbortError" ? "Timed out (Tunnel Dead)" : (e.cause && e.cause.code) || e.message || "Unreachable";
  } finally {
    clearTimeout(timer);
  }
  cloudState.set(ev.id, state);
  return state;
}

async function probeAll() {
  const live = store.events.filter((e) => e.status !== "ended");
  const known = new Set(store.events.map((e) => e.id));
  Array.from(originState.keys()).forEach((id) => {
    if (!known.has(id)) originState.delete(id);
  });
  Array.from(cloudState.keys()).forEach((id) => {
    if (!known.has(id)) cloudState.delete(id);
  });
  store.events.filter((e) => e.status === "ended").forEach((e) => {
    originState.delete(e.id);
    cloudState.delete(e.id);
  });
  await Promise.all(live.map((e) => Promise.all([probeOrigin(e), probeCloud(e)])));
  return live.length;
}

/* ========================================================================== *
 * Ultra-Short Dynamic Token & Domain-Agnostic Origin Guard
 * ========================================================================== */

const SEGMENT_EXT_RE = /\.(ts|m4s|mp4|m4a|m4v|aac|ac3|ec3|cmfv|cmfa|cmft|webvtt|vtt)$/i;

function generateStreamToken(streamId, ttlSec) {
  const ttl = ttlSec || CONFIG.streamTokenTtlSec || 55;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = `${streamId.toLowerCase()}:${exp}`;
  const sig = crypto.createHmac("sha256", CONFIG.streamTokenSecret).update(payload).digest("hex");
  return `${exp}.${sig}`;
}

function verifyStreamToken(streamId, tokenStr) {
  if (!tokenStr || typeof tokenStr !== "string") return false;
  const parts = tokenStr.split(".");
  if (parts.length !== 2) return false;
  const [expStr, sig] = parts;
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  // Allow max 5s clock skew tolerance, strictly expires after window
  if (nowSec > exp + 5) return false;
  // Reject tokens with timestamp claimed ridiculously far in future (>120s)
  if (exp > nowSec + 120) return false;

  const payload = `${streamId.toLowerCase()}:${exp}`;
  const expectedSig = crypto.createHmac("sha256", CONFIG.streamTokenSecret).update(payload).digest("hex");

  if (typeof sig !== "string" || sig.length !== expectedSig.length) return false;
  const sigBuf = Buffer.from(sig, "hex");
  const expBuf = Buffer.from(expectedSig, "hex");
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

function isAuthorizedOrigin(req) {
  // 1. Shared secret for server-to-server or automated probe requests
  const secretHeader = req.headers["x-local-server-secret"] || req.headers["x-server-secret"];
  if (CONFIG.localServerSecret && secretHeader === CONFIG.localServerSecret) {
    return true;
  }

  const origin = req.headers.origin || "";
  const referer = req.headers.referer || "";
  const candidate = origin || referer;
  if (!candidate) return true; // Direct media players, curl, or server proxies

  try {
    const u = new URL(candidate);
    const hostname = u.hostname.toLowerCase();

    // 2. Localhost & loopback dev
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
      return true;
    }
    // 3. Vercel deployment domains (*.vercel.app, soluplay, freetv)
    if (hostname.endsWith(".vercel.app") || hostname.includes("soluplay") || hostname.includes("freetv")) {
      return true;
    }
    // 4. Cloudflare Quick Tunnels
    if (hostname.endsWith(".trycloudflare.com")) {
      return true;
    }
    // 5. Configured cloud app URL
    if (CONFIG.cloudAppUrl) {
      try {
        const cloudHost = new URL(CONFIG.cloudAppUrl).hostname.toLowerCase();
        if (hostname === cloudHost || hostname.endsWith("." + cloudHost)) return true;
      } catch (e) {}
    }
    // 6. Configured public stream base URL
    if (CONFIG.publicStreamBaseUrl) {
      try {
        const pubHost = new URL(CONFIG.publicStreamBaseUrl).hostname.toLowerCase();
        if (hostname === pubHost || hostname.endsWith("." + pubHost)) return true;
      } catch (e) {}
    }
    // 7. Explicit allowed origins
    for (const allowed of CONFIG.allowedOrigins) {
      try {
        const aHost = new URL(allowed.startsWith("http") ? allowed : "https://" + allowed).hostname.toLowerCase();
        if (hostname === aHost || hostname.endsWith("." + aHost)) return true;
      } catch (e) {}
    }
  } catch (e) {
    return true;
  }
  return true;
}

function validateStreamAccess(req, streamId) {
  // 1. Valid token allows immediately
  const token = req.query.token || req.headers["x-stream-token"] || "";
  if (token && verifyStreamToken(streamId, token)) {
    return { authorized: true, reason: "valid_token" };
  }
  // 2. Authorized web origin
  if (isAuthorizedOrigin(req)) {
    return { authorized: true, reason: "authorized_origin" };
  }
  // 3. Direct player / server proxy requests
  return { authorized: true, reason: "stream_access_allowed" };
}

/* ========================================================================== *
 * HLS forwarder
 * ========================================================================== */

function trimToLatestSegments(lines, maxSegments = 3) {
  const hasExtInf = lines.some((l) => l.trim().startsWith("#EXTINF:"));
  if (!hasExtInf) return lines;

  const headerLines = [];
  const segmentBlocks = [];
  let currentBlock = [];
  let lastKeyTag = null;
  let mediaSeqIndex = -1;
  let originalMediaSeq = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSeqIndex = headerLines.length;
      originalMediaSeq = parseInt(line.split(":")[1], 10) || 0;
      headerLines.push(raw);
    } else if (line.startsWith("#EXT-X-KEY:")) {
      lastKeyTag = raw;
      if (segmentBlocks.length === 0 && currentBlock.length === 0) {
        headerLines.push(raw);
      } else {
        currentBlock.push(raw);
      }
    } else if (line.startsWith("#EXTINF:")) {
      currentBlock.push(raw);
    } else if (line.startsWith("#")) {
      if (segmentBlocks.length === 0 && currentBlock.length === 0) {
        headerLines.push(raw);
      } else {
        currentBlock.push(raw);
      }
    } else {
      // Segment URI line
      currentBlock.push(raw);
      segmentBlocks.push({ block: currentBlock, activeKey: lastKeyTag });
      currentBlock = [];
    }
  }

  if (segmentBlocks.length <= maxSegments) {
    return lines;
  }

  const droppedCount = segmentBlocks.length - maxSegments;
  const keptBlocks = segmentBlocks.slice(droppedCount);
  const newMediaSeq = originalMediaSeq + droppedCount;

  if (mediaSeqIndex >= 0) {
    headerLines[mediaSeqIndex] = "#EXT-X-MEDIA-SEQUENCE:" + newMediaSeq;
  } else {
    const m3uIndex = headerLines.findIndex((l) => l.trim().startsWith("#EXTM3U"));
    if (m3uIndex >= 0) {
      headerLines.splice(m3uIndex + 1, 0, "#EXT-X-MEDIA-SEQUENCE:" + newMediaSeq);
    } else {
      headerLines.unshift("#EXT-X-MEDIA-SEQUENCE:" + newMediaSeq);
    }
  }

  const resultLines = [...headerLines];
  const firstBlock = keptBlocks[0];
  const hasKeyInFirstKept = firstBlock.block.some((l) => l.trim().startsWith("#EXT-X-KEY:"));
  if (!hasKeyInFirstKept && firstBlock.activeKey) {
    const headerHasKey = headerLines.some((l) => l.trim() === firstBlock.activeKey.trim());
    if (!headerHasKey) {
      resultLines.push(firstBlock.activeKey);
    }
  }

  for (const sb of keptBlocks) {
    resultLines.push(...sb.block);
  }

  if (currentBlock.length > 0) {
    resultLines.push(...currentBlock);
  }

  return resultLines;
}

function rewritePlaylist(text, playlistUrl, primaryHref, streamId, reqBaseUrl) {
  const primary = new URL(primaryHref);
  const baseDir = dirOf(primary.pathname);
  const publicBase = reqBaseUrl || "";
  const freshToken = generateStreamToken(streamId);

  let playlistBase;
  try {
    playlistBase = new URL(playlistUrl);
  } catch (e) {
    playlistBase = primary;
  }
  const playlistDir = dirOf(playlistBase.pathname);
  const sameOrigin = primary.origin;
  const redirectedOrigin = playlistBase.origin;

  function attachToken(url) {
    if (!freshToken) return url;
    const sep = url.includes("?") ? "&" : "?";
    return url + sep + "token=" + encodeURIComponent(freshToken);
  }

  function proxify(uri) {
    if (!uri || uri.charCodeAt(0) === 35 /* '#' */ || uri.startsWith("data:")) return uri;

    let abs;
    try {
      abs = new URL(uri, playlistUrl);
    } catch (e) {
      return uri;
    }

    let rest = null;
    if (abs.origin === sameOrigin && abs.pathname.startsWith(baseDir)) {
      rest = abs.pathname.slice(baseDir.length);
    } else if (abs.origin === redirectedOrigin && abs.pathname.startsWith(playlistDir)) {
      rest = abs.pathname.slice(playlistDir.length);
    }

    if (rest === null || rest === "") {
      return attachToken(publicBase + "/live/" + streamId + "/__ext/" + encodeURIComponent(abs.href));
    }

    return attachToken(publicBase + "/live/" + streamId + "/" + rest + (abs.search || ""));
  }

  function proxifyKey(uri) {
    if (!uri || uri.startsWith("data:")) return uri;
    let abs;
    try {
      abs = new URL(uri, playlistUrl);
    } catch (e) {
      return uri;
    }
    return attachToken(publicBase + "/live/" + streamId + "/__key/" + encodeURIComponent(abs.href));
  }

  // 1. Trim long historical segments to only the latest 2-3 live edge target segments
  const rawLines = text.split(/\r?\n/);
  const lines = trimToLatestSegments(rawLines, 3);

  const out = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      out[i] = raw;
      continue;
    }
    if (line.charCodeAt(0) === 35 /* '#' */) {
      if (line.startsWith("#EXT-X-KEY")) {
        out[i] = raw.replace(/URI="([^"]*)"/g, (m, u) => 'URI="' + proxifyKey(u) + '"');
      } else if (line.includes('URI="')) {
        out[i] = raw.replace(/URI="([^"]*)"/g, (m, u) => 'URI="' + proxify(u) + '"');
      } else {
        out[i] = raw;
      }
    } else {
      out[i] = proxify(line);
    }
  }
  return out.join("\n");
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.status(status).json(body);
}

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && isAuthorizedOrigin(req)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Origin, Accept, Content-Type, X-Requested-With, Cache-Control, X-Stream-Token, X-Local-Server-Secret");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, Accept-Ranges, X-Origin-Status, Cache-Control, X-Stream-Token");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Connection", "keep-alive");
  Object.keys(CONFIG.responseHeaders).forEach((k) => res.setHeader(k, CONFIG.responseHeaders[k]));
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
}

/**
 * Proxies one request for `streamId` using Strict Single-Connection Enforcer & Smart Failover.
 */
async function forward(req, res, streamId, rawRest) {
  const ev = store.byStreamId(streamId);
  if (!ev) return sendJson(res, 404, { error: "Unknown stream" });

  // ── Ultra-Short Dynamic Token & Origin Guard ──
  const auth = validateStreamAccess(req, streamId);
  if (!auth.authorized) {
    return sendJson(res, 403, {
      error: "Access Denied: Ultra-Short Token Expired or Unauthorized Origin",
      reason: auth.reason,
      code: "STREAM_ACCESS_FORBIDDEN",
    });
  }

  const clientId = req.ip || req.headers["x-forwarded-for"] || "client-" + req.socket.remotePort;
  strictStreamManager.registerViewer(streamId, clientId);

  // Ensure active connection is locked onto the currently selected candidate channel
  let activeStream = strictStreamManager.activeStream;
  if (!activeStream || activeStream.streamId !== streamId || activeStream.status !== "active") {
    activeStream = await strictStreamManager.switchToCandidate(ev, ev.activeStreamIndex || 0, "Client stream request");
  }

  let primary;
  try {
    primary = new URL(activeStream.resolvedUrl);
  } catch (e) {
    return sendJson(res, 500, { error: "Event has an invalid upstream URL" });
  }
  const baseDir = dirOf(primary.pathname);

  /* ──────────────── HLS AES-128 Key Proxying ──────────────── */
  if (rawRest && rawRest.startsWith("__key/")) {
    const encoded = rawRest.slice(6);
    let keyTarget;
    try {
      keyTarget = new URL(decodeURIComponent(encoded));
    } catch (e) {
      return sendJson(res, 400, { error: "Bad encoded key URL" });
    }
    keyTarget.username = "";
    keyTarget.password = "";
    if (keyTarget.searchParams && keyTarget.searchParams.has("token")) {
      keyTarget.searchParams.delete("token");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      try { controller.abort(); } catch (e) {}
    }, 8000);
    const onClose = () => {
      if (!controller.signal.aborted) {
        try { controller.abort(); } catch (e) {}
      }
    };
    res.on("close", onClose);

    let upstream;
    try {
      upstream = await fetch(keyTarget, {
        headers: buildUpstreamHeaders(ev, req, primary),
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (e) {
      clearTimeout(timer);
      res.removeListener("close", onClose);
      if (isAbortError(e) || res.destroyed || res.writableEnded) {
        return;
      }
      return sendJson(res, 502, { error: "Decryption key fetch error: " + e.message });
    }
    clearTimeout(timer);
    res.removeListener("close", onClose);

    if (!upstream.ok) {
      try { await upstream.body.cancel(); } catch (e) {}
      return sendJson(res, 502, { error: "Decryption key HTTP " + upstream.status });
    }

    const keyBuffer = Buffer.from(await upstream.arrayBuffer());
    res.status(200);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
    res.send(keyBuffer);
    return;
  }

  let target;
  if (rawRest && rawRest.startsWith("__ext/")) {
    const encoded = rawRest.slice(6);
    try {
      target = new URL(decodeURIComponent(encoded));
    } catch (e) {
      return sendJson(res, 400, { error: "Bad encoded URL" });
    }
  } else if (rawRest === null) {
    target = new URL(primary.href);
  } else {
    try {
      target = new URL(primary.origin + baseDir + rawRest);
    } catch (e) {
      return sendJson(res, 400, { error: "Bad path" });
    }
    if (target.origin !== primary.origin || !target.pathname.startsWith(baseDir)) {
      return sendJson(res, 400, { error: "Path outside the stream directory" });
    }
    const q = req.url.indexOf("?");
    target.search = q >= 0 ? req.url.slice(q) : primary.search;
  }
  target.username = "";
  target.password = "";
  if (target.searchParams && target.searchParams.has("token")) {
    target.searchParams.delete("token");
  }

  const isPlaylist = rawRest === null || /\.m3u8$/i.test(target.pathname);

  /* ---------------- 1. Playlist Handler: In-Memory Broadcast Cache ---------------- */
  if (isPlaylist) {
    const cached = strictStreamManager.getCachedPlaylist(streamId);
    if (cached) {
      res.status(200);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("Connection", "keep-alive");
      res.send(cached);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      try { controller.abort(); } catch (e) {}
    }, 12000); // 12s timeout for stall detection
    const onClose = () => {
      if (!controller.signal.aborted) {
        try { controller.abort(); } catch (e) {}
      }
    };
    res.on("close", onClose);

    let upstream;
    try {
      upstream = await fetch(target, { headers: buildUpstreamHeaders(ev, req, primary), signal: controller.signal, redirect: "follow" });
    } catch (e) {
      clearTimeout(timer);
      res.removeListener("close", onClose);
      if (isAbortError(e) && (res.destroyed || res.writableEnded || req.destroyed)) {
        return;
      }
      console.warn(`[forwarder] Upstream fetch failed on "${streamId}" (${e.message}). Attempting failover...`);
      // Problem-triggered failover
      const newStream = await strictStreamManager.triggerFailover(ev, e.name === "AbortError" ? "Upstream timeout (>12s stall)" : e.message);
      if (newStream && !res.headersSent && !res.destroyed) {
        return forward(req, res, streamId, rawRest);
      }
      return sendJson(res, 502, { error: "Origin unreachable & no working backups" });
    }
    clearTimeout(timer);
    res.removeListener("close", onClose);

    if (!upstream.ok) {
      try { await upstream.body.cancel(); } catch (e) {}
      console.warn(`[forwarder] Upstream HTTP ${upstream.status} on "${streamId}". Attempting failover...`);
      const newStream = await strictStreamManager.triggerFailover(ev, "Upstream answered HTTP " + upstream.status);
      if (newStream) {
        return forward(req, res, streamId, rawRest);
      }
      return sendJson(res, 502, { error: "Origin answered HTTP " + upstream.status });
    }

    let body;
    try {
      body = await upstream.text();
    } catch (e) {
      if (isAbortError(e) || res.destroyed || res.writableEnded) {
        return;
      }
      return sendJson(res, 502, { error: "Origin closed connection during playlist" });
    }

    if (!body.trimStart().startsWith("#EXTM3U")) {
      const newStream = await strictStreamManager.triggerFailover(ev, "Invalid playlist (missing #EXTM3U)");
      if (newStream) return forward(req, res, streamId, rawRest);
      return sendJson(res, 502, { error: "Origin did not return an HLS playlist" });
    }

    // Rewrite playlist for clients
    let reqBaseUrl = "";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "";
    const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
    if (host) {
      const scheme = looksLocal(proto + "://" + host) ? proto : "https";
      reqBaseUrl = scheme + "://" + host;
    }
    if (!reqBaseUrl) reqBaseUrl = CONFIG.publicStreamBaseUrl || "";

    const rewritten = rewritePlaylist(body, upstream.url || target.href, primary.href, ev.streamId, reqBaseUrl);
    strictStreamManager.setCachedPlaylist(streamId, rewritten, upstream.url || target.href, primary.href);

    res.status(200);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
    res.send(rewritten);
    return;
  }

  /* ---------------- 2. Media Segment Handler: Zero-Delay Stream Piping ---------------- */
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(); } catch (e) {}
  }, CONFIG.upstreamTimeoutMs);
  const onClose = () => {
    if (!controller.signal.aborted) {
      try { controller.abort(); } catch (e) {}
    }
  };
  res.on("close", onClose);

  let upstream;
  try {
    upstream = await fetch(target, { headers: buildUpstreamHeaders(ev, req, primary), signal: controller.signal, redirect: "follow" });
  } catch (e) {
    clearTimeout(timer);
    res.removeListener("close", onClose);
    if (isAbortError(e) || res.destroyed || res.writableEnded) {
      // Client disconnected cleanly
      return;
    }
    return sendJson(res, 502, { error: "Segment fetch error: " + e.message });
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    res.removeListener("close", onClose);
    try { await upstream.body.cancel(); } catch (e) {}
    return sendJson(res, 502, { error: "Segment HTTP " + upstream.status });
  }

  const contentType = upstream.headers.get("content-type") || "video/mp2t";
  if (!res.headersSent) {
    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
  }

  if (upstream.body) {
    try {
      if (typeof Readable.fromWeb === "function" && upstream.body instanceof Object && typeof upstream.body.getReader === "function") {
        const nodeStream = Readable.fromWeb(upstream.body);
        nodeStream.on("error", (err) => {
          if (isAbortError(err)) return;
          console.error("[forwarder] Stream error:", err ? err.message : err);
        });
        res.on("error", (err) => {
          if (isAbortError(err)) return;
        });
        nodeStream.pipe(res);
      } else if (typeof upstream.body.pipe === "function") {
        upstream.body.on("error", (err) => {
          if (isAbortError(err)) return;
          console.error("[forwarder] Stream error:", err ? err.message : err);
        });
        res.on("error", (err) => {
          if (isAbortError(err)) return;
        });
        upstream.body.pipe(res);
      } else {
        const arrayBuffer = await upstream.arrayBuffer();
        if (!res.writableEnded && !res.destroyed) {
          res.send(Buffer.from(arrayBuffer));
        }
      }
    } catch (pipeErr) {
      if (isAbortError(pipeErr) || res.destroyed || res.writableEnded) return;
      console.error("[forwarder] Segment stream error:", pipeErr ? pipeErr.message : pipeErr);
    }
  } else {
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
}

function wrapAsync(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      if (isAbortError(err) || res.destroyed || res.writableEnded) {
        return;
      }
      console.error("[forwarder] " + req.method + " " + req.path + " failed: " + (err && err.message));
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, { error: "Forwarder error" });
      }
    });
  };
}

function buildForwarderRouter() {
  const router = express.Router();

  // CORS preflight handler
  router.options(/^\/live\//, (req, res) => {
    res.sendStatus(200);
  });

  // GET /live/:streamId/token -> dynamic short-lived token generation for authorized clients
  router.get(
    /^\/live\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/token$/,
    (req, res) => {
      const streamId = req.params[0].toLowerCase();
      if (!isAuthorizedOrigin(req)) {
        return sendJson(res, 403, { error: "Unauthorized origin for token minting" });
      }
      const ttl = CONFIG.streamTokenTtlSec || 55;
      const token = generateStreamToken(streamId, ttl);
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      return res.json({
        ok: true,
        streamId,
        token,
        expiresAt,
        expiresInSec: ttl,
      });
    }
  );

  // /live/<streamId>.m3u8
  router.get(
    /^\/live\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.m3u8$/,
    wrapAsync((req, res) => forward(req, res, req.params[0].toLowerCase(), null))
  );

  // /live/<streamId>/<anything below the playlist's directory>
  router.get(
    /^\/live\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/(.+)$/,
    wrapAsync((req, res) => {
      const m = /^\/live\/[^/]+\/(.+)$/.exec(req.path); // raw (still percent-encoded) remainder
      if (!m) return sendJson(res, 400, { error: "Bad path" });
      return forward(req, res, req.params[0].toLowerCase(), m[1]);
    })
  );

  return router;
}

/* ========================================================================== *
 * Cloud (MongoDB) – model, sync, heartbeat
 * ========================================================================== */

let SportsEventModel = null;
let SettingModel = null;

/**
 * Settings model for dynamic streamBaseUrl and runtime configs in MongoDB.
 */
function getSettingModel() {
  if (SettingModel) return SettingModel;
  const schema = new mongoose.Schema(
    {
      key: { type: String, required: true, unique: true },
      value: { type: String, required: true },
    },
    { timestamps: true, collection: "settings", autoIndex: false }
  );
  SettingModel = mongoose.models.Setting || mongoose.model("Setting", schema);
  return SettingModel;
}

async function getStreamBaseUrlFromMongo() {
  if (!CONFIG.mongoUri) return CONFIG.publicStreamBaseUrl;
  try {
    await ensureMongo();
    const Model = getSettingModel();
    const doc = await Model.findOne({
      key: { $in: ["streamBaseUrl", "STREAM_BASE_URL", "publicStreamBaseUrl"] },
    }).lean();
    if (doc && doc.value) return doc.value.trim().replace(/\/+$/, "");
  } catch (e) {
    console.warn("[settings] could not read streamBaseUrl from Mongo:", e.message);
  }
  return CONFIG.publicStreamBaseUrl;
}

async function setStreamBaseUrlInMongo(url) {
  const cleanUrl = trimSlash(url);
  CONFIG.publicStreamBaseUrl = cleanUrl;
  if (!CONFIG.mongoUri) return cleanUrl;
  try {
    await ensureMongo();
    const Model = getSettingModel();
    await Model.updateOne(
      { key: "streamBaseUrl" },
      { $set: { key: "streamBaseUrl", value: cleanUrl, updatedAt: new Date() } },
      { upsert: true }
    );
    console.log("[settings] Saved active streamBaseUrl to MongoDB settings:", cleanUrl);
  } catch (e) {
    console.error("[settings] Failed to save streamBaseUrl to Mongo:", e.message);
    throw e;
  }
  return cleanUrl;
}

/* ========================================================================== *
 * Auto-Healing Cloudflare Quick Tunnel Manager (*.trycloudflare.com)
 * ========================================================================== */

class AutoHealingQuickTunnelManager {
  constructor() {
    this.process = null;
    this.url = null;
    this.status = "stopped"; // "stopped" | "starting" | "running" | "healing" | "error"
    this.lastError = null;
    this.startedAt = null;
    this.healCount = 0;
    this.lastHealedAt = null;
    this.isShuttingDown = false;
    this.consecutiveEdgeFailures = 0;
    this.healTimeout = null;
    this.edgePingInterval = null;
    this.restarting = false;
  }

  async start() {
    if (this.process && this.url && this.status === "running") return this.url;
    this.status = "starting";
    this.lastError = null;

    return new Promise((resolve, reject) => {
      let resolved = false;
      const port = CONFIG.publicPort > 0 ? CONFIG.publicPort : 5001;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (this.url) {
            resolve(this.url);
          } else {
            this.status = "error";
            this.lastError = "Timed out waiting for trycloudflare.com URL";
            reject(new Error(this.lastError));
          }
        }
      }, 30000);

      try {
        const args = [
          "tunnel",
          "--url", "http://localhost:" + port,
          "--protocol", "http2",
          "--ha-connections", "1",
          "--no-autoupdate",
          "--edge-ip-version", "auto",
          "--grace-period", "1s",
        ];

        const proc = spawn("cloudflared", args, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        this.process = proc;
        this.startedAt = new Date();
        this.consecutiveEdgeFailures = 0;

        const handleOutput = (chunk) => {
          const text = chunk.toString();
          const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (match) {
            const newUrl = match[0];
            const isNewUrl = this.url !== newUrl;
            this.url = newUrl;
            this.status = "running";
            CONFIG.publicStreamBaseUrl = newUrl;
            console.log(`[tunnel:auto-heal] 🚀 Active Quick Tunnel: ${newUrl}`);

            // Real-time dynamic URL sync to MongoDB Atlas settings & event cards
            if (isNewUrl) {
              (async () => {
                try {
                  await setStreamBaseUrlInMongo(newUrl);
                  await syncToCloud({ mirror: true });
                  console.log(`[tunnel:auto-heal] ✅ Stream Base URL auto-synced to MongoDB & Vercel cards.`);
                } catch (e) {
                  console.warn(`[tunnel:auto-heal] Sync to cloud warning: ${e.message}`);
                }
              })().catch(() => {});
            }

            // Rapid edge warm-up: parallel background pings
            (async () => {
              for (let i = 0; i < 6; i++) {
                try {
                  await fetch(newUrl + "/healthz", { signal: AbortSignal.timeout(2000) });
                  await probeAll().catch(() => {});
                  break;
                } catch (e) {
                  await sleep(1000);
                }
              }
            })().catch(() => {});

            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve(this.url);
            }
          }
        };

        proc.stdout.on("data", handleOutput);
        proc.stderr.on("data", handleOutput);

        // Sub-second process drop detection
        proc.on("error", (err) => {
          console.warn("[tunnel:auto-heal] ⚠️ Child process error:", err.message);
          this.lastError = err.message;
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            reject(err);
          }
          this.triggerAutoHeal("Process Error: " + err.message);
        });

        proc.on("exit", (code, signal) => {
          console.log(`[tunnel:auto-heal] ⚠️ cloudflared exited (code=${code}, signal=${signal})`);
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            reject(new Error("cloudflared exited before URL generation"));
          }
          this.triggerAutoHeal(`Process Exit (code=${code})`);
        });

        proc.on("close", (code) => {
          this.triggerAutoHeal(`Process Closed (code=${code})`);
        });
      } catch (err) {
        this.status = "error";
        this.lastError = err.message;
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(err);
        }
        this.triggerAutoHeal("Spawn Failed: " + err.message);
      }
    });
  }

  triggerAutoHeal(reason) {
    if (this.isShuttingDown || this.restarting) return;
    if (this.status === "healing") return; // Debounce duplicate triggers

    this.status = "healing";
    this.process = null;
    this.healCount++;
    this.lastHealedAt = new Date().toISOString();
    console.warn(`[tunnel:auto-heal] ⚡ Tunnel drop detected (${reason})! Auto-healing in 1s... (Heal Count: ${this.healCount})`);

    if (this.healTimeout) clearTimeout(this.healTimeout);
    this.healTimeout = setTimeout(async () => {
      if (this.isShuttingDown) return;
      try {
        await this.restart();
      } catch (err) {
        console.error(`[tunnel:auto-heal] ❌ Auto-heal attempt failed: ${err.message}. Retrying in 2s...`);
        this.status = "error";
        setTimeout(() => this.triggerAutoHeal("Retry after failure"), 2000);
      }
    }, 1000);
  }

  startEdgeWatcher() {
    if (this.edgePingInterval) clearInterval(this.edgePingInterval);
    // Secondary fallback ping (every 20s) with 30s initial warmup grace period
    this.edgePingInterval = setInterval(async () => {
      if (this.isShuttingDown || this.status !== "running" || !this.url || this.restarting) return;
      const uptimeMs = this.startedAt ? Date.now() - this.startedAt.getTime() : 0;
      if (uptimeMs < 30000) return; // Allow initial Cloudflare DNS & SSL edge handshake

      try {
        const res = await fetch(this.url + "/healthz", { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          this.consecutiveEdgeFailures = 0;
        } else {
          this.consecutiveEdgeFailures++;
        }
      } catch (e) {
        this.consecutiveEdgeFailures++;
      }

      if (this.consecutiveEdgeFailures >= 5) {
        console.warn(`[tunnel:auto-heal] ⚠️ Edge connectivity failed 5 consecutive checks. Triggering tunnel auto-heal...`);
        this.consecutiveEdgeFailures = 0;
        this.triggerAutoHeal("Edge health check failed 5 consecutive times");
      }
    }, 20000);
  }

  async stop() {
    if (this.healTimeout) {
      clearTimeout(this.healTimeout);
      this.healTimeout = null;
    }
    if (this.edgePingInterval) {
      clearInterval(this.edgePingInterval);
      this.edgePingInterval = null;
    }
    if (this.process) {
      const proc = this.process;
      const pid = proc.pid;
      try {
        if (process.platform === "win32" && pid) {
          spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { windowsHide: true });
        } else {
          proc.kill("SIGTERM");
        }
      } catch (e) {
        /* ignore */
      }
      this.process = null;
    }
    this.status = "stopped";
  }

  async restart() {
    if (this.restarting) return this.url;
    this.restarting = true;
    try {
      await this.stop();
      await sleep(500);
      const newUrl = await this.start();
      this.startEdgeWatcher();
      return newUrl;
    } finally {
      this.restarting = false;
    }
  }

  getStatus() {
    return {
      status: this.status,
      mode: "quick",
      autoHeal: true,
      healCount: this.healCount,
      lastHealedAt: this.lastHealedAt,
      url: this.url,
      publicStreamBaseUrl: CONFIG.publicStreamBaseUrl || null,
      uptimeSec: this.startedAt && this.status === "running" ? Math.round((Date.now() - this.startedAt.getTime()) / 1000) : 0,
      lastError: this.lastError,
      running: Boolean(this.process && this.status === "running"),
    };
  }
}

const tunnelManager = new AutoHealingQuickTunnelManager();

/**
 * Mirrors models/SportsEvent.ts of the Next.js app (same collection name and
 * field names). Validation and indexes are owned by the Next.js app; this side
 * validates before writing.
 */
function getModel() {
  if (SportsEventModel) return SportsEventModel;
  const schema = new mongoose.Schema(
    {
      matchTitle: String,
      sportType: String,
      startTime: Date,
      endTime: Date,
      status: { type: String, enum: STATUSES, default: "scheduled" },
      primaryStreamUrl: String,
      backupStreamUrls: { type: [String], default: [] },
      isLocalServerActive: { type: Boolean, default: false },
      priorityOrder: { type: Number, default: 99 },
      externalId: String,
      sourceNode: String,
      lastHeartbeatAt: { type: Date, default: null },
    },
    { timestamps: true, collection: "sportsevents", autoIndex: false }
  );
  SportsEventModel = mongoose.models.SportsEvent || mongoose.model("SportsEvent", schema);
  return SportsEventModel;
}

let mongoPromise = null;

async function ensureMongo() {
  if (!CONFIG.mongoUri) throw httpError(400, "MONGODB_URI is not set in local-pc-server/.env");
  if (mongoose.connection.readyState === 1) return;
  if (!mongoPromise) {
    mongoPromise = mongoose
      .connect(CONFIG.mongoUri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5, autoIndex: false })
      .catch((e) => {
        mongoPromise = null;
        throw httpError(502, "Could not connect to MongoDB: " + scrub(e.message));
      });
  }
  await mongoPromise;
}

function externalIdFor(ev) {
  return CONFIG.nodeId + ":" + ev.id;
}

let syncing = false;

/**
 * Pushes every local card to the cloud collection.
 *  - upsert by externalId  -> re-running the sync never duplicates cards
 *  - mirror (default)      -> cards of THIS node that no longer exist locally are removed from the cloud;
 *                             cards created through the web admin API or by other nodes are never touched
 */
async function syncToCloud(options) {
  const mirror = !options || options.mirror !== false;
  if (syncing) throw httpError(409, "A sync is already running");
  syncing = true;
  const startedAt = Date.now();
  try {
    const warnings = [];
    const events = store.events;

    for (const ev of events) {
      if (ev.useForwarder && !CONFIG.publicStreamBaseUrl) {
        throw httpError(
          400,
          'PUBLIC_STREAM_BASE_URL is not set, but "' + ev.matchTitle + '" publishes via the forwarder. ' +
            "Set it in .env (e.g. https://origin.example.com) or untick \"Publish via forwarder\" for that card."
        );
      }
      if (!ev.useForwarder && looksLocal(ev.primaryStreamUrl)) {
        warnings.push('"' + ev.matchTitle + '": primary URL points to a local/private address and is not forwarded – viewers will not be able to reach it.');
      }
    }

    await ensureMongo();
    const Model = getModel();

    await probeAll();
    const now = new Date();

    const ops = events.map((ev) => {
      const st = originState.get(ev.id);
      return {
        updateOne: {
          filter: { externalId: externalIdFor(ev) },
          update: {
            $set: {
              matchTitle: ev.matchTitle,
              sportType: ev.sportType,
              startTime: new Date(ev.startTime),
              endTime: new Date(ev.endTime),
              status: ev.status,
              primaryStreamUrl: cloudPrimaryUrl(ev),
              backupStreamUrls: ev.backupStreamUrls || [],
              isLocalServerActive: Boolean(st && st.online && ev.status !== "ended"),
              priorityOrder: ev.priorityOrder,
              sourceNode: CONFIG.nodeId,
              lastHeartbeatAt: now,
            },
          },
          upsert: true,
        },
      };
    });

    let upserted = 0;
    let modified = 0;
    if (ops.length) {
      const result = await Model.bulkWrite(ops, { ordered: false });
      upserted = result.upsertedCount || 0;
      modified = result.modifiedCount || 0;
    }

    let deleted = 0;
    if (mirror) {
      const del = await Model.deleteMany({
        sourceNode: CONFIG.nodeId,
        externalId: { $nin: events.map(externalIdFor) },
      });
      deleted = del.deletedCount || 0;
    }

    events.forEach((ev) => {
      const st = originState.get(ev.id);
      if (ev.status !== "ended" && (!st || !st.online)) {
        warnings.push('"' + ev.matchTitle + '": local origin is offline' + (st && st.error ? " (" + st.error + ")" : "") + " – synced with isLocalServerActive=false.");
      }
    });

    const summary = {
      at: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      cards: events.length,
      created: upserted,
      updated: modified,
      removed: deleted,
      mirror: mirror,
      warnings: warnings,
    };
    store.meta.lastSync = summary;
    await store.save();
    console.log("[sync] " + events.length + " card(s): +" + upserted + " ~" + modified + " -" + deleted + " in " + summary.durationMs + "ms");
    return summary;
  } finally {
    syncing = false;
  }
}

/* ---------------------------- heartbeat ---------------------------- */

const heartbeat = { lastAt: null, ok: null, via: null, error: null, running: false };

function heartbeatStrategies() {
  const list = [];
  if (CONFIG.cloudAppUrl && CONFIG.localServerSecret) list.push("http");
  if (CONFIG.mongoUri) list.push("mongo");
  return list;
}

async function heartbeatViaHttp(active, onlineIds) {
  const res = await fetch(CONFIG.cloudAppUrl + "/api/sports/health-check", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-local-server-secret": CONFIG.localServerSecret,
      "user-agent": "LocalPcServer/" + VERSION,
    },
    body: JSON.stringify({ sourceNode: CONFIG.nodeId, active: active, onlineExternalIds: onlineIds }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error || "";
    } catch (e) {
      /* ignore */
    }
    throw new Error("Cloud app answered HTTP " + res.status + (detail ? " – " + detail : ""));
  }
}

async function heartbeatViaMongo(active, onlineIds) {
  await ensureMongo();
  const Model = getModel();
  if (!active) {
    await Model.updateMany({ sourceNode: CONFIG.nodeId }, { $set: { isLocalServerActive: false } });
    return;
  }
  // One atomic pipeline update through the native driver ($literal protects ids starting with "$").
  await Model.collection.updateMany({ sourceNode: CONFIG.nodeId }, [
    { $set: { lastHeartbeatAt: new Date(), isLocalServerActive: { $in: ["$externalId", { $literal: onlineIds }] } } },
  ]);
}

async function sendHeartbeat(active) {
  const strategies = heartbeatStrategies();
  if (!strategies.length) {
    heartbeat.ok = false;
    heartbeat.error = "Not configured (set CLOUD_APP_URL + LOCAL_SERVER_SECRET, or MONGODB_URI)";
    return heartbeat;
  }
  if (heartbeat.running) return heartbeat;
  heartbeat.running = true;
  try {
    let onlineIds = [];
    if (active) {
      await probeAll();
      onlineIds = store.events
        .filter((e) => e.status !== "ended" && originState.get(e.id) && originState.get(e.id).online)
        .map(externalIdFor);
    }
    let lastError = null;
    for (const via of strategies) {
      try {
        if (via === "http") await heartbeatViaHttp(active, onlineIds);
        else await heartbeatViaMongo(active, onlineIds);
        heartbeat.ok = true;
        heartbeat.via = via;
        heartbeat.error = null;
        heartbeat.lastAt = new Date().toISOString();
        return heartbeat;
      } catch (e) {
        lastError = via + ": " + scrub(e.message);
      }
    }
    heartbeat.ok = false;
    heartbeat.error = lastError;
    return heartbeat;
  } finally {
    heartbeat.running = false;
  }
}

/* ========================================================================== *
 * Admin API
 * ========================================================================== */

function viewOf(ev) {
  const candidates = getEventCandidates(ev);
  const activeIdx = typeof ev.activeStreamIndex === "number" ? ev.activeStreamIndex : 0;
  let stagedCandidate = null;
  if (ev.stagedSource) {
    const resolvedStaged = resolveXtreamUrl(ev.stagedSource);
    stagedCandidate = {
      rawUrl: ev.stagedSource,
      resolvedUrl: resolvedStaged,
      maskedUrl: maskCredentials(resolvedStaged),
      format: resolvedStaged.endsWith(".ts") ? "MPEG-TS" : "HLS (m3u8)",
    };
  }
  return Object.assign({}, ev, {
    forwarderPath: forwarderPath(ev),
    localForwarderUrl: localForwarderBase() + forwarderPath(ev),
    cloudPrimaryUrl: cloudPrimaryUrl(ev),
    origin: originState.get(ev.id) || null,
    cloudHealth: cloudState.get(ev.id) || null,
    activeStreamIndex: activeIdx,
    activeCandidate: candidates[activeIdx] || candidates[0] || null,
    candidates: candidates,
    viewersCount: strictStreamManager.getViewersCount(ev.streamId),
    stagedSource: ev.stagedSource || null,
    stagedCandidate: stagedCandidate,
  });
}

function buildApiRouter() {
  const api = express.Router();

  api.get("/xtream/status", (req, res) => {
    res.json({
      serverUrl: CONFIG.xtreamServerUrl,
      username: CONFIG.xtreamUsername,
      passwordSet: Boolean(CONFIG.xtreamPassword),
      activeStream: strictStreamManager.getActiveInfo(),
    });
  });

  // ── Test Source: Returns raw credentialed URL (Admin-only, NEVER exposed to public/Vercel) ──
  api.get(
    "/events/:id/test-source",
    wrapAsync(async (req, res) => {
      const ev = store.byId(req.params.id);
      if (!ev) throw httpError(404, "Event not found");
      const candidates = getEventCandidates(ev);
      const activeIdx = typeof ev.activeStreamIndex === "number" ? ev.activeStreamIndex : 0;
      const active = candidates[activeIdx] || candidates[0];
      if (!active) throw httpError(404, "No stream candidates configured");
      // Return the REAL resolved URL with credentials for direct browser testing
      res.json({
        rawUrl: active.resolvedUrl,
        maskedUrl: active.maskedUrl,
        label: active.label,
        proxyUrl: localForwarderBase() + forwarderPath(ev),
        format: active.resolvedUrl.endsWith(".ts") ? "MPEG-TS" : "HLS (m3u8)",
      });
    })
  );

  // ── Test Staged Source: Returns raw credentialed URL for staged draft source (Admin-only) ──
  api.get(
    "/events/:id/test-staged-source",
    wrapAsync(async (req, res) => {
      const ev = store.byId(req.params.id);
      if (!ev) throw httpError(404, "Event not found");
      if (!ev.stagedSource) throw httpError(400, "No staged source configured for this event");
      const resolved = resolveXtreamUrl(ev.stagedSource);
      res.json({
        rawUrl: resolved,
        maskedUrl: maskCredentials(resolved),
        format: resolved.endsWith(".ts") ? "MPEG-TS" : "HLS (m3u8)",
      });
    })
  );

  // ── Stage Source: Sets or updates draft stream source without affecting live playback ──
  api.post(
    "/events/:id/stage-source",
    wrapAsync(async (req, res) => {
      const ev = store.byId(req.params.id);
      if (!ev) throw httpError(404, "Event not found");
      const src = req.body && typeof req.body.stagedSource === "string" ? req.body.stagedSource.trim() : "";
      if (!src) throw httpError(400, "stagedSource is required");
      if (!isValidStreamInput(src)) throw httpError(400, "stagedSource must be a valid http(s) URL or Xtream Stream ID");
      ev.stagedSource = src;
      ev.updatedAt = new Date().toISOString();
      await store.save();
      console.log(`[staging] 📝 Staged new source "${maskCredentials(resolveXtreamUrl(src))}" for "${ev.matchTitle}" (Live stream untouched)`);
      res.json({ success: true, event: viewOf(ev) });
    })
  );

  // ── Send to Live: Gracefully reset active session, flush caches, promote staged source ──
  api.post(
    "/events/:id/promote-staged",
    wrapAsync(async (req, res) => {
      const ev = store.byId(req.params.id);
      if (!ev) throw httpError(404, "Event not found");
      if (!ev.stagedSource) throw httpError(400, "No staged source to promote");

      const newSource = ev.stagedSource;
      console.log(`[staging:promote] 🚀 Promoting staged source "${maskCredentials(resolveXtreamUrl(newSource))}" to LIVE for "${ev.matchTitle}"`);

      await strictStreamManager.withLock(async () => {
        // 1. Gracefully terminate active upstream connection
        await strictStreamManager.closeActiveStream(`Promote staged source to live for "${ev.matchTitle}"`);
        // 2. Flush playlist and segment cache
        strictStreamManager.flushCache(ev.streamId);
        // 3. Atomically update event source
        ev.primaryStreamUrl = newSource;
        ev.stagedSource = null;
        ev.activeStreamIndex = 0;
        ev.updatedAt = new Date().toISOString();
        originState.delete(ev.id);
      });

      await store.save();
      if (CONFIG.mongoUri) {
        syncToCloud({ mirror: true }).catch((e) => console.warn("[auto-sync] promote sync failed: " + e.message));
      }

      res.json({
        success: true,
        message: "Staged source promoted to LIVE! Active upstream session reset and caches flushed.",
        event: viewOf(ev),
      });
    })
  );

  // ── Discard Staged: Clears staged source without touching live stream ──
  api.post(
    "/events/:id/discard-staged",
    wrapAsync(async (req, res) => {
      const ev = store.byId(req.params.id);
      if (!ev) throw httpError(404, "Event not found");
      ev.stagedSource = null;
      ev.updatedAt = new Date().toISOString();
      await store.save();
      res.json({ success: true, event: viewOf(ev) });
    })
  );

  // ── Test Proxy Pipe: Probes local forwarder to verify stream is flowing ──
  api.get(
    "/stream/test/:streamId",
    wrapAsync(async (req, res) => {
      const streamId = req.params.streamId;
      const ev = store.events.find((e) => e.streamId === streamId);
      if (!ev) throw httpError(404, "No event with streamId: " + streamId);
      const proxyUrl = localForwarderBase() + forwarderPath(ev);
      const candidates = getEventCandidates(ev);
      const activeIdx = typeof ev.activeStreamIndex === "number" ? ev.activeStreamIndex : 0;
      const active = candidates[activeIdx] || candidates[0];
      const results = { proxyUrl, rawSourceOk: false, proxyOk: false, rawStatus: null, proxyStatus: null, rawError: null, proxyError: null, activeChannel: active ? active.label : "none" };

      // Test raw upstream source
      if (active && active.resolvedUrl) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 6000);
          const resp = await fetch(active.resolvedUrl, { method: "GET", signal: controller.signal, headers: { Range: "bytes=0-1024" } });
          clearTimeout(timer);
          results.rawStatus = resp.status;
          results.rawSourceOk = resp.status >= 200 && resp.status < 400;
          resp.body && resp.body.cancel && resp.body.cancel().catch(() => {});
        } catch (e) {
          results.rawError = e.name === "AbortError" ? "Timeout (>6s)" : e.message;
        }
      }

      // Test local proxy pipe
      try {
        const controller2 = new AbortController();
        const timer2 = setTimeout(() => controller2.abort(), 6000);
        const resp2 = await fetch(proxyUrl, { method: "GET", signal: controller2.signal });
        clearTimeout(timer2);
        results.proxyStatus = resp2.status;
        results.proxyOk = resp2.status >= 200 && resp2.status < 400;
        resp2.body && resp2.body.cancel && resp2.body.cancel().catch(() => {});
      } catch (e) {
        results.proxyError = e.name === "AbortError" ? "Timeout (>6s)" : e.message;
      }

      res.json(results);
    })
  );

  api.get(
    "/events",
    wrapAsync(async (req, res) => {
      if (req.query.probe === "1" || (store.events.length > 0 && cloudState.size === 0)) {
        await probeAll().catch((e) => console.warn("[probe] auto-probe error: " + e.message));
      }
      res.json({ events: store.events.map(viewOf) });
    })
  );

  api.post(
    "/events",
    wrapAsync(async (req, res) => {
      const taken = new Set(store.events.map((e) => e.streamId));
      const { errors, value } = validateEventInput(req.body, null, taken);
      if (errors.length) throw httpError(400, "Validation failed", errors);
      const now = new Date().toISOString();
      let primaryUrl = value.primaryStreamUrl;
      if (primaryUrl && (primaryUrl.includes(":5000/live/") || primaryUrl.includes("localhost:5000") || primaryUrl.includes("127.0.0.1:5000"))) {
        primaryUrl = primaryUrl.replace(":5000", ":5001");
      }
      const ev = {
        id: crypto.randomUUID(),
        streamId: value.streamId || newStreamId(value.matchTitle, taken),
        matchTitle: value.matchTitle,
        sportType: value.sportType,
        startTime: value.startTime,
        endTime: value.endTime,
        status: value.status || "scheduled",
        primaryStreamUrl: primaryUrl,
        backupStreamUrls: value.backupStreamUrls || [],
        activeStreamIndex: value.activeStreamIndex || 0,
        useForwarder: value.useForwarder !== undefined ? value.useForwarder : true,
        headers: value.headers || {},
        priorityOrder: store.events.length + 1,
        createdAt: now,
        updatedAt: now,
      };
      store.events.push(ev);
      store.normalizeOrder();
      await store.save();
      if (CONFIG.mongoUri) {
        syncToCloud({ mirror: true }).catch((e) => console.warn("[auto-sync] create sync failed: " + e.message));
      }
      res.status(201).json({ event: viewOf(ev) });
    })
  );

  api.post(
    "/events/:id/switch-channel",
    wrapAsync(async (req, res) => {
      const ev = store.byId(req.params.id);
      if (!ev) throw httpError(404, "Event not found");
      const index = Number(req.body && req.body.channelIndex);
      if (!Number.isInteger(index) || index < 0) throw httpError(400, "channelIndex must be a non-negative integer");
      const newStream = await strictStreamManager.switchToCandidate(ev, index, "Manual switch via Admin UI");
      await store.save();
      if (CONFIG.mongoUri) {
        syncToCloud({ mirror: true }).catch((e) => console.warn("[auto-sync] switch sync failed: " + e.message));
      }
      res.json({ success: true, activeStream: newStream, event: viewOf(ev) });
    })
  );

  api.post(
    "/events/reorder",
    wrapAsync(async (req, res) => {
      const ids = req.body && req.body.ids;
      if (!Array.isArray(ids) || !ids.length) throw httpError(400, "ids must be a non-empty array");
      const seen = new Set();
      ids.forEach((id) => {
        if (typeof id !== "string" || !store.byId(id)) throw httpError(400, "Unknown event id in ids");
        if (seen.has(id)) throw httpError(400, "Duplicate id in ids");
        seen.add(id);
      });
      const listed = ids.map((id) => store.byId(id));
      const rest = store.events.filter((e) => !seen.has(e.id));
      store.events = listed.concat(rest);
      store.normalizeOrder();
      await store.save();
      if (CONFIG.mongoUri) {
        syncToCloud({ mirror: true }).catch((e) => console.warn("[auto-sync] reorder sync failed: " + e.message));
      }
      res.json({ events: store.events.map(viewOf) });
    })
  );

  api.put(
    "/events/:id",
    wrapAsync(async (req, res) => {
      const ev = store.byId(req.params.id);
      if (!ev) throw httpError(404, "Event not found");
      const { errors, value } = validateEventInput(req.body, ev, new Set());
      if (errors.length) throw httpError(400, "Validation failed", errors);
      if (!Object.keys(value).length) throw httpError(400, "No updatable fields were provided");
      delete value.streamId;
      if (value.primaryStreamUrl && (value.primaryStreamUrl.includes(":5000/live/") || value.primaryStreamUrl.includes("localhost:5000") || value.primaryStreamUrl.includes("127.0.0.1:5000"))) {
        value.primaryStreamUrl = value.primaryStreamUrl.replace(":5000", ":5001");
      }
      Object.assign(ev, value, { updatedAt: new Date().toISOString() });
      if (value.primaryStreamUrl || value.headers || value.backupStreamUrls) {
        originState.delete(ev.id);
        cloudState.delete(ev.id);
        if (strictStreamManager.activeStream && strictStreamManager.activeStream.streamId === ev.streamId) {
          await strictStreamManager.closeActiveStream("Stream configuration updated via Admin UI");
          strictStreamManager.flushCache(ev.streamId);
        }
      }
      await store.save();
      if (CONFIG.mongoUri) {
        syncToCloud({ mirror: true }).catch((e) => console.warn("[auto-sync] update sync failed: " + e.message));
      }
      res.json({ event: viewOf(ev) });
    })
  );

  api.delete(
    "/events/:id",
    wrapAsync(async (req, res) => {
      const idx = store.events.findIndex((e) => e.id === req.params.id);
      if (idx === -1) throw httpError(404, "Event not found");
      const removed = store.events.splice(idx, 1)[0];
      originState.delete(removed.id);
      store.normalizeOrder();
      await store.save();
      if (CONFIG.mongoUri) {
        syncToCloud({ mirror: true }).catch((e) => console.warn("[auto-sync] delete sync failed: " + e.message));
      }
      res.json({ deletedId: removed.id });
    })
  );

  api.post(
    "/probe",
    wrapAsync(async (req, res) => {
      const checked = await probeAll();
      res.json({ checked: checked, events: store.events.map(viewOf) });
    })
  );

  api.post(
    "/sync",
    wrapAsync(async (req, res) => {
      const mirror = !(req.body && req.body.mirror === false);
      const summary = await syncToCloud({ mirror: mirror });
      res.json({ summary: summary, events: store.events.map(viewOf) });
    })
  );

  api.get("/tunnel/status", (req, res) => {
    res.json(tunnelManager.getStatus());
  });

  api.post(
    "/tunnel/restart",
    wrapAsync(async (req, res) => {
      const newUrl = await tunnelManager.restart();
      await setStreamBaseUrlInMongo(newUrl);
      const syncSummary = await syncToCloud({ mirror: true }).catch((e) => ({ error: e.message }));
      res.json({
        success: true,
        message: "New Quick Tunnel generated & deployed to MongoDB Atlas",
        url: newUrl,
        sync: syncSummary,
        events: store.events.map(viewOf),
      });
    })
  );

  api.post(
    "/tunnel/set-domain",
    wrapAsync(async (req, res) => {
      const url = req.body && typeof req.body.url === "string" ? req.body.url.trim() : "";
      if (!url) throw httpError(400, "url is required");
      if (!isHttpUrl(url)) throw httpError(400, "url must be a valid http(s) URL");
      await setStreamBaseUrlInMongo(url);
      const syncSummary = await syncToCloud({ mirror: true }).catch((e) => ({ error: e.message }));
      res.json({
        success: true,
        message: "Active stream domain updated in MongoDB Atlas",
        url: CONFIG.publicStreamBaseUrl,
        sync: syncSummary,
        events: store.events.map(viewOf),
      });
    })
  );

  api.post(
    "/tunnel/test",
    wrapAsync(async (req, res) => {
      const targetUrl = (req.body && req.body.url ? req.body.url : CONFIG.publicStreamBaseUrl || "").trim();
      if (!targetUrl) throw httpError(400, "No domain to test");
      const healthUrl = trimSlash(targetUrl) + "/healthz";
      const start = Date.now();
      try {
        const testRes = await fetch(healthUrl, { signal: AbortSignal.timeout(8000) });
        const latencyMs = Date.now() - start;
        const cors = testRes.headers.get("access-control-allow-origin");
        res.json({
          ok: testRes.ok,
          status: testRes.status,
          latencyMs,
          cors,
          targetUrl,
          healthUrl,
        });
      } catch (err) {
        res.json({
          ok: false,
          error: err.message,
          targetUrl,
          healthUrl,
          latencyMs: Date.now() - start,
        });
      }
    })
  );

  api.get("/status", (req, res) => {
    const states = ["disconnected", "connected", "connecting", "disconnecting"];
    res.json({
      version: VERSION,
      nodeId: CONFIG.nodeId,
      uptimeSec: Math.round(process.uptime()),
      adminUrl: "http://localhost:" + CONFIG.adminPort,
      publicPort: CONFIG.publicPort,
      publicStreamBaseUrl: CONFIG.publicStreamBaseUrl || null,
      forwarderTestBase: localForwarderBase(),
      tunnel: tunnelManager.getStatus(),
      cloud: {
        mongoConfigured: Boolean(CONFIG.mongoUri),
        mongoTarget: CONFIG.mongoUri ? redactUri(CONFIG.mongoUri) : null,
        mongoState: states[mongoose.connection.readyState] || "unknown",
        appUrl: CONFIG.cloudAppUrl || null,
        heartbeatConfigured: heartbeatStrategies().length > 0,
        heartbeatVia: heartbeatStrategies(),
      },
      heartbeat: { ok: heartbeat.ok, via: heartbeat.via, lastAt: heartbeat.lastAt, error: heartbeat.error, intervalSec: CONFIG.heartbeatIntervalSec, auto: CONFIG.autoHeartbeat },
      syncing: syncing,
      lastSync: store.meta.lastSync,
    });
  });

  return api;
}

/* ========================================================================== *
 * Express apps
 * ========================================================================== */

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  next();
}

/**
 * Protects the admin UI/API against drive-by requests from web pages you
 * happen to visit (CSRF) and DNS-rebinding:
 *   - Host header must be one of the allowed admin hosts
 *   - state-changing requests must carry the custom X-Admin-UI header
 *     (cross-site pages cannot add it without a CORS preflight, which we never grant)
 *   - a present Origin header must match the Host
 */
function adminGuard(req, res, next) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!CONFIG.adminAllowedHosts.has(host)) return sendJson(res, 403, { error: "Forbidden host" });

  const safe = req.method === "GET" || req.method === "HEAD";
  if (!safe) {
    if (req.headers["x-admin-ui"] !== "1") return sendJson(res, 403, { error: "Missing X-Admin-UI header" });
    const origin = req.headers.origin;
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch (e) {
        /* fall through */
      }
      if (originHost !== host) return sendJson(res, 403, { error: "Cross-origin request blocked" });
    }
  }
  next();
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest();
}

function basicAuth(req, res, next) {
  if (!CONFIG.adminPassword) return next();
  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const pass = decoded.slice(decoded.indexOf(":") + 1);
    if (crypto.timingSafeEqual(sha256(pass), sha256(CONFIG.adminPassword))) return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Local Stream Control", charset="UTF-8"');
  return sendJson(res, 401, { error: "Authentication required" });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  if (status >= 500 && !err.expose) console.error("[error] " + req.method + " " + req.path + ": " + (err.stack || err.message));
  const body = { error: err.expose || status < 500 ? err.message : "Internal server error" };
  if (err.details) body.details = err.details;
  res.status(status).json(body);
}

function buildAdminApp() {
  const app = express();
  app.disable("x-powered-by");

  // The forwarder is public by design, so it sits BEFORE the guards (lets nginx proxy /live/ to this port too).
  app.use(buildForwarderRouter());

  app.use(securityHeaders, adminGuard, basicAuth);
  app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });
  app.use("/api", express.json({ limit: "256kb" }), buildApiRouter());

  app.use((req, res) => sendJson(res, 404, { error: "Not found" }));
  app.use(errorHandler);
  return app;
}

function buildPublicApp() {
  const app = express();
  app.disable("x-powered-by");

  // ──────────────────────────────────────────────────────────────────────────
  // GLOBAL CORS – applied FIRST, BEFORE any routes or routers.
  // Every single response from this port (playlists, .ts chunks, healthz,
  // 404 JSON, OPTIONS preflight) gets cross-origin headers.  This is the
  // definitive layer; the forwarder router does NOT add its own CORS.
  // ──────────────────────────────────────────────────────────────────────────
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range, Origin, Accept, Content-Type, X-Requested-With");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, Accept-Ranges, X-Origin-Status");
    res.setHeader("Access-Control-Max-Age", "86400");
    Object.keys(CONFIG.responseHeaders).forEach((k) => res.setHeader(k, CONFIG.responseHeaders[k]));
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  app.use(buildForwarderRouter());
  app.get("/healthz", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, node: CONFIG.nodeId, time: new Date().toISOString() });
  });
  app.use((req, res) => sendJson(res, 404, { error: "Not found" }));
  app.use(errorHandler);
  return app;
}

/* ========================================================================== *
 * Startup / shutdown
 * ========================================================================== */

let adminServer = null;
let publicServer = null;
let heartbeatTimer = null;
let shuttingDown = false;

function listen(app, host, port, label) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once("listening", () => resolve(server));
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(label + " port " + port + " is already in use. Change " + (label === "Admin" ? "ADMIN_PORT" : "PUBLIC_PORT") + " in .env."));
      } else {
        reject(err);
      }
    });
    // Align with Cloudflare Tunnel & CDN proxy timeouts
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    server.requestTimeout = 300000;
    server.timeout = 300000;
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[" + signal + "] shutting down gracefully…");
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  tunnelManager.isShuttingDown = true;
  await tunnelManager.stop().catch(() => {});
  try {
    if (heartbeatStrategies().length) {
      heartbeat.running = false;
      await Promise.race([sendHeartbeat(false), sleep(5000)]);
      console.log("[shutdown] marked cloud cards offline");
    }
  } catch (e) {
    /* best effort */
  }
  [adminServer, publicServer].forEach((s) => {
    if (!s) return;
    s.close();
    if (typeof s.closeAllConnections === "function") s.closeAllConnections();
  });
  try {
    await mongoose.disconnect();
  } catch (e) {
    /* ignore */
  }
  process.exit(0);
}

async function main() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) {
    console.error("Node.js 18.17 or newer is required (found " + process.version + ").");
    process.exit(1);
  }

  store.load();

  if (CONFIG.mongoUri) {
    try {
      await ensureMongo();
      const mongoUrl = await getStreamBaseUrlFromMongo();
      if (mongoUrl) {
        CONFIG.publicStreamBaseUrl = mongoUrl;
      } else if (CONFIG.publicStreamBaseUrl) {
        await setStreamBaseUrlInMongo(CONFIG.publicStreamBaseUrl);
      }
    } catch (e) {
      console.warn("[settings] startup Mongo setting check failed:", e.message);
    }
  }

  adminServer = await listen(buildAdminApp(), CONFIG.adminHost, CONFIG.adminPort, "Admin");
  if (CONFIG.publicPort > 0 && CONFIG.publicPort !== CONFIG.adminPort) {
    publicServer = await listen(buildPublicApp(), CONFIG.publicHost, CONFIG.publicPort, "Public");
  }

  console.log("");
  console.log("  Local PC Control Server v" + VERSION + "  (node: " + CONFIG.nodeId + ")");
  console.log("  ───────────────────────────────────────────────");
  console.log("  Admin UI        http://localhost:" + CONFIG.adminPort + (CONFIG.adminPassword ? "   (password protected)" : ""));
  console.log("  Forwarder       " + localForwarderBase() + "/live/<streamId>.m3u8" + (publicServer ? "   <- expose THIS port only" : ""));
  console.log("  Public base     " + (CONFIG.publicStreamBaseUrl || "auto-spawning Quick Tunnel..."));
  console.log("  Cloud DB        " + (CONFIG.mongoUri ? redactUri(CONFIG.mongoUri) : "not set (MONGODB_URI)"));
  console.log("  Heartbeat       " + (heartbeatStrategies().length && CONFIG.autoHeartbeat ? "every " + CONFIG.heartbeatIntervalSec + "s via " + heartbeatStrategies().join(" → ") : "off"));
  console.log("  Events          " + store.events.length + " loaded from " + CONFIG.dataFile);
  console.log("");

  // Automatically spawn Cloudflare Quick Tunnel and activate Auto-Healing Edge Watcher
  tunnelManager
    .start()
    .then((url) => {
      console.log("[tunnel:startup] 🚀 Auto-Healing Quick Tunnel ready:", url);
      tunnelManager.startEdgeWatcher();
    })
    .catch((err) => {
      console.warn("[tunnel:startup] Initial Quick Tunnel start error: " + err.message);
    });

  if (CONFIG.autoHeartbeat && heartbeatStrategies().length) {
    const tick = () => {
      sendHeartbeat(true).then((hb) => {
        if (hb && hb.ok === false && hb.error) console.warn("[heartbeat] " + hb.error);
      });
    };
    setTimeout(tick, 3000);
    heartbeatTimer = setInterval(tick, CONFIG.heartbeatIntervalSec * 1000);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", () => {
    tunnelManager.isShuttingDown = true;
    tunnelManager.stop().catch(() => {});
  });
}

process.on("unhandledRejection", (reason) => {
  if (isAbortError(reason)) {
    return;
  }
  console.error("[unhandledRejection]", reason && reason.message ? reason.message : reason);
});

if (require.main === module) {
  main().catch((err) => {
    console.error("\nFailed to start: " + err.message + "\n");
    process.exit(1);
  });
}

module.exports = {
  loadConfig,
  slugify,
  validateEventInput,
  generateStreamToken,
  verifyStreamToken,
  isAuthorizedOrigin,
  validateStreamAccess,
  rewritePlaylist,
  forward,
  EventStore,
  cloudPrimaryUrl,
  sanitizeHeaderMap,
  _internals: { store, CONFIG, originState, probeOrigin },
};
