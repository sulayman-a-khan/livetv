#!/usr/bin/env node
/**
 * Finds stream rows whose URL carries embedded credentials (`user:pass@host`)
 * and, when explicitly asked, quarantines them.
 *
 * WHY THIS EXISTS
 *
 * New links are refused when they carry userinfo (`lib/ssrfGuard.ts`), and the
 * probe never fetches one. Rows written before that rule existed can still be
 * in the database. A link the probe has not re-checked can still be `active`,
 * and the website publishes active links. This script finds those rows.
 *
 * WHAT IT PRINTS
 *
 * Collection, row id, scheme, host, which fields carry userinfo, and whether a
 * username and/or password is present. It never prints the username, the
 * password, the path or the query — those can all be secrets. The host is the
 * only part of the address it names.
 *
 * READ-ONLY BY DEFAULT
 *
 *   node scripts/audit-credential-urls.mjs
 *       Scans and prints the redacted report. Writes nothing.
 *
 *   node scripts/audit-credential-urls.mjs --apply
 *       Writes a backup first, then, only if the backup succeeded:
 *         - StreamLink: disable the row (adminDisabled), mark it broken, and
 *           strip the userinfo from its URL. The rest of the address is kept.
 *         - PlaylistEntry: mark it missing and strip the userinfo from its URL
 *           and canonicalUrl. A later sync may re-add the original URL, which
 *           the probe then refuses as unsafe.
 *       Nothing is deleted. The backup is the only copy of the original
 *       address, and it contains credentials: keep it private and delete it
 *       once the run is verified.
 *
 * BACKUP
 *
 * `--backup-dir <path>` (default `backups/credential-url-audit`) receives one
 * timestamped JSON file with the full affected documents. The file is created
 * with owner-only permissions where the platform supports it, and its path is
 * printed. Its contents are never printed.
 *
 * ENV
 *
 *   MONGODB_URI   Required. Never printed by this script.
 *
 * Exit codes: 0 nothing to do / completed, 1 failure, 2 bad arguments.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DEFAULT_BACKUP_DIR = path.join("backups", "credential-url-audit");
const STREAMLINK = "streamlinks";
const PLAYLISTENTRY = "playlistentries";

/**
 * The userinfo in an address, or null.
 *
 * `new URL` is the authority: it is the same parser the guard and the probe
 * use. A value it refuses falls back to a narrow authority regex so a malformed
 * legacy row is still found rather than silently skipped.
 */
export function credentialEvidence(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!parsed.username && !parsed.password) return null;
    return {
      scheme: parsed.protocol.replace(/:$/, ""),
      host: parsed.host,
      username: Boolean(parsed.username),
      password: Boolean(parsed.password),
    };
  } catch {
    const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)@([^/?#]*)/i.exec(raw);
    if (!match) return null;
    const authority = match[2];
    const separator = authority.indexOf(":");
    return {
      scheme: match[1].toLowerCase(),
      host: match[3] || "(unreadable)",
      username: separator === -1 ? authority.length > 0 : separator > 0,
      password: separator !== -1 && separator < authority.length - 1,
    };
  }
}

/**
 * The same address with its userinfo removed and everything else untouched.
 *
 * The replacement is textual on purpose: serialising a signed URL through
 * `URL.toString()` can rewrite path and query bytes. Only the authority's
 * `...@` prefix is removed.
 */
export function redactUserinfo(value) {
  if (typeof value !== "string") return value;
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@(.*)$/i, "$1$2");
}

/** The value a reportable field names, including the one nested path. */
export function fieldValue(doc, field) {
  if (field === "lastCheck.finalUrl") return doc.lastCheck && doc.lastCheck.finalUrl;
  return doc[field];
}

/** A report line that cannot carry a credential. */
export function reportLine(collection, id, field, evidence) {
  const parts = [
    `collection=${collection}`,
    `id=${id}`,
    `field=${field}`,
    `scheme=${evidence.scheme}`,
    `host=${evidence.host}`,
    `username=${evidence.username ? "yes" : "no"}`,
    `password=${evidence.password ? "yes" : "no"}`,
  ];
  return parts.join(" ");
}

/**
 * The write a quarantined StreamLink row receives.
 *
 * Disabled, broken and with its userinfo removed; the failure counters are
 * raised so automation treats it as failed rather than merely switched off.
 */
export function streamLinkQuarantine(doc, nowIso) {
  const set = {
    adminDisabled: true,
    status: "broken",
    failedAttempts: Math.max(1, Number(doc.failedAttempts) || 0),
    firstFailedAt: doc.firstFailedAt || nowIso,
    lastCheckedAt: nowIso,
    browserBlocker: null,
    deliveryMisses: 0,
    deliveryHidden: false,
    lastDeliveryMissAt: null,
  };
  const unset = {};
  if (credentialEvidence(doc.url)) set.url = redactUserinfo(doc.url);
  const finalUrl = doc.lastCheck && doc.lastCheck.finalUrl;
  if (credentialEvidence(finalUrl)) unset["lastCheck.finalUrl"] = "";
  return { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) };
}

