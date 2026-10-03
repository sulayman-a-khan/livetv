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
    autoHeartbeat: envBool(env, "AUTO_HEARTBEAT", true),
    heartbeatIntervalSec: envInt(env, "HEARTBEAT_INTERVAL_SEC", 30, 5, 3600),

    corsOrigins: (env.CORS_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean),
    upstreamHeaders: envHeaders(env, "UPSTREAM_HEADERS_JSON"),
    responseHeaders: envHeaders(env, "RESPONSE_HEADERS_JSON"),
    upstreamTimeoutMs: envInt(env, "UPSTREAM_TIMEOUT_SEC", 10, 1, 120) * 1000,

    dataFile: path.resolve(__dirname, env.DATA_FILE || "data/events.json"),
  };
}

const CONFIG = loadConfig(process.env);

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
    if (v.length > 2048 || !isHttpUrl(v)) {
      errors.push("invalid backup URL: " + v.slice(0, 80));
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
    if (u && u.length <= 2048 && isHttpUrl(u)) v.primaryStreamUrl = u;
    else errors.push("primaryStreamUrl must be an absolute http(s) URL");
  } else if (creating) {
    errors.push("primaryStreamUrl is required");
  }

  if (has("backupStreamUrls")) v.backupStreamUrls = parseUrlList(src.backupStreamUrls, errors);

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

function localForwarderBase() {
  const port = CONFIG.publicPort > 0 ? CONFIG.publicPort : 5001;
  return "http://localhost:" + port;
}

/** URL viewers should use for a forwarded stream. */
function forwarderPath(ev) {
  return "/live/" + ev.streamId + ".m3u8";
}

