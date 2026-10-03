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
 * Origin health probing
 * ========================================================================== */

const originState = new Map(); // event.id -> { online, checkedAt, latencyMs, httpStatus, error }

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
  // If the event specifies a Referer in its headers, it's already merged above.
  // If no Referer was specified in event config, set a sensible default using the primary URL's origin.
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

async function probeAll() {
  const live = store.events.filter((e) => e.status !== "ended");
  const known = new Set(store.events.map((e) => e.id));
  Array.from(originState.keys()).forEach((id) => {
    if (!known.has(id)) originState.delete(id);
  });
  store.events.filter((e) => e.status === "ended").forEach((e) => originState.delete(e.id));
  await Promise.all(live.map((e) => probeOrigin(e)));
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
  });
}

function buildApiRouter() {
  const api = express.Router();

  api.get("/events", (req, res) => {
    res.json({ events: store.events.map(viewOf) });
  });

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
<title>Local Stream Control</title>
<style>
  :root {
    --bg: #0d1117; --panel: #151b23; --panel2: #1c2430; --line: #2a3441; --text: #e6edf3; --muted: #8b98a8;
    --accent: #3b82f6; --accent2: #22c55e; --warn: #f59e0b; --danger: #ef4444; --radius: 12px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 5; }
  h1 { margin: 0; font-size: 18px; letter-spacing: .2px; }
  .brand { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button { font: inherit; color: var(--text); background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; cursor: pointer; transition: filter .15s, background .15s; }
  button:hover:not(:disabled) { filter: brightness(1.25); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.accent { background: var(--accent2); border-color: var(--accent2); color: #04210e; font-weight: 600; }
  button.danger { color: var(--danger); }
  button.small { padding: 4px 9px; font-size: 12.5px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel2); font-size: 12px; color: var(--muted); white-space: nowrap; }
  .chip.live { color: #fecaca; border-color: #7f1d1d; background: #3b1212; }
  .chip.scheduled { color: #bfdbfe; border-color: #1e3a8a; background: #11213f; }
  .chip.ended { color: #cbd5e1; border-color: #475569; background: #1e293b; }
  .chip.ok { color: #bbf7d0; border-color: #166534; background: #0f2a1a; }
  .chip.bad { color: #fecaca; border-color: #7f1d1d; background: #2a1212; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #64748b; display: inline-block; }
  .dot.ok { background: var(--accent2); box-shadow: 0 0 6px var(--accent2); }
  .dot.bad { background: var(--danger); }
  #statusBar { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 24px; border-bottom: 1px solid var(--line); }
  main { padding: 20px 24px 80px; max-width: 1100px; margin: 0 auto; }
  .card { display: grid; grid-template-columns: 34px 1fr auto; gap: 14px; align-items: start; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; margin-bottom: 12px; }
  .card.dragover { outline: 2px dashed var(--accent); outline-offset: 2px; }
  .card.dragging { opacity: .45; }
  .grip { cursor: grab; color: var(--muted); user-select: none; text-align: center; font-size: 18px; line-height: 1; padding-top: 2px; }
  .rank { display: block; margin-top: 6px; font-weight: 700; color: var(--accent); font-size: 15px; }
  .card h3 { margin: 0 0 6px; font-size: 16px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 4px 0; }
  .muted { color: var(--muted); }
  .url { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: #a5b4c8; word-break: break-all; }
  .url b { color: var(--muted); font-weight: 600; font-family: system-ui, sans-serif; margin-right: 4px; }
  .side { display: flex; flex-direction: column; gap: 6px; align-items: stretch; min-width: 108px; }
  #empty { text-align: center; padding: 60px 10px; color: var(--muted); border: 1px dashed var(--line); border-radius: var(--radius); }
  #syncLog { margin-bottom: 16px; padding: 12px 16px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--panel); }
  #syncLog ul { margin: 6px 0 0 18px; padding: 0; color: var(--warn); }
  dialog { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 14px; padding: 0; width: min(720px, 94vw); }
  dialog::backdrop { background: rgba(0,0,0,.6); }
  form { padding: 20px 22px; display: grid; gap: 12px; }
  form h2 { margin: 0 0 4px; font-size: 17px; }
  label { display: grid; gap: 4px; font-weight: 600; font-size: 12.5px; color: var(--muted); }
  label span.hint { font-weight: 400; }
  input, select, textarea { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; width: 100%; }
  input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  input[type=checkbox] { width: auto; }
  textarea { min-height: 64px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .check { display: flex; gap: 8px; align-items: center; font-weight: 500; color: var(--text); }
  #formError { color: #fecaca; background: #2a1212; border: 1px solid #7f1d1d; border-radius: 8px; padding: 8px 10px; white-space: pre-line; }
  .formActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  #toasts { position: fixed; right: 18px; bottom: 18px; display: grid; gap: 8px; z-index: 50; }
  .toast { background: var(--panel2); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 8px; padding: 10px 14px; max-width: 380px; box-shadow: 0 6px 24px rgba(0,0,0,.4); }
  .toast.error { border-left-color: var(--danger); }
  .toast.success { border-left-color: var(--accent2); }
  @media (max-width: 640px) { .card { grid-template-columns: 26px 1fr; } .side { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; } .grid2 { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <div class="brand"><h1>Local Stream Control</h1><span id="nodeChip" class="chip">node</span></div>
  <div class="actions">
    <button id="btnProbe" title="Test every local encoder URL now">Check origins</button>
    <button id="btnNew" class="primary">+ New event</button>
    <button id="btnSync" class="accent" title="Push all cards to the cloud MongoDB">Sync to Cloud</button>
  </div>
</header>
<section id="domainBar" style="background: var(--panel2); border-bottom: 1px solid var(--line); padding: 12px 24px;">
  <div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between;">
    <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
      <span style="font-weight: 700; color: #fff; display: flex; align-items: center; gap: 6px;">
        <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--accent2); box-shadow: 0 0 6px var(--accent2);"></span>
        Strike-Safe Stream Domain:
      </span>
      <input id="inDomainUrl" style="width: min(440px, 80vw); font-family: ui-monospace, monospace; font-size: 13px; padding: 6px 10px; border-radius: 6px;" placeholder="https://your-domain.trycloudflare.com">
      <button id="btnSaveDomain" class="primary small" title="Save domain to MongoDB Atlas (instantly updates all players across Vercel)">Save & Apply</button>
      <button id="btnTestDomain" class="small" title="Test if this domain is reachable and passing CORS">🔍 Test Domain</button>
    </div>
    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
      <button id="btnNewTunnel" class="accent small" title="Spawn a fresh Cloudflare Quick Tunnel (trycloudflare.com) and push to MongoDB">⚡ New Quick Tunnel</button>
      <span id="tunnelStatusChip" class="chip">tunnel: checking…</span>
    </div>
  </div>
</section>
<section id="statusBar"></section>
<main>
  <div id="syncLog" hidden></div>
  <div id="cards"></div>
  <div id="empty" hidden>No event cards yet. Click <b>+ New event</b> to add the first one.</div>
</main>

<dialog id="dlg">
  <form id="form" autocomplete="off">
    <h2 id="formTitle">New event</h2>
    <div id="formError" hidden></div>
    <label>Match title
      <input id="fTitle" required maxlength="200" placeholder="e.g. Bangladesh vs India – 1st ODI">
    </label>
    <div class="grid2">
      <label>Sport type
        <input id="fSport" required maxlength="60" list="sports" placeholder="Cricket">
        <datalist id="sports"><option>Cricket</option><option>Football</option><option>Basketball</option><option>Tennis</option><option>Hockey</option><option>Kabaddi</option><option>Baseball</option><option>Rugby</option><option>Volleyball</option><option>Other</option></datalist>
      </label>
      <label>Status
        <select id="fStatus"><option value="scheduled">Scheduled</option><option value="live">Live</option><option value="ended">Ended</option></select>
      </label>
    </div>
    <div class="grid2">
      <label>Start time <input id="fStart" type="datetime-local" required></label>
      <label>End time <input id="fEnd" type="datetime-local" required></label>
    </div>
    <label>Primary HLS URL (local encoder)
      <input id="fPrimary" required type="url" placeholder="http://127.0.0.1:8080/hls/match1.m3u8">
    </label>
    <label class="check"><input id="fForward" type="checkbox" checked> Publish through this PC's forwarder
      <span class="hint muted">(recommended – viewers get https://your-domain/live/&lt;streamId&gt;.m3u8 instead of your private encoder URL)</span>
    </label>
    <label>Backup URLs <span class="hint">one per line, tried in order if the primary fails</span>
      <textarea id="fBackups" placeholder="https://cdn.example.com/backup1.m3u8&#10;https://cdn2.example.com/backup2.m3u8"></textarea>
    </label>
    <div class="grid2">
      <label>Stream ID <span class="hint">optional, set once (a-z 0-9 - _)</span>
        <input id="fStreamId" maxlength="64" placeholder="auto-generated">
      </label>
      <label>Extra origin headers <span class="hint">JSON, optional</span>
        <textarea id="fHeaders" placeholder='{"Referer": "http://localhost/"}'></textarea>
      </label>
    </div>
    <div class="formActions">
      <button type="button" id="btnCancel">Cancel</button>
      <button type="submit" id="btnSave" class="primary">Save</button>
    </div>
  </form>
</dialog>
<div id="toasts"></div>

<script>
(function () {
  'use strict';

  var state = { events: [], status: null };
  var editingId = null;
  var dragId = null;

  function $(id) { return document.getElementById(id); }

  /* ---------- tiny DOM helper (text is always set via textContent => no XSS) ---------- */
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
    setTimeout(function () { t.remove(); }, kind === 'error' ? 8000 : 3500);
  }

  async function api(method, url, body) {
    var opts = { method: method, headers: { 'X-Admin-UI': '1' }, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var res = await fetch(url, opts);
    var data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      var err = new Error(data.error || ('HTTP ' + res.status));
      err.details = data.details;
      throw err;
    }
    return data;
  }

  /* ---------- date helpers ---------- */
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

  /* ---------- rendering ---------- */
  function copy(text) {
    navigator.clipboard.writeText(text).then(
      function () { toast('Copied', 'success'); },
      function () { toast('Copy failed – select the text manually', 'error'); }
    );
  }

  function originChip(o) {
    if (!o) return el('span', { class: 'chip' }, [el('span', { class: 'dot' }), 'Origin not checked']);
    if (o.online) return el('span', { class: 'chip ok' }, [el('span', { class: 'dot ok' }), 'Origin online · ' + o.latencyMs + ' ms']);
    return el('span', { class: 'chip bad', title: 'Checked ' + ago(o.checkedAt) }, [el('span', { class: 'dot bad' }), 'Origin offline · ' + (o.error || 'unreachable')]);
  }

  function urlLine(label, value) {
    return el('div', { class: 'row' }, [
      el('span', { class: 'url' }, [el('b', { text: label }), value]),
      el('button', { class: 'small', text: 'Copy', onclick: function () { copy(value); } })
    ]);
  }

  function renderCard(ev, index) {
    var card = el('div', { class: 'card', draggable: 'true', 'data-id': ev.id });

    card.addEventListener('dragstart', function (e) {
      dragId = ev.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', ev.id);
    });
    card.addEventListener('dragend', function () {
      dragId = null;
      card.classList.remove('dragging');
      Array.prototype.forEach.call(document.querySelectorAll('.card.dragover'), function (n) { n.classList.remove('dragover'); });
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

    var grip = el('div', { class: 'grip', title: 'Drag to reorder' }, ['⋮⋮', el('span', { class: 'rank', text: '#' + (index + 1) })]);

    var backups = (ev.backupStreamUrls || []).length;
    var body = el('div', {}, [
      el('h3', { text: ev.matchTitle }),
      el('div', { class: 'row' }, [
        el('span', { class: 'chip', text: ev.sportType }),
        el('span', { class: 'chip ' + ev.status, text: ev.status.toUpperCase() }),
        originChip(ev.origin),
        el('span', { class: 'chip', text: ev.useForwarder ? 'via forwarder' : 'direct URL' }),
        el('span', { class: 'chip', text: backups + ' backup' + (backups === 1 ? '' : 's') })
      ]),
      el('div', { class: 'muted', text: fmt(ev.startTime) + '  →  ' + fmt(ev.endTime) }),
      urlLine('Encoder: ', ev.primaryStreamUrl),
      ev.useForwarder ? urlLine('Cloud URL: ', ev.cloudPrimaryUrl) : null,
      ev.useForwarder ? urlLine('Local test: ', ev.localForwarderUrl) : null
    ]);

    var side = el('div', { class: 'side' }, [
      el('div', { class: 'row' }, [
        el('button', { class: 'small', text: '↑', title: 'Move up', disabled: index === 0, onclick: function () { move(index, -1); } }),
        el('button', { class: 'small', text: '↓', title: 'Move down', disabled: index === state.events.length - 1, onclick: function () { move(index, 1); } })
      ]),
      ev.status !== 'live' ? el('button', { class: 'small', text: 'Go live', onclick: function () { quickStatus(ev, 'live'); } }) : null,
      ev.status !== 'ended' ? el('button', { class: 'small', text: 'End', onclick: function () { quickStatus(ev, 'ended'); } }) : null,
      el('button', { class: 'small', text: 'Edit', onclick: function () { openForm(ev); } }),
      el('button', { class: 'small danger', text: 'Delete', onclick: function () { remove(ev); } })
    ]);

    card.appendChild(grip);
    card.appendChild(body);
    card.appendChild(side);
    return card;
  }

  function renderCards() {
    var box = $('cards');
    box.textContent = '';
    state.events.forEach(function (ev, i) { box.appendChild(renderCard(ev, i)); });
    $('empty').hidden = state.events.length > 0;
  }

  function renderStatus() {
    var s = state.status;
    var bar = $('statusBar');
    bar.textContent = '';
    if (!s) return;
    $('nodeChip').textContent = 'node: ' + s.nodeId;
    var c = s.cloud;
    bar.appendChild(el('span', { class: 'chip ' + (c.mongoConfigured ? 'ok' : 'bad') }, [el('span', { class: 'dot ' + (c.mongoConfigured ? 'ok' : 'bad') }), c.mongoConfigured ? ('Cloud DB: ' + c.mongoTarget + ' (' + c.mongoState + ')') : 'Cloud DB: MONGODB_URI not set']));
    var hb = s.heartbeat;
    var hbText = !c.heartbeatConfigured ? 'Heartbeat: not configured' : (hb.ok ? ('Heartbeat OK via ' + hb.via + ' · ' + ago(hb.lastAt)) : (hb.lastAt || hb.error ? ('Heartbeat failing: ' + (hb.error || '?')) : 'Heartbeat: waiting for first ping…'));
    bar.appendChild(el('span', { class: 'chip ' + (hb.ok ? 'ok' : (c.heartbeatConfigured && hb.error ? 'bad' : '')) }, [el('span', { class: 'dot ' + (hb.ok ? 'ok' : (hb.error ? 'bad' : '')) }), hbText]));
    bar.appendChild(el('span', { class: 'chip', text: 'Public base: ' + (s.publicStreamBaseUrl || 'not set (PUBLIC_STREAM_BASE_URL)') }));
    bar.appendChild(el('span', { class: 'chip', text: 'Forwarder port: ' + (s.publicPort || 'admin port') }));

    var log = $('syncLog');
    if (s.lastSync) {
      var l = s.lastSync;
      log.hidden = false;
      log.textContent = '';
      log.appendChild(el('div', {}, [
        el('b', { text: 'Last cloud sync ' }),
        el('span', { class: 'muted', text: ago(l.at) + ' · ' + l.cards + ' card(s) · +' + l.created + ' new · ' + l.updated + ' updated · ' + l.removed + ' removed · ' + l.durationMs + ' ms' })
      ]));
      if (l.warnings && l.warnings.length) {
        var ul = el('ul');
        l.warnings.forEach(function (w) { ul.appendChild(el('li', { text: w })); });
        log.appendChild(ul);
      }
    }
  }

  /* ---------- data actions ---------- */
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
      toast('"' + ev.matchTitle + '" is now ' + status, 'success');
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function remove(ev) {
    if (!window.confirm('Delete "' + ev.matchTitle + '"?\n\nIt is removed from the cloud on the next sync.')) return;
    try {
      await api('DELETE', '/api/events/' + encodeURIComponent(ev.id));
      toast('Deleted', 'success');
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ---------- form ---------- */
  function showFormError(err) {
    var box = $('formError');
    var lines = [err.message];
    if (err.details && err.details.length) lines = err.details;
    box.textContent = lines.join('\n');
    box.hidden = false;
  }

  function openForm(ev) {
    editingId = ev ? ev.id : null;
    $('formTitle').textContent = ev ? 'Edit event' : 'New event';
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
      toast(editingId ? 'Event updated' : 'Event created', 'success');
      await refresh();
    } catch (err) {
      showFormError(err);
    } finally {
      $('btnSave').disabled = false;
    }
  });

  $('btnCancel').addEventListener('click', function () { $('dlg').close(); });
  $('btnNew').addEventListener('click', function () { openForm(null); });

  $('btnProbe').addEventListener('click', async function () {
    var b = $('btnProbe');
    b.disabled = true; b.textContent = 'Checking…';
    try {
      var data = await api('POST', '/api/probe');
      state.events = data.events;
      renderCards();
      toast('Checked ' + data.checked + ' origin(s)', 'success');
    } catch (e) { toast(e.message, 'error'); }
    b.disabled = false; b.textContent = 'Check origins';
  });

  $('btnSync').addEventListener('click', async function () {
    var n = state.events.length;
    var ok = window.confirm(
      'Sync ' + n + ' card(s) to the cloud database?\n\n' +
      'Cards from this PC that no longer exist here will be removed from the cloud.\n' +
      'Cards created elsewhere (other PCs, the web admin) are never touched.'
    );
    if (!ok) return;
    var b = $('btnSync');
    b.disabled = true; b.textContent = 'Syncing…';
    try {
      var data = await api('POST', '/api/sync', { mirror: true });
      var s = data.summary;
      state.events = data.events;
      toast('Synced ' + s.cards + ' card(s): +' + s.created + ' / ~' + s.updated + ' / -' + s.removed, 'success');
      await refresh();
    } catch (e) {
      toast('Sync failed: ' + e.message, 'error');
    }
    b.disabled = false; b.textContent = 'Sync to Cloud';
  });

  /* ---------- Strike-Safe Domain Switcher & Quick Tunnel ---------- */
  $('btnSaveDomain').addEventListener('click', async function () {
    var url = $('inDomainUrl').value.trim();
    if (!url) { toast('Please enter a stream base URL or tunnel domain', 'error'); return; }
    var btn = $('btnSaveDomain');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      var res = await api('POST', '/api/tunnel/set-domain', { url: url });
      toast('Domain updated in MongoDB Atlas – all players switched instantly!', 'success');
      state.events = res.events;
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Save & Apply';
    }
  });

  $('btnNewTunnel').addEventListener('click', async function () {
    var ok = window.confirm('Generate a fresh Cloudflare Quick Tunnel (trycloudflare.com)?\n\nThis will automatically start a new tunnel, save the HTTPS URL to MongoDB Atlas, and update all active stream cards.');
    if (!ok) return;
    var btn = $('btnNewTunnel');
    btn.disabled = true; btn.textContent = 'Generating…';
    toast('Spawning Cloudflare Quick Tunnel… (may take 5-10s)', '');
    try {
      var res = await api('POST', '/api/tunnel/restart');
      $('inDomainUrl').value = res.url;
      toast('New tunnel generated & saved: ' + res.url, 'success');
      state.events = res.events;
      await refresh();
    } catch (err) {
      toast('Tunnel generation failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '⚡ New Quick Tunnel';
    }
  });

  $('btnTestDomain').addEventListener('click', async function () {
    var url = $('inDomainUrl').value.trim();
    if (!url) { toast('Please enter a URL to test', 'error'); return; }
    var btn = $('btnTestDomain');
    btn.disabled = true; btn.textContent = 'Testing…';
    try {
      var res = await api('POST', '/api/tunnel/test', { url: url });
      if (res.ok) {
        toast('Domain online · HTTP ' + res.status + ' · ' + res.latencyMs + 'ms · CORS: ' + (res.cors || 'none'), 'success');
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
        chip.className = 'chip ok';
        chip.textContent = 'Quick Tunnel Active (' + t.uptimeSec + 's)';
        if (!$('inDomainUrl').value) $('inDomainUrl').value = t.url;
      } else if (t.status === 'starting') {
        chip.className = 'chip scheduled';
        chip.textContent = 'Tunnel Starting…';
      } else if (t.lastError) {
        chip.className = 'chip bad';
        chip.textContent = 'Tunnel Error: ' + t.lastError.slice(0, 25);
      } else {
        chip.className = 'chip';
        chip.textContent = 'Tunnel: Idle / External';
      }
      if (t.publicStreamBaseUrl && (!$('inDomainUrl').value || $('inDomainUrl').value === t.url)) {
        $('inDomainUrl').value = t.publicStreamBaseUrl;
      }
    } catch (e) {
      /* ignore */
    }
  }

  refresh();
  updateTunnelChip();
  setInterval(function () {
    if (!$('dlg').open) {
      refresh();
      updateTunnelChip();
    }
  }, 15000);
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