/** The write a quarantined PlaylistEntry row receives. */
export function playlistEntryQuarantine(doc, nowIso) {
  const set = { status: "missing", lastMissingAt: nowIso };
  if (credentialEvidence(doc.url)) set.url = redactUserinfo(doc.url);
  if (credentialEvidence(doc.canonicalUrl)) set.canonicalUrl = redactUserinfo(doc.canonicalUrl);
  return { $set: set };
}

function parseArgs(argv) {
  const opts = { apply: false, backupDir: DEFAULT_BACKUP_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--backup-dir" && argv[i + 1]) opts.backupDir = argv[++i];
    else {
      console.error(`[credential-audit] unknown option: ${arg}`);
      console.error("usage: node scripts/audit-credential-urls.mjs [--apply] [--backup-dir <path>]");
      process.exit(2);
    }
  }
  return opts;
}

function backupPath(directory) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(directory, `credential-urls-${stamp}.json`);
}

function writeBackup(directory, rows) {
  fs.mkdirSync(directory, { recursive: true });
  const file = backupPath(directory);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows may not support POSIX modes; the directory is still user-only.
  }
  return file;
}

async function scan(collection) {
  const hits = [];
  const cursor = collection.find({
    $or: [
      { url: /@/ },
      { canonicalUrl: /@/ },
      { "lastCheck.finalUrl": /@/ },
    ],
  });
  for await (const doc of cursor) {
    const fields = [];
    if (credentialEvidence(doc.url)) fields.push("url");
    if (credentialEvidence(doc.canonicalUrl)) fields.push("canonicalUrl");
    if (credentialEvidence(doc.lastCheck && doc.lastCheck.finalUrl)) {
      fields.push("lastCheck.finalUrl");
    }
    if (fields.length > 0) hits.push({ doc, fields });
  }
  return hits;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const uri = (process.env.MONGODB_URI || "").trim();
  if (!uri) {
    console.error("[credential-audit] MONGODB_URI is not set; nothing was read or written.");
    process.exit(1);
  }

  const mongoose = (await import("mongoose")).default;

  let connection = null;
  try {
    connection = await mongoose.createConnection(uri, {
      serverSelectionTimeoutMS: 10_000,
    }).asPromise();

    const db = connection.db;
    const streamLinks = await scan(db.collection(STREAMLINK));
    const playlistEntries = await scan(db.collection(PLAYLISTENTRY));
    const total = streamLinks.length + playlistEntries.length;

    console.log(
      `[credential-audit] rows with userinfo: ${STREAMLINK}=${streamLinks.length} ` +
        `${PLAYLISTENTRY}=${playlistEntries.length} total=${total}`
    );
    for (const { doc, fields } of streamLinks) {
      for (const field of fields) {
        console.log(
          reportLine(STREAMLINK, String(doc._id), field, credentialEvidence(fieldValue(doc, field)))
        );
      }
    }
    for (const { doc, fields } of playlistEntries) {
      for (const field of fields) {
        console.log(
          reportLine(PLAYLISTENTRY, String(doc._id), field, credentialEvidence(fieldValue(doc, field)))
        );
      }
    }

    if (total === 0) {
      console.log("[credential-audit] nothing to clean up.");
      return;
    }
    if (!opts.apply) {
      console.log("[credential-audit] dry run: nothing was written. Re-run with --apply to quarantine.");
      return;
    }

    // Backup first, and fail the run if it cannot be written: no write happens
    // without a restorable copy.
    const backup = writeBackup(opts.backupDir, [
      ...streamLinks.map(({ doc }) => ({ collection: STREAMLINK, document: doc })),
      ...playlistEntries.map(({ doc }) => ({ collection: PLAYLISTENTRY, document: doc })),
    ]);
    console.log(`[credential-audit] backup written (contains credentials; keep private): ${backup}`);

    const nowIso = new Date().toISOString();
    let disabled = 0;
    let missing = 0;
    let failed = 0;

    for (const { doc } of streamLinks) {
      try {
        await db.collection(STREAMLINK).updateOne(
          { _id: doc._id },
          streamLinkQuarantine(doc, nowIso)
        );
        disabled += 1;
      } catch (error) {
        failed += 1;
        console.error(
          `[credential-audit] ${STREAMLINK} id=${String(doc._id)} not quarantined: ${error?.code || error?.name}`
        );
      }
    }
    for (const { doc } of playlistEntries) {
      try {
        await db.collection(PLAYLISTENTRY).updateOne(
          { _id: doc._id },
          playlistEntryQuarantine(doc, nowIso)
        );
        missing += 1;
      } catch (error) {
        // Two legacy entries whose credentials differ can redact to the same
        // canonical URL and collide with the unique index. The row stays
        // unexposed (it is still a `present` playlist entry, not a link), and
        // the run says so rather than stopping halfway.
        failed += 1;
        console.error(
          `[credential-audit] ${PLAYLISTENTRY} id=${String(doc._id)} not quarantined: ${error?.code || error?.name}`
        );
      }
    }

    console.log(
      `[credential-audit] quarantined: ${STREAMLINK} disabled=${disabled} ` +
        `${PLAYLISTENTRY} marked-missing=${missing} failed=${failed}. Nothing was deleted.`
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    await connection?.close?.();
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    // The message can name a cluster host; the name alone is enough here.
    console.error(`[credential-audit] failed: ${error?.name || "Error"}`);
    process.exit(1);
  });
}