/** What gets written to the cloud as primaryStreamUrl. */
function cloudPrimaryUrl(ev) {
  if (!ev.useForwarder) return ev.primaryStreamUrl;
  let base = (CONFIG.publicStreamBaseUrl || localForwarderBase()).trim().replace(/\/+$/, "");
  // Force HTTPS on public / Cloudflare tunnel domains to prevent Mixed Content security blocks
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
  const h = { "user-agent": "LocalHLSForwarder/" + VERSION, accept: "*/*", "accept-encoding": "identity" };
  // Merge global upstream headers, then per-event headers (Referer, User-Agent, etc.)
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
    const primary = new URL(ev.primaryStreamUrl);
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
  const timer = setTimeout(() => controller.abort(), 4000);
  const state = { online: false, checkedAt: new Date().toISOString(), latencyMs: null, httpStatus: null, error: null, url: cloudUrl };
  try {
    const res = await fetch(cloudUrl, {
      method: "GET",
      headers: { Range: "bytes=0-512", "User-Agent": "SoluPlayProbe/" + VERSION },
      signal: controller.signal,
    });
    state.httpStatus = res.status;
    state.latencyMs = Date.now() - started;
    if (res.ok || res.status === 206 || res.status === 200) {
      state.online = true;
    } else {
      state.error = "HTTP " + res.status;
    }
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
 * HLS forwarder
 * ========================================================================== */

const SEGMENT_EXT_RE = /\.(ts|m4s|mp4|m4a|m4v|aac|ac3|ec3|cmfv|cmfa|cmft|webvtt|vtt)$/i;

/**
 * Rewrites every URI in an HLS playlist (both media segments and variant sub-playlists)
 * so that they become absolute HTTPS URLs routed back through the forwarder.
 *
 * This handles:
 *   - Purely relative URIs      (segment001.ts)
 *   - Path-absolute URIs         (/hls/match1/segment001.ts)
 *   - Fully-qualified URIs       (http://encoder:8080/hls/match1/segment001.ts)
 *   - URIs in #EXT-X-MAP / KEY   (URI="init.mp4")
 *   - Redirected playlist URLs   (playlistUrl may differ from primaryHref after 302s)
 *
 * Every segment that resolves to the same origin+directory as the primary stream URL
 * is rewritten.  Segments pointing to entirely different CDNs are also proxied through
 * the forwarder to avoid mixed-content / CORS issues on the client side.
 */
function rewritePlaylist(text, playlistUrl, primaryHref, streamId, reqBaseUrl) {
  const primary = new URL(primaryHref);
  const baseDir = dirOf(primary.pathname);
  const publicBase = reqBaseUrl || "";

  let playlistBase;
  try {
    playlistBase = new URL(playlistUrl);
  } catch (e) {
    playlistBase = primary;
  }
  const playlistDir = dirOf(playlistBase.pathname);
  const sameOrigin = primary.origin;
  const redirectedOrigin = playlistBase.origin;

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
      return publicBase + "/live/" + streamId + "/__ext/" + encodeURIComponent(abs.href);
    }

    return publicBase + "/live/" + streamId + "/" + rest + (abs.search || "");
  }

  const lines = text.split(/\r?\n/);
  const out = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      out[i] = raw;
      continue;
    }
    if (line.charCodeAt(0) === 35 /* '#' */) {
      if (line.includes('URI="')) {
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

/**
 * Global CORS middleware applied before ANY route on the public port.
 * Every response (including .ts segment chunks, sub-playlist .m3u8s, error JSON,
 * and OPTIONS preflights) gets permissive cross-origin headers so that external
 * players, soluplay.vercel.app, and any web-based HLS consumer can fetch freely.
 */
function corsMiddleware(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Origin, Accept, Content-Type, X-Requested-With, Cache-Control");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, Accept-Ranges, X-Origin-Status, Cache-Control");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Connection", "keep-alive");
  // Custom response headers from config
  Object.keys(CONFIG.responseHeaders).forEach((k) => res.setHeader(k, CONFIG.responseHeaders[k]));
  if (req.method === "OPTIONS") {
    // Immediately satisfy CORS preflight – no further processing needed.
    return res.sendStatus(200);
  }
  next();
}

/**
 * Proxies one request for `streamId`.
 *   rawRest === null  -> the event's playlist  (/live/<id>.m3u8)
 *   rawRest = "a/b.ts" -> a file below the playlist's directory (/live/<id>/a/b.ts)
 * `rawRest` is the still percent-encoded remainder of the request path.
 */
async function forward(req, res, streamId, rawRest) {
  const ev = store.byStreamId(streamId);
  if (!ev) return sendJson(res, 404, { error: "Unknown stream" });

  let primary;
  try {
    primary = new URL(ev.primaryStreamUrl);
  } catch (e) {
    return sendJson(res, 500, { error: "Event has an invalid origin URL" });
  }
  const baseDir = dirOf(primary.pathname);

  let target;

  // Handle __ext/ encoded external URLs (from rewritePlaylist for cross-origin segments)
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
      // WHATWG URL parsing collapses "." / ".." / "%2e%2e" segments, so the prefix check below is reliable.
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.upstreamTimeoutMs);
  res.on("close", () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(target, { headers: buildUpstreamHeaders(ev, req, primary), signal: controller.signal, redirect: "follow" });
  } catch (e) {
    clearTimeout(timer);
    const reason = e.name === "AbortError" ? "Origin timed out" : "Origin unreachable";
    return sendJson(res, 502, { error: reason });
  }
  clearTimeout(timer);

  if (upstream.status === 404) {
    try {
      await upstream.body.cancel();
    } catch (e) {
      /* ignore */
    }
    return sendJson(res, 404, { error: "Not found on origin" });
  }
  if (!upstream.ok) {
    try {
      await upstream.body.cancel();
    } catch (e) {
      /* ignore */
    }
    res.setHeader("X-Origin-Status", String(upstream.status));
    return sendJson(res, 502, { error: "Origin answered HTTP " + upstream.status });
  }

  const contentType = upstream.headers.get("content-type") || "";
  const isPlaylist = /\.m3u8$/i.test(target.pathname) || /mpegurl/i.test(contentType);

  /* ---------------- playlist: buffer, rewrite, send ---------------- */
  if (isPlaylist) {
    const declared = Number(upstream.headers.get("content-length") || 0);
    if (declared > MAX_PLAYLIST_BYTES) return sendJson(res, 502, { error: "Playlist too large" });
    let body;
    const bodyTimer = setTimeout(() => controller.abort(), CONFIG.upstreamTimeoutMs);
    try {
      body = await upstream.text();
    } catch (e) {
      return sendJson(res, 502, { error: "Origin closed the connection" });
    } finally {
      clearTimeout(bodyTimer);
    }
    if (body.length > MAX_PLAYLIST_BYTES) return sendJson(res, 502, { error: "Playlist too large" });
    if (!body.trimStart().startsWith("#EXTM3U")) {
      return sendJson(res, 502, { error: "Origin did not return an HLS playlist" });
    }
    // Build the public base URL for absolute URI rewriting.
    // Use the INCOMING request's Host header so that whatever domain the viewer
    // used (Cloudflare tunnel, custom domain, etc.) is what the segments point to.
    // Fall back to PUBLIC_STREAM_BASE_URL from config, then to the raw host header.
    let reqBaseUrl = "";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "";
    const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
    if (host) {
      // Always force HTTPS for non-local hosts to prevent mixed-content blocks
      const scheme = looksLocal(proto + "://" + host) ? proto : "https";
      reqBaseUrl = scheme + "://" + host;
    }
    if (!reqBaseUrl) {
      reqBaseUrl = CONFIG.publicStreamBaseUrl || "";
    }
    const rewritten = rewritePlaylist(body, upstream.url || target.href, primary.href, ev.streamId, reqBaseUrl);
    res.status(200);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
    res.send(rewritten);
    return;
  }

  /* ---------------- media / key / other: zero-buffering direct pipe ---------------- */
  res.status(upstream.status);
  if (contentType) res.setHeader("Content-Type", contentType);
  else if (/\.ts$/i.test(target.pathname)) res.setHeader("Content-Type", "video/mp2t");

  const encoded = (upstream.headers.get("content-encoding") || "").toLowerCase();
  const passLength = !encoded || encoded === "identity";
  ["content-range", "accept-ranges", "etag", "last-modified"].forEach((h) => {
    const val = upstream.headers.get(h);
    if (val) res.setHeader(h, val);
  });
  if (passLength) {
    const len = upstream.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);
  }

  // Cloudflare CDN edge caching: cache immutable video chunks for 3600s globally for instant multi-user delivery
  const isSegment = SEGMENT_EXT_RE.test(target.pathname) || /\.ts$/i.test(target.pathname);
  res.setHeader(
    "Cache-Control",
    isSegment ? "public, max-age=3600, s-maxage=3600, immutable" : "no-cache, no-store, must-revalidate"
  );
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Connection", "keep-alive");

  if (!upstream.body) {
    res.end();
    return;
  }
  pipeline(Readable.fromWeb(upstream.body), res, (err) => {
    if (err && !res.destroyed) res.destroy();
  });
}

function wrapAsync(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error("[forwarder] " + req.method + " " + req.path + " failed: " + (err && err.message));
      sendJson(res, 500, { error: "Forwarder error" });
    });
  };
}

function buildForwarderRouter() {
  const router = express.Router();

  // CORS is handled globally by the public app – no need for a scoped middleware here.
  // But we DO need an explicit OPTIONS handler so Express doesn't 404 preflight requests
  // before they reach the global middleware.  (The global corsMiddleware already sends 200
  // for OPTIONS, but if the router has no matching OPTIONS route Express may short-circuit.)
  router.options(/^\/live\//, (req, res) => {
    // Headers already set by the global corsMiddleware; just end the response.
    res.sendStatus(200);
  });

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
 * Cloudflare Quick Tunnel Manager
 * ========================================================================== */

class QuickTunnelManager {
  constructor() {
    this.process = null;
    this.url = null;
    this.status = "stopped";
    this.lastError = null;
    this.startedAt = null;
  }

  async start() {
    if (this.process && this.url) return this.url;
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
        const proc = spawn("cloudflared", ["tunnel", "--url", "http://localhost:" + port], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        this.process = proc;
        this.startedAt = new Date();

        const handleOutput = (chunk) => {
          const text = chunk.toString();
          const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (match) {
            this.url = match[0];
            this.status = "running";
            console.log("[tunnel] Active Cloudflare Quick Tunnel:", this.url);
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve(this.url);
            }
          }
        };

        proc.stdout.on("data", handleOutput);
        proc.stderr.on("data", handleOutput);

        proc.on("error", (err) => {
          console.warn("[tunnel] cloudflared error:", err.message);
          this.status = "error";
          this.lastError = err.message;
          this.process = null;
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            reject(err);
          }
        });

