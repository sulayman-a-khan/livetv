#!/usr/bin/env node
/**
 * Runs the Next.js dev server with the local catalogue snapshot switched on.
 *
 * The snapshot is opt-in through one environment variable,
 * `LOCAL_CATALOGUE_SNAPSHOT`, and this launcher exists so that opting in does
 * not depend on the shell: `LOCAL_CATALOGUE_SNAPSHOT=… next dev` is not valid
 * syntax in cmd.exe, and the project is developed on Windows.
 *
 * The variable only takes effect inside `lib/inMemoryStore.ts` when there is
 * no `MONGODB_URI` and the process is not running on Vercel, so a snapshot can
 * never be selected in production and a configured database always wins.
 *
 * Next is launched through Node directly rather than through a shell, so the
 * command does not depend on `node_modules/.bin` being on PATH and no argument
 * is ever handed to a shell to interpret.
 *
 * Usage:
 *   node scripts/run-with-snapshot.mjs [next args...]
 *   node scripts/run-with-snapshot.mjs dev -p 3210
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const SNAPSHOT_ENV = "LOCAL_CATALOGUE_SNAPSHOT";
const DEFAULT_SNAPSHOT = path.join("data", "prod-snapshot.json");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

const args = process.argv.slice(2);
const nextArgs = args.length ? args : ["dev"];

const snapshotPath = path.resolve(ROOT, process.env[SNAPSHOT_ENV] || DEFAULT_SNAPSHOT);
if (!fs.existsSync(snapshotPath)) {
  console.error(
    `[snapshot] no snapshot at ${snapshotPath}\n` +
      `[snapshot] create it first:  npm run snapshot:production`
  );
  process.exit(1);
}
if (!fs.existsSync(NEXT_BIN)) {
  console.error(`[snapshot] Next.js is not installed at ${NEXT_BIN} — run npm install first.`);
  process.exit(1);
}

const child = spawn(process.execPath, [NEXT_BIN, ...nextArgs], {
  stdio: "inherit",
  env: { ...process.env, [SNAPSHOT_ENV]: snapshotPath },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
