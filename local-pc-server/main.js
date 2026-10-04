"use strict";

/**
 * SoluPlay • Origin Control Server — Electron shell.
 *
 * Spawns server.js (the port-5000 Express app) as a child process, shows a
 * splash while http://127.0.0.1:5000 boots, then loads the live dashboard.
 * The window is never a static page: it always renders whatever the running
 * server serves, so UI edits need no rebuild — just restart the app.
 */

const { app, BrowserWindow, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = 5000;
const APP_URL = "http://127.0.0.1:5000/";
const POLL_INTERVAL_MS = 600;
const STARTUP_TIMEOUT_MS = 90000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let mainWindow = null;
let serverProcess = null;
let quitting = false;
let connecting = false;
/** "splash" while waiting for the server, "app" once the dashboard is loading. */
let mode = "splash";

app.setAppUserModelId("com.soluplay.origincontrol");

function appRoot() {
  // Packaged (asar disabled) => resources/app; dev => this folder.
  return app.isPackaged ? path.join(process.resourcesPath, "app") : __dirname;
}

function log(...args) {
  console.log("[electron]", ...args);
}

function ping(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: SERVER_HOST, port: SERVER_PORT, path: "/", timeout: timeoutMs || 1500 },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startServer() {
  const root = appRoot();
  const entry = path.join(root, "server.js");
  if (!fs.existsSync(entry)) {
    log("server.js not found at", entry);
    return false;
  }
  log("spawning server:", entry);
  serverProcess = spawn(process.execPath, [entry], {
    cwd: root,
    // Runs this same Electron binary as plain Node so the server has a runtime
    // even on machines without a system-wide Node.js install.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProcess.stdout.on("data", (d) => process.stdout.write("[server] " + d));
  serverProcess.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  serverProcess.on("exit", (code, signal) => {
    log("server exited with code", code, "signal", signal);
    serverProcess = null;
  });
  serverProcess.on("error", (err) => {
    log("failed to spawn server:", err.message);
    serverProcess = null;
  });
  return true;
}

function killServer() {
  const child = serverProcess;
  serverProcess = null;
  if (!child || child.exitCode !== null) return;
  log("stopping server pid", child.pid);
  if (process.platform === "win32") {
    // /T is required: server.js also spawns a cloudflared tunnel process.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function setSplashStatus(text) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents
    .executeJavaScript(
      `window.setStatus && window.setStatus(${JSON.stringify(text)})`
    )
    .catch(() => {});
}

function loadSplash(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mode = "splash";
  mainWindow
    .loadFile(path.join(appRoot(), "splash.html"), { query: { s: status } })
    .catch(() => {});
}

async function connectLoop() {
  if (connecting) return;
  connecting = true;
  const startedAt = Date.now();
  let timedOut = false;
  try {
    while (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      if (await ping()) {
        mode = "app";
        log("server is up, loading", APP_URL);
        mainWindow.loadURL(APP_URL).catch(() => {});
        return;
      }
      const elapsed = Date.now() - startedAt;
      if (!timedOut && elapsed > STARTUP_TIMEOUT_MS) {
        timedOut = true;
        setSplashStatus(
          "Still starting… first run may take a while. Retrying automatically."
        );
      } else if (!timedOut) {
        setSplashStatus(
          elapsed > 6000
            ? "Waiting for http://localhost:5000 to respond…"
            : "Starting local server…"
        );
      }
      await delay(POLL_INTERVAL_MS);
    }
  } finally {
    connecting = false;
  }
}

function createWindow() {
  // exe-level icon is skipped (signAndEditExecutable:false keeps the binary
  // hash SAC-approved), so set the window/taskbar icon from the bundled png.
  const iconPath = path.join(appRoot(), "build", "icon.png");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1000,
    minHeight: 620,
    show: false,
    backgroundColor: "#090d16",
    autoHideMenuBar: true,
    title: "SoluPlay • Origin Control Server",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_URL) && !url.startsWith("file://")) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (mode === "app" && validatedURL.startsWith(APP_URL)) {
        log("dashboard load failed:", errorCode, errorDescription);
        loadSplash("Connection lost — reconnecting to the local server…");
        setTimeout(() => connectLoop(), 1000);
      }
    }
  );

  loadSplash("Starting local server…");
}

async function boot() {
  createWindow();

  if (await ping()) {
    // Another instance of the server (or a previous run) already owns the port —
    // attach to it instead of spawning a doomed second listener.
    log("port 5000 is already serving — attaching to the existing server");
  } else if (!startServer()) {
    setSplashStatus("server.js is missing from the app bundle.");
  }

  connectLoop();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", () => {
    killServer();
  });
  app.on("window-all-closed", () => {
    killServer();
    app.quit();
  });
  process.on("exit", () => {
    killServer();
  });

  app.whenReady().then(boot);
}