        proc.on("exit", (code) => {
          console.log("[tunnel] cloudflared exited with code " + code);
          this.status = "stopped";
          this.process = null;
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            reject(new Error("cloudflared exited with code " + code));
          }
        });
      } catch (err) {
        this.status = "error";
        this.lastError = err.message;
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    });
  }

  async stop() {
    if (this.process) {
      try {
        this.process.kill("SIGTERM");
      } catch (e) {
        /* ignore */
      }
      this.process = null;
    }
    this.status = "stopped";
  }

  async restart() {
    await this.stop();
    await sleep(1000);
    return this.start();
  }

  getStatus() {
    return {
      status: this.status,
      url: this.url,
      publicStreamBaseUrl: CONFIG.publicStreamBaseUrl || null,
      uptimeSec: this.startedAt && this.status === "running" ? Math.round((Date.now() - this.startedAt.getTime()) / 1000) : 0,
      lastError: this.lastError,
      running: Boolean(this.process && this.status === "running"),
    };
  }
}

const tunnelManager = new QuickTunnelManager();

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
  return Object.assign({}, ev, {
    forwarderPath: forwarderPath(ev),
    localForwarderUrl: localForwarderBase() + forwarderPath(ev),
    cloudPrimaryUrl: cloudPrimaryUrl(ev),
    origin: originState.get(ev.id) || null,
    cloudHealth: cloudState.get(ev.id) || null,
  });
}

function buildApiRouter() {
  const api = express.Router();

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
        useForwarder: value.useForwarder !== undefined ? value.useForwarder : true,
        headers: value.headers || {},
        priorityOrder: store.events.length + 1,
        createdAt: now,
        updatedAt: now,
      };
      store.events.push(ev);
      store.normalizeOrder();
      await store.save();
      // Auto-sync to MongoDB Atlas in background
      if (CONFIG.mongoUri) {
        syncToCloud({ mirror: true }).catch((e) => console.warn("[auto-sync] create sync failed: " + e.message));
      }
      res.status(201).json({ event: viewOf(ev) });
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
      delete value.streamId; // immutable: the public URL must keep working
      if (value.primaryStreamUrl && (value.primaryStreamUrl.includes(":5000/live/") || value.primaryStreamUrl.includes("localhost:5000") || value.primaryStreamUrl.includes("127.0.0.1:5000"))) {
        value.primaryStreamUrl = value.primaryStreamUrl.replace(":5000", ":5001");
      }
      Object.assign(ev, value, { updatedAt: new Date().toISOString() });
      if (value.primaryStreamUrl || value.headers) originState.delete(ev.id);
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
    res.type("html").send(ADMIN_HTML);
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
 * Embedded admin UI
 * (String.raw keeps backslashes verbatim; the client code below deliberately
 *  avoids backticks and dollar-brace sequences so it can live in this literal.)
 * ========================================================================== */

