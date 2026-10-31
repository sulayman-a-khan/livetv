#!/usr/bin/env node
/**
 * Removes the leftover indexes on the fixtures collection that belong to a schema this
 * project no longer has.
 *
 * WHY THIS EXISTS
 * The fixtures collection was once fed by a schedule API, and that schema carried
 * `apiMatchId`, `status`, `startTime` and `isPublished` on every card, with a unique
 * index over `{ apiMatchId, sport }`. The board is now typed in by hand and the current
 * model (`models/Fixture.ts`) has none of those fields — but MongoDB keeps the indexes
 * that were created for the old model, and an index over a field no document carries
 * still indexes every document: the missing field reads as `null`.
 *
 * So the unique index already held a row for `{ apiMatchId: null, sport: "cricket" }`,
 * and every second hand-entered cricket card was refused with
 * `E11000 duplicate key error ... dup key: { apiMatchId: null, sport: "cricket" }`.
 * The card was never a duplicate. The index was.
 *
 * WHAT IT TOUCHES
 * Indexes, and nothing else. No document is written, none is deleted, and the
 * collection's contents are exactly as they were. The field names of the existing
 * documents are read, because a field a document still carries is a field that is in
 * use even if the model no longer declares it.
 *
 * Usage:
 *   node scripts/repair-fixture-indexes.mjs        -> read-only: prints what would go
 *   node scripts/repair-fixture-indexes.mjs --run  -> drops the orphan indexes
 *
 * Env:
 *   MONGODB_URI   Atlas connection string. Read from the shell first, then from
 *                 .env.local. Its value is never printed by this script.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = process.env.MONGODB_DB_NAME || "freetv";
const COLLECTION = "fixtures";

/**
 * The fields the current model declares.
 *
 * A list of names rather than an import, because the model is TypeScript behind a path
 * alias and this script is plain node. If the model gains a field, add it here: an index
 * over a field the model owns is never an orphan, and dropping one would only make
 * Mongoose rebuild it on the next cold start.
 */
const SCHEMA_FIELDS = [
  "_id",
  "sport",
  "title",
  "teamA",
  "teamB",
  "teamALogo",
  "teamBLogo",
  "competition",
  "startsAt",
  "durationMinutes",
  "channels",
  "premiumChannelId",
  "visible",
  "createdAt",
  "updatedAt",
  "__v",
];

/**
 * The connection string, or null. Never echoed, never written anywhere.
 * The shell wins; otherwise one KEY=VALUE line is read out of .env.local.
 */
function readUri() {
  const fromEnv = process.env.MONGODB_URI?.trim();
  if (fromEnv) return fromEnv;

  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?MONGODB_URI\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[1].trim().replace(/^["']|["']$/g, "").trim();
    if (value) return value;
  }
  return null;
}

/** How an index is described on one line. */
function describe(index) {
  const unique = index.unique ? " unique" : "";
  const fields = Object.keys(index.key).join(",");
  return `${index.name.padEnd(30)} key={${fields}}${unique}`;
}

/**
 * An index that should go, and why.
 *
 * Two shapes qualify, and the second is the one that refused a card:
 *
 *   - every field it covers is dead, so it orders nothing and only costs a write;
 *   - it is unique and one of its fields is dead. A uniqueness decided by a field no
 *     document carries is decided by a constant: every document presents the same
 *     value, so the index refuses a second document that is not a duplicate of
 *     anything. `{ apiMatchId, sport }` is exactly that.
 *
 * A mixed index that is not unique is kept. Its live part can still be the one a query
 * uses, and dropping an index that might be serving a read is a judgement this script
 * does not get to make on its own.
 */
function orphansOf(indexes, fieldsInUse) {
  const dead = (index) => Object.keys(index.key).filter((field) => !fieldsInUse.has(field));
  return indexes.filter((index) => {
    if (index.name === "_id_") return false;
    const deadFields = dead(index);
    if (deadFields.length === 0) return false;
    if (deadFields.length === Object.keys(index.key).length) return true;
    return Boolean(index.unique);
  });
}

async function main() {
  const run = process.argv.includes("--run");
  const uri = readUri();
  if (!uri) {
    console.error(
      "[repair] no MONGODB_URI in the environment or .env.local — refusing to guess one."
    );
    process.exit(1);
  }

  await mongoose.connect(uri, { dbName: DB_NAME, serverSelectionTimeoutMS: 10_000 });
  const collection = mongoose.connection.db.collection(COLLECTION);

  const indexes = await collection.indexes();
  const documents = await collection.find({}, { projection: { _id: 0 } }).limit(200).toArray();
  const fieldsInUse = new Set([
    ...SCHEMA_FIELDS,
    ...documents.flatMap((doc) => Object.keys(doc)),
  ]);

  console.log(`[repair] ${DB_NAME}.${COLLECTION} · ${indexes.length} index(es) · ${documents.length} document(s)`);
  for (const index of indexes) console.log(`[repair]   ${describe(index)}`);

  const orphans = orphansOf(indexes, fieldsInUse);
  if (orphans.length === 0) {
    console.log("[repair] no orphan indexes: every index covers a field this project still uses.");
    await mongoose.disconnect();
    return;
  }

  console.log("");
  for (const index of orphans) {
    const deadFields = Object.keys(index.key).filter(
      (field) => !fieldsInUse.has(field)
    );
    const why = index.unique
      ? `unique, and ${deadFields.join(", ")} is dead — the uniqueness is decided by a constant, so it refuses cards that are not duplicates`
      : `covers ${deadFields.join(", ")}, which no document and no model field uses`;
    console.log(`[repair]   orphan: ${describe(index)} — ${why}`);
  }

  if (!run) {
    console.log("");
    console.log("[repair] read-only: nothing was dropped. Add --run to remove the orphan indexes.");
    await mongoose.disconnect();
    return;
  }

  console.log("");
  for (const index of orphans) {
    try {
      await collection.dropIndex(index.name);
      console.log(`[repair]   dropped ${index.name}`);
    } catch (error) {
      console.error(`[repair]   could not drop ${index.name}: ${error.message}`);
    }
  }

  const after = await collection.indexes();
  console.log("");
  console.log(`[repair] ${after.length} index(es) left:`);
  for (const index of after) console.log(`[repair]   ${describe(index)}`);
  console.log("[repair] no document was written or deleted.");

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(`[repair] ${error.message}`);
  process.exitCode = 1;
});