const ADMIN_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SoluPlay • Origin Control Server</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #090d16;
    --surface: #0f172a;
    --surface-hover: #172136;
    --surface-glass: rgba(15, 23, 42, 0.85);
    --border: #1e293b;
    --border-subtle: #192336;
    --text: #f1f5f9;
    --text-muted: #94a3b8;
    --text-faint: #64748b;
    --primary: #3b82f6;
    --primary-glow: rgba(59, 130, 246, 0.25);
    --emerald: #10b981;
    --emerald-glow: rgba(16, 185, 129, 0.2);
    --amber: #f59e0b;
    --rose: #f43f5e;
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 16px;
    --font-sans: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
    --font-mono: 'JetBrains Mono', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }

  /* ---------- Top Navigation ---------- */
  header {
    background: var(--surface-glass);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 40;
    padding: 12px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .logo-icon {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: linear-gradient(135deg, #10b981, #3b82f6);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    box-shadow: 0 4px 12px var(--primary-glow);
  }
  .brand-title {
    font-size: 16px;
    font-weight: 800;
    letter-spacing: -0.3px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .brand-title span.badge {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 20px;
    background: #1e293b;
    color: var(--text-muted);
    border: 1px solid var(--border);
  }

  .nav-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  /* ---------- Buttons ---------- */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    padding: 8px 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }
  .btn:hover:not(:disabled) {
    background: var(--surface-hover);
    border-color: #334155;
    transform: translateY(-1px);
  }
  .btn:active:not(:disabled) {
    transform: translateY(0);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-primary {
    background: linear-gradient(135deg, #2563eb, #3b82f6);
    border-color: #3b82f6;
    color: #ffffff;
    box-shadow: 0 4px 14px var(--primary-glow);
  }
  .btn-primary:hover:not(:disabled) {
    background: linear-gradient(135deg, #1d4ed8, #2563eb);
    border-color: #60a5fa;
  }
  .btn-emerald {
    background: linear-gradient(135deg, #059669, #10b981);
    border-color: #10b981;
    color: #ffffff;
    box-shadow: 0 4px 14px var(--emerald-glow);
  }
  .btn-emerald:hover:not(:disabled) {
    background: linear-gradient(135deg, #047857, #059669);
  }
  .btn-danger {
    color: #f87171;
    border-color: #7f1d1d;
    background: rgba(127, 29, 29, 0.15);
  }
  .btn-danger:hover:not(:disabled) {
    background: rgba(127, 29, 29, 0.35);
    border-color: #b91c1c;
    color: #fca5a5;
  }
  .btn-sm {
    padding: 5px 10px;
    font-size: 12px;
  }

  /* ---------- Layout Container ---------- */
  .container {
    max-width: 1160px;
    margin: 0 auto;
    padding: 24px 20px 80px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  /* ---------- Minimal Status Grid ---------- */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 14px;
  }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 14px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    transition: border-color 0.15s ease;
  }
  .stat-card:hover {
    border-color: #334155;
  }
  .stat-icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: #1e293b;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    flex-shrink: 0;
  }
  .stat-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .stat-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-faint);
  }
  .stat-value {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* ---------- Stream Domain Bar (Minimal & Clean) ---------- */
  .domain-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .domain-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .domain-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .domain-input-group {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .domain-input {
    flex: 1;
    min-width: 280px;
    background: #090d16;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    font-family: var(--font-mono);
    font-size: 13px;
    color: #38bdf8;
    outline: none;
    transition: border-color 0.15s ease;
  }
  .domain-input:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 2px var(--primary-glow);
  }

  /* ---------- Section Header ---------- */
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 6px;
  }
  .section-title {
    font-size: 17px;
    font-weight: 800;
    letter-spacing: -0.3px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* ---------- Event Cards List ---------- */
  .cards-list {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .event-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    transition: all 0.2s ease;
    position: relative;
  }
  .event-card:hover {
    border-color: #334155;
    background: #111a2f;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
  }
  .event-card.dragging {
    opacity: 0.4;
  }
  .event-card.dragover {
    border-color: var(--primary);
    box-shadow: 0 0 0 2px var(--primary-glow);
  }

  /* Card Top Row */
  .card-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 14px;
    flex-wrap: wrap;
  }
  .card-main-info {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .card-rank {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: #1e293b;
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 800;
    color: var(--primary);
    cursor: grab;
  }
  .card-title {
    font-size: 16px;
    font-weight: 700;
    color: #ffffff;
    letter-spacing: -0.2px;
  }
  .card-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  /* Badges & Chips */
  .badge-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    border-radius: 20px;
    font-size: 11.5px;
    font-weight: 600;
    background: #1e293b;
    color: var(--text-muted);
    border: 1px solid var(--border);
  }
  .badge-chip.live {
    background: rgba(239, 68, 68, 0.15);
    border-color: rgba(239, 68, 68, 0.35);
    color: #fca5a5;
  }
  .badge-chip.scheduled {
    background: rgba(59, 130, 246, 0.15);
    border-color: rgba(59, 130, 246, 0.35);
    color: #93c5fd;
  }
  .badge-chip.ended {
    background: #1e293b;
    border-color: #334155;
    color: var(--text-faint);
  }
  .badge-chip.online {
    background: rgba(16, 185, 129, 0.15);
    border-color: rgba(16, 185, 129, 0.35);
    color: #6ee7b7;
  }
  .badge-chip.offline {
    background: rgba(244, 63, 94, 0.15);
    border-color: rgba(244, 63, 94, 0.35);
    color: #fda4af;
  }

  .pulse-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
  }
  .pulse-dot.live {
    background: #ef4444;
    box-shadow: 0 0 8px #ef4444;
  }
  .pulse-dot.online {
    background: #10b981;
    box-shadow: 0 0 6px #10b981;
  }
  .pulse-dot.offline {
    background: #f43f5e;
    box-shadow: 0 0 6px #f43f5e;
  }

  /* Card Middle Stream Box */
  .stream-box {
    background: #090d16;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: all 0.2s ease;
  }
  .stream-box.stream-box-alert {
    border-color: rgba(239, 68, 68, 0.6);
    background: rgba(239, 68, 68, 0.06);
    box-shadow: 0 0 12px rgba(239, 68, 68, 0.15);
  }
  .stream-box-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .stream-url-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .stream-label {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .stream-url-text {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: #38bdf8;
    word-break: break-all;
  }
  .stream-encoder-text {
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .stream-alert-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 12px;
    border-radius: 6px;
    background: rgba(239, 68, 68, 0.16);
    border: 1px solid rgba(239, 68, 68, 0.35);
    color: #fca5a5;
    font-size: 12px;
    font-weight: 600;
    flex-wrap: wrap;
  }

  /* Card Bottom Actions */
  .card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding-top: 4px;
  }
  .card-time {
    font-size: 12.5px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .card-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  /* Empty State */
  .empty-state {
    text-align: center;
    padding: 60px 20px;
    background: var(--surface);
    border: 1px dashed var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  .empty-icon {
    font-size: 36px;
  }
  .empty-text {
    color: var(--text-muted);
    font-size: 14px;
  }

  /* ---------- Modal Dialog ---------- */
  dialog {
    background: var(--surface);
    color: var(--text);
    border: 1px solid #334155;
    border-radius: var(--radius-lg);
    padding: 0;
    width: min(680px, 94vw);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
    margin: auto;
  }
  dialog::backdrop {
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(4px);
  }
  .dialog-header {
    padding: 18px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .dialog-header h2 {
    font-size: 17px;
    font-weight: 800;
  }
  form {
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .form-group label {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .form-group label span.hint {
    font-size: 11px;
    font-weight: 400;
    text-transform: none;
    color: var(--text-faint);
  }
  .form-row-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  input, select, textarea {
    font-family: inherit;
    font-size: 13.5px;
    color: var(--text);
    background: #090d16;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 9px 12px;
    width: 100%;
    outline: none;
    transition: border-color 0.15s ease;
  }
  input:focus, select:focus, textarea:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 2px var(--primary-glow);
  }
  textarea {
    min-height: 64px;
    resize: vertical;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .check-label {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    user-select: none;
    padding: 4px 0;
  }
  .check-label input[type="checkbox"] {
    width: 18px;
    height: 18px;
    accent-color: var(--primary);
    cursor: pointer;
  }
  .dialog-footer {
    padding: 16px 24px;
    border-top: 1px solid var(--border);
    background: rgba(9, 13, 22, 0.4);
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
  }
  #formError {
    color: #fca5a5;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: var(--radius-sm);
    padding: 10px 14px;
    font-size: 12.5px;
    white-space: pre-line;
  }

  /* ---------- Toast Notifications ---------- */
  #toasts {
    position: fixed;
    right: 20px;
    bottom: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 99;
  }
  .toast {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 4px solid var(--primary);
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    max-width: 400px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    font-size: 13px;
    animation: slideIn 0.2s ease-out;
  }
  .toast.success { border-left-color: var(--emerald); }
  .toast.error { border-left-color: var(--rose); }
  @keyframes slideIn {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  @media (max-width: 680px) {
    .form-row-2 { grid-template-columns: 1fr; }
    .card-top { flex-direction: column; }
    .card-footer { flex-direction: column; align-items: flex-start; }
  }
</style>
</head>
<body>

<!-- Header -->
<header>
  <div class="brand">
    <div class="logo-icon">📡</div>
    <div>
      <div class="brand-title">
        SoluPlay Origin Control
        <span id="nodeChip" class="badge">node: local</span>
      </div>
    </div>
  </div>
  <div class="nav-actions">
    <button id="btnProbe" class="btn btn-sm" title="Test Encoder and Cloud Stream health">⚡ Check All Streams</button>
    <button id="btnSync" class="btn btn-sm btn-emerald" title="Push cards to MongoDB Atlas">Cloud Sync</button>
    <button id="btnNew" class="btn btn-sm btn-primary">+ New Event</button>
  </div>
</header>

<!-- Main Container -->
<div class="container">

  <!-- Overview Stats -->
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-icon">☁️</div>
      <div class="stat-info">
        <span class="stat-label">Cloud Database</span>
        <span id="dbStat" class="stat-value">Connecting…</span>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">💓</div>
      <div class="stat-info">
        <span class="stat-label">Server Heartbeat</span>
        <span id="hbStat" class="stat-value">Waiting…</span>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">🌐</div>
      <div class="stat-info">
        <span class="stat-label">Forwarder Proxy</span>
        <span id="proxyStat" class="stat-value">Port 5001</span>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">🏆</div>
      <div class="stat-info">
        <span class="stat-label">Active Events</span>
        <span id="eventsStat" class="stat-value">0 Events</span>
      </div>
    </div>
  </div>

  <!-- Strike-Safe Domain Switcher -->
  <div class="domain-panel">
    <div class="domain-header">
      <div class="domain-title">
        <span class="pulse-dot online"></span>
        Active Stream Domain (Strike-Safe Proxy)
      </div>
      <div style="display: flex; gap: 8px; align-items: center;">
        <span id="tunnelStatusChip" class="badge-chip">checking tunnel…</span>
        <button id="btnNewTunnel" class="btn btn-sm btn-emerald" title="Generate fresh trycloudflare.com tunnel">⚡ New Quick Tunnel</button>
      </div>
    </div>
    <div class="domain-input-group">
      <input id="inDomainUrl" class="domain-input" placeholder="https://your-tunnel.trycloudflare.com">
      <button id="btnTestDomain" class="btn btn-sm" title="Test domain responsiveness and CORS">🔍 Test Domain</button>
      <button id="btnSaveDomain" class="btn btn-sm btn-primary" title="Apply domain to MongoDB Atlas">Save & Apply</button>
    </div>
  </div>

  <!-- Events Section -->
  <div class="section-header">
    <div class="section-title">
      <span>Event Cards</span>
      <span id="eventsCountBadge" class="badge-chip">0</span>
    </div>
  </div>

  <!-- Event Cards List -->
  <div id="cards" class="cards-list"></div>
  <div id="empty" class="empty-state" hidden>
    <div class="empty-icon">🏏</div>
    <div class="empty-text">No active sports event cards created yet.</div>
    <button id="btnEmptyNew" class="btn btn-primary btn-sm">+ Create First Event</button>
  </div>

</div>

<!-- Create / Edit Event Dialog -->
<dialog id="dlg">
  <div class="dialog-header">
    <h2 id="formTitle">New Event Card</h2>
    <button type="button" class="btn btn-sm" id="btnDialogClose">✕</button>
  </div>
  <form id="form" autocomplete="off">
    <div id="formError" hidden></div>
    <div class="form-group">
      <label>Match Title</label>
      <input id="fTitle" required maxlength="200" placeholder="e.g. Bangladesh vs Pakistan – 1st ODI">
    </div>
    <div class="form-row-2">
      <div class="form-group">
        <label>Sport Type</label>
        <input id="fSport" required maxlength="60" list="sports" placeholder="Cricket">
        <datalist id="sports">
          <option>Cricket</option>
          <option>Football</option>
          <option>Basketball</option>
          <option>Tennis</option>
          <option>Hockey</option>
          <option>Kabaddi</option>
          <option>Other</option>
        </datalist>
      </div>
      <div class="form-group">
        <label>Status</label>
        <select id="fStatus">
          <option value="scheduled">Scheduled</option>
          <option value="live">Live Now</option>
          <option value="ended">Ended</option>
        </select>
      </div>
    </div>
    <div class="form-row-2">
      <div class="form-group">
        <label>Start Time</label>
        <input id="fStart" type="datetime-local" required>
      </div>
      <div class="form-group">
        <label>End Time</label>
        <input id="fEnd" type="datetime-local" required>
      </div>
    </div>
    <div class="form-group">
      <label>Primary HLS URL <span class="hint">(Local OBS / Encoder stream)</span></label>
      <input id="fPrimary" required type="url" placeholder="http://127.0.0.1:8080/live/stream.m3u8">
    </div>
    <div>
      <label class="check-label">
        <input id="fForward" type="checkbox" checked>
        Publish via Forwarder Proxy (Protects origin encoder and prevents direct stream exposure)
      </label>
    </div>
    <div class="form-group">
      <label>Backup Streams <span class="hint">(one URL per line)</span></label>
      <textarea id="fBackups" placeholder="https://cdn.example.com/backup1.m3u8&#10;https://cdn2.example.com/backup2.m3u8"></textarea>
    </div>
    <div class="form-row-2">
      <div class="form-group">
        <label>Custom Stream ID <span class="hint">(optional)</span></label>
        <input id="fStreamId" maxlength="64" placeholder="auto-generated">
      </div>
      <div class="form-group">
        <label>Custom Headers <span class="hint">(JSON, optional)</span></label>
        <textarea id="fHeaders" placeholder='{"Referer": "http://localhost/"}'></textarea>
      </div>
    </div>
    <div class="dialog-footer">
      <button type="button" id="btnCancel" class="btn">Cancel</button>
      <button type="submit" id="btnSave" class="btn btn-primary">Save Event</button>
    </div>
  </form>
</dialog>

<!-- Toasts Container -->
<div id="toasts"></div>

<script>
(function () {
  'use strict';

  var state = { events: [], status: null };
  var editingId = null;
  var dragId = null;

  function $(id) { return document.getElementById(id); }

  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (v === true) n.setAttribute(k, '');
        else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v);
      });
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function toast(msg, kind) {
    var t = el('div', { class: 'toast ' + (kind || ''), text: msg });
    $('toasts').appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'error' ? 6000 : 3000);
  }

  async function api(method, url, body) {
    var opts = { method: method, headers: { 'X-Admin-UI': '1' }, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var res = await fetch(url, opts);
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var err = new Error(data.error || ('HTTP ' + res.status));
      err.details = data.details;
      throw err;
    }
    return data;
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function toInputValue(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fromInputValue(v) { return v ? new Date(v).toISOString() : ''; }
  function fmt(iso) { return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
  function ago(iso) {
    if (!iso) return 'never';
    var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    return Math.round(s / 3600) + 'h ago';
  }

  function copy(text) {
    navigator.clipboard.writeText(text).then(
      function () { toast('Stream URL copied to clipboard!', 'success'); },
      function () { toast('Failed to copy', 'error'); }
    );
  }

  async function restartQuickTunnel() {
    var btn = $('btnNewTunnel');
    btn.disabled = true; btn.textContent = 'Generating…';
    toast('Spawning Cloudflare Quick Tunnel…', '');
    try {
      var res = await api('POST', '/api/tunnel/restart');
      $('inDomainUrl').value = res.url;
      toast('New tunnel active: ' + res.url, 'success');
      state.events = res.events;
      await refresh();
    } catch (err) {
      toast('Tunnel generation failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '⚡ New Quick Tunnel';
    }
  }

  function renderCard(ev, index) {
    var card = el('div', { class: 'event-card', draggable: 'true', 'data-id': ev.id });

    card.addEventListener('dragstart', function (e) {
      dragId = ev.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', ev.id);
    });
    card.addEventListener('dragend', function () {
      dragId = null;
      card.classList.remove('dragging');
      Array.prototype.forEach.call(document.querySelectorAll('.event-card.dragover'), function (n) { n.classList.remove('dragover'); });
    });
    card.addEventListener('dragover', function (e) { if (dragId && dragId !== ev.id) { e.preventDefault(); card.classList.add('dragover'); } });
    card.addEventListener('dragleave', function () { card.classList.remove('dragover'); });
    card.addEventListener('drop', function (e) {
      e.preventDefault();
      card.classList.remove('dragover');
      if (!dragId || dragId === ev.id) return;
      var ids = state.events.map(function (x) { return x.id; }).filter(function (id) { return id !== dragId; });
      ids.splice(ids.indexOf(ev.id), 0, dragId);
      reorder(ids);
    });

    var rank = el('div', { class: 'card-rank', title: 'Drag to reorder' }, ['#' + (index + 1)]);

    var statusClass = ev.status === 'live' ? 'live' : (ev.status === 'scheduled' ? 'scheduled' : 'ended');
    var statusText = ev.status === 'live' ? 'LIVE NOW' : ev.status.toUpperCase();
    var pulse = ev.status === 'live' ? el('span', { class: 'pulse-dot live' }) : null;

    // 1. Origin Encoder Signal
    var originBadge;
    if (!ev.origin) {
      originBadge = el('span', { class: 'badge-chip' }, ['Encoder Checking…']);
    } else if (ev.origin.online) {
      originBadge = el('span', { class: 'badge-chip online', title: 'Local encoder is active (' + ev.origin.latencyMs + 'ms)' }, [el('span', { class: 'pulse-dot online' }), 'Encoder Online (' + ev.origin.latencyMs + 'ms)']);
    } else {
      originBadge = el('span', { class: 'badge-chip offline', title: ev.origin.error || 'Encoder offline' }, [el('span', { class: 'pulse-dot offline' }), 'Encoder Offline']);
    }

    // 2. Cloud URL Signal
    var cloudBadge;
    var isCloudDead = false;
    if (!ev.useForwarder) {
      cloudBadge = el('span', { class: 'badge-chip' }, ['Direct (No Proxy)']);
    } else if (!ev.cloudHealth) {
      cloudBadge = el('span', { class: 'badge-chip' }, ['Cloud URL Checking…']);
    } else if (ev.cloudHealth.online) {
      cloudBadge = el('span', { class: 'badge-chip online', title: 'Public stream URL is LIVE on Cloudflare edge (' + ev.cloudHealth.latencyMs + 'ms)' }, [el('span', { class: 'pulse-dot online' }), 'Cloud URL LIVE (' + ev.cloudHealth.latencyMs + 'ms)']);
    } else {
      isCloudDead = true;
      cloudBadge = el('span', { class: 'badge-chip offline', title: ev.cloudHealth.error || 'Cloud URL Offline' }, [el('span', { class: 'pulse-dot offline' }), '🔴 Cloud URL OFFLINE']);
    }

    var top = el('div', { class: 'card-top' }, [
      el('div', { class: 'card-main-info' }, [
        rank,
        el('span', { class: 'card-title', text: ev.matchTitle }),
        el('div', { class: 'card-badges' }, [
          el('span', { class: 'badge-chip', text: '🏆 ' + ev.sportType }),
          el('span', { class: 'badge-chip ' + statusClass }, [pulse, statusText]),
          originBadge,
          cloudBadge
        ])
      ]),
      el('div', { class: 'card-actions' }, [
        el('button', { class: 'btn btn-sm', text: '✏️ Edit', onclick: function () { openForm(ev); } }),
        el('button', { class: 'btn btn-sm btn-danger', text: '🗑️ Delete', onclick: function () { remove(ev); } })
      ])
    ]);

    var streamUrl = ev.useForwarder ? ev.cloudPrimaryUrl : ev.primaryStreamUrl;
    var streamBoxClass = 'stream-box' + (isCloudDead ? ' stream-box-alert' : '');

    var streamBoxChildren = [
      el('div', { class: 'stream-box-main' }, [
        el('div', { class: 'stream-url-info' }, [
          el('span', { class: 'stream-label', text: ev.useForwarder ? '📡 Cloud Proxy Stream URL (HLS)' : 'Direct Encoder Stream URL' }),
          el('span', { class: 'stream-url-text', text: streamUrl || 'Generating URL…' }),
          ev.useForwarder ? el('span', { class: 'stream-encoder-text', text: 'Origin Source: ' + ev.primaryStreamUrl }) : null
        ]),
        isCloudDead ? el('div', { style: 'display: flex; gap: 6px;' }, [
          el('button', { class: 'btn btn-sm btn-emerald', text: '⚡ Fix Tunnel', onclick: function () { restartQuickTunnel(); } })
        ]) : null
      ])
    ];

    if (isCloudDead) {
      streamBoxChildren.push(
        el('div', { class: 'stream-alert-banner' }, [
          el('span', { text: '⚠️ Cloud stream is UNREACHABLE (Tunnel Disconnected/Expired)! Viewers cannot watch.' }),
          el('button', { class: 'btn btn-sm btn-emerald', text: '⚡ 1-Click Fix Quick Tunnel', onclick: function () { restartQuickTunnel(); } })
        ])
      );
    }

    var streamBox = el('div', { class: streamBoxClass }, streamBoxChildren);

    var footer = el('div', { class: 'card-footer' }, [
      el('div', { class: 'card-time' }, [
        '🕒 ' + fmt(ev.startTime) + '  →  ' + fmt(ev.endTime)
      ]),
      el('div', { class: 'card-actions' }, [
        el('button', { class: 'btn btn-sm', text: '⬆️', title: 'Move up', disabled: index === 0, onclick: function () { move(index, -1); } }),
        el('button', { class: 'btn btn-sm', text: '⬇️', title: 'Move down', disabled: index === state.events.length - 1, onclick: function () { move(index, 1); } }),
        ev.status !== 'live' ? el('button', { class: 'btn btn-sm btn-emerald', text: '🔴 Go Live', onclick: function () { quickStatus(ev, 'live'); } }) : null,
        ev.status !== 'ended' ? el('button', { class: 'btn btn-sm', text: '⏹️ End', onclick: function () { quickStatus(ev, 'ended'); } }) : null
      ])
    ]);

    card.appendChild(top);
    card.appendChild(streamBox);
    card.appendChild(footer);
    return card;
  }

  function renderCards() {
    var box = $('cards');
    box.textContent = '';
    state.events.forEach(function (ev, i) { box.appendChild(renderCard(ev, i)); });
    $('empty').hidden = state.events.length > 0;
    $('eventsCountBadge').textContent = state.events.length;
    $('eventsStat').textContent = state.events.length + ' Event' + (state.events.length === 1 ? '' : 's');
  }

  function renderStatus() {
    var s = state.status;
    if (!s) return;
    $('nodeChip').textContent = 'node: ' + s.nodeId;
    var c = s.cloud;
    $('dbStat').textContent = c.mongoConfigured ? '🟢 Connected' : '🔴 Not Configured';
    var hb = s.heartbeat;
    $('hbStat').textContent = hb.ok ? ('🟢 Live (' + ago(hb.lastAt) + ')') : (hb.error ? '🔴 Error' : '🟡 Initializing');
    $('proxyStat').textContent = 'Port ' + (s.publicPort || 5001);
  }

  async function refresh() {
    try {
      var results = await Promise.all([api('GET', '/api/events'), api('GET', '/api/status')]);
      state.events = results[0].events;
      state.status = results[1];
      renderCards();
      renderStatus();
    } catch (e) {
      toast('Refresh failed: ' + e.message, 'error');
    }
  }

  async function reorder(ids) {
    try {
      var data = await api('POST', '/api/events/reorder', { ids: ids });
      state.events = data.events;
      renderCards();
    } catch (e) { toast(e.message, 'error'); }
  }

  function move(index, delta) {
    var ids = state.events.map(function (x) { return x.id; });
    var j = index + delta;
    if (j < 0 || j >= ids.length) return;
    var tmp = ids[index]; ids[index] = ids[j]; ids[j] = tmp;
    reorder(ids);
  }

  async function quickStatus(ev, status) {
    try {
      await api('PUT', '/api/events/' + encodeURIComponent(ev.id), { status: status });
      toast('"' + ev.matchTitle + '" status set to ' + status.toUpperCase(), 'success');
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function remove(ev) {
    if (!window.confirm('Delete "' + ev.matchTitle + '"?\n\nThis will remove it from the cloud database on next sync.')) return;
    try {
      await api('DELETE', '/api/events/' + encodeURIComponent(ev.id));
      toast('Event deleted', 'success');
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  function showFormError(err) {
    var box = $('formError');
    var lines = [err.message];
    if (err.details && err.details.length) lines = err.details;
    box.textContent = lines.join('\n');
    box.hidden = false;
  }

  function openForm(ev) {
    editingId = ev ? ev.id : null;
    $('formTitle').textContent = ev ? 'Edit Event Card' : 'New Event Card';
    $('formError').hidden = true;
    var now = new Date();
    now.setSeconds(0, 0);
    var later = new Date(now.getTime() + 3 * 3600 * 1000);
    $('fTitle').value = ev ? ev.matchTitle : '';
    $('fSport').value = ev ? ev.sportType : '';
    $('fStatus').value = ev ? ev.status : 'scheduled';
    $('fStart').value = ev ? toInputValue(ev.startTime) : toInputValue(now.toISOString());
    $('fEnd').value = ev ? toInputValue(ev.endTime) : toInputValue(later.toISOString());
    $('fPrimary').value = ev ? ev.primaryStreamUrl : '';
    $('fForward').checked = ev ? !!ev.useForwarder : true;
    $('fBackups').value = ev ? (ev.backupStreamUrls || []).join('\n') : '';
    $('fStreamId').value = ev ? ev.streamId : '';
    $('fStreamId').disabled = !!ev;
    $('fHeaders').value = ev && ev.headers && Object.keys(ev.headers).length ? JSON.stringify(ev.headers, null, 2) : '';
    $('dlg').showModal();
    $('fTitle').focus();
  }

  $('form').addEventListener('submit', async function (e) {
    e.preventDefault();
    $('formError').hidden = true;
    var payload = {
      matchTitle: $('fTitle').value,
      sportType: $('fSport').value,
      status: $('fStatus').value,
      startTime: fromInputValue($('fStart').value),
      endTime: fromInputValue($('fEnd').value),
      primaryStreamUrl: $('fPrimary').value,
      useForwarder: $('fForward').checked,
      backupStreamUrls: $('fBackups').value,
      headers: $('fHeaders').value
    };
    if (!editingId && $('fStreamId').value.trim()) payload.streamId = $('fStreamId').value;
    $('btnSave').disabled = true;
    try {
      if (editingId) await api('PUT', '/api/events/' + encodeURIComponent(editingId), payload);
      else await api('POST', '/api/events', payload);
      $('dlg').close();
      toast(editingId ? 'Event updated successfully' : 'Event created successfully', 'success');
      await refresh();
    } catch (err) {
      showFormError(err);
    } finally {
      $('btnSave').disabled = false;
    }
  });

  $('btnCancel').addEventListener('click', function () { $('dlg').close(); });
  $('btnDialogClose').addEventListener('click', function () { $('dlg').close(); });
  $('btnNew').addEventListener('click', function () { openForm(null); });
  $('btnEmptyNew').addEventListener('click', function () { openForm(null); });

  $('btnProbe').addEventListener('click', async function () {
    var b = $('btnProbe');
    b.disabled = true; b.textContent = 'Checking…';
    try {
      var data = await api('POST', '/api/probe');
      state.events = data.events;
      renderCards();
      toast('Checked ' + data.checked + ' stream(s) [Encoder & Cloud Live]', 'success');
    } catch (e) { toast(e.message, 'error'); }
    b.disabled = false; b.textContent = '⚡ Check All Streams';
  });

  $('btnSync').addEventListener('click', async function () {
    var b = $('btnSync');
    b.disabled = true; b.textContent = 'Syncing…';
    try {
      var data = await api('POST', '/api/sync', { mirror: true });
      var s = data.summary;
      state.events = data.events;
      toast('Cloud sync complete: ' + s.cards + ' card(s) active', 'success');
      await refresh();
    } catch (e) {
      toast('Sync failed: ' + e.message, 'error');
    }
    b.disabled = false; b.textContent = 'Cloud Sync';
  });

  $('btnSaveDomain').addEventListener('click', async function () {
    var url = $('inDomainUrl').value.trim();
    if (!url) { toast('Please enter a stream base URL', 'error'); return; }
    var btn = $('btnSaveDomain');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      var res = await api('POST', '/api/tunnel/set-domain', { url: url });
      toast('Stream domain updated in MongoDB Atlas!', 'success');
      state.events = res.events;
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Save & Apply';
    }
  });

  $('btnNewTunnel').addEventListener('click', async function () {
    var ok = window.confirm('Generate a fresh Cloudflare Quick Tunnel?\n\nThis will automatically launch a new tunnel, save the HTTPS URL to MongoDB Atlas, and update all stream players.');
    if (!ok) return;
    await restartQuickTunnel();
  });

  $('btnTestDomain').addEventListener('click', async function () {
    var url = $('inDomainUrl').value.trim();
    if (!url) { toast('Please enter a domain to test', 'error'); return; }
    var btn = $('btnTestDomain');
    btn.disabled = true; btn.textContent = 'Testing…';
    try {
      var res = await api('POST', '/api/tunnel/test', { url: url });
      if (res.ok) {
        toast('Domain online · HTTP ' + res.status + ' (' + res.latencyMs + 'ms)', 'success');
      } else {
        toast('Domain unreachable: ' + (res.error || ('HTTP ' + res.status)), 'error');
      }
    } catch (err) {
      toast('Test failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '🔍 Test Domain';
    }
  });

  async function updateTunnelChip() {
    try {
      var t = await api('GET', '/api/tunnel/status');
      var chip = $('tunnelStatusChip');
      if (t.running && t.url) {
        chip.className = 'badge-chip online';
        chip.textContent = 'Quick Tunnel Active (' + t.uptimeSec + 's)';
        if (!$('inDomainUrl').value) $('inDomainUrl').value = t.url;
      } else if (t.status === 'starting') {
        chip.className = 'badge-chip scheduled';
        chip.textContent = 'Tunnel Starting…';
      } else if (t.lastError) {
        chip.className = 'badge-chip offline';
        chip.textContent = 'Tunnel Error: ' + t.lastError.slice(0, 25);
      } else {
        chip.className = 'badge-chip';
        chip.textContent = 'Tunnel: External / Manual';
      }
      if (t.publicStreamBaseUrl && (!$('inDomainUrl').value || $('inDomainUrl').value === t.url)) {
        $('inDomainUrl').value = t.publicStreamBaseUrl;
      }
    } catch (e) {}
  }

  refresh();
  updateTunnelChip();
  setInterval(function () {
    if (!$('dlg').open) {
      refresh();
      updateTunnelChip();
    }
  }, 10000);
})();
</script>
</body>
</html>`;

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
  console.log("\n[" + signal + "] shutting down…");
  if (heartbeatTimer) clearInterval(heartbeatTimer);
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
  console.log("  Public base     " + (CONFIG.publicStreamBaseUrl || "not set (PUBLIC_STREAM_BASE_URL)"));
  console.log("  Cloud DB        " + (CONFIG.mongoUri ? redactUri(CONFIG.mongoUri) : "not set (MONGODB_URI)"));
  console.log("  Heartbeat       " + (heartbeatStrategies().length && CONFIG.autoHeartbeat ? "every " + CONFIG.heartbeatIntervalSec + "s via " + heartbeatStrategies().join(" → ") : "off"));
  console.log("  Events          " + store.events.length + " loaded from " + CONFIG.dataFile);
  console.log("");

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
}

process.on("unhandledRejection", (reason) => {
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
  rewritePlaylist,
  forward,
  EventStore,
  cloudPrimaryUrl,
  sanitizeHeaderMap,
  _internals: { store, CONFIG, originState, probeOrigin },
};
