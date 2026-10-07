/**
 * SoluPlay — Category Migration (five rails only)
 * ===============================================
 * Rewrites every `Channel.category` onto one of the five catalogue rails
 * (Sports, Bangla, Indian, Pakistani, Documentary) and drops the now-removed
 * `subCategory` field, using the SAME classifier the app uses.
 *
 * `lib/categories.ts` has no imports of its own, so this script transpiles that
 * one file with the TypeScript API and runs the result in-process. That keeps the
 * migration from drifting away from the runtime rules.
 *
 * Non-destructive by design (§9 of the pinned-catalogue plan):
 *   - dry-run by default; nothing is written unless `--apply` is passed;
 *   - only `category` (and the unused `subCategory`) are touched — never
 *     `isPinned`, `priorityOrder`, `tags`, or any stream/health field;
 *   - no channel and no stream link is ever deleted here;
 *   - `normalizeCategory()` returns the five values unchanged, so a channel
 *     already on a rail is skipped and the script is safe to re-run.
 *
 * Usage:
 *   node scripts/migrate-categories.js            # inspect only
 *   node scripts/migrate-categories.js --apply    # write MongoDB
 *   node scripts/migrate-categories.js --apply --store   # also migrate data/store.json
 */
require("dotenv").config({ path: ".env.local" });
require("dotenv").config();

const fs = require("fs");
const path = require("path");

const APPLY = process.argv.includes("--apply");
const STORE = process.argv.includes("--store");

function loadClassifier() {
  // `lib/categories.ts` imports nothing, so it can be transpiled on its own and
  // evaluated here — the migration uses the runtime rules instead of a copy.
  const ts = require("typescript");
  const source = fs.readFileSync(path.join(process.cwd(), "lib", "categories.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
  });
  const module = { exports: {} };
  new Function("exports", "module", outputText)(module.exports, module);
  const mod = module.exports;
  if (typeof mod.normalizeCategory !== "function" || !Array.isArray(mod.CHANNEL_CATEGORIES)) {
    throw new Error("Could not load lib/categories.ts for the migration");
  }
  return {
    normalizeCategory: mod.normalizeCategory,
    CHANNEL_CATEGORIES: mod.CHANNEL_CATEGORIES,
  };
}

function describe(ch) {
  return `${ch.name}  [${ch.isPinned ? "PINNED" : "unpinned"}]  "${ch.category || ""}"` +
    (ch.subCategory ? ` + sub "${ch.subCategory}"` : "");
}

async function migrateMongo() {
  const mongoose = require("mongoose");
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set. Add it to .env.local / .env (run from the repo root) or export it first.");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const Channel =
    mongoose.models.Channel ||
    mongoose.model("Channel", new mongoose.Schema({}, { strict: false }));

  const docs = await Channel.find({}).sort({ isPinned: -1, name: 1 }).lean();
  console.log(`MongoDB channels: ${docs.length}`);
  return { Channel, docs };
}

function migrateStore(channels) {
  const file = path.join(process.cwd(), "data", "store.json");
  if (!fs.existsSync(file)) {
    console.log(`No local store at ${file} — skipping.`);
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = raw.channels || [];
  console.log(`data/store.json channels: ${list.length}`);
  return { collection: list, file, raw };
}

function plan(list, normalizeCategory) {
  const updates = [];
  const skipped = [];
  for (const ch of list) {
    const next = normalizeCategory(ch.category, ch.name);
    const hadSub = Boolean(ch.subCategory);
    if (next === ch.category && !hadSub) {
      skipped.push(ch);
      continue;
    }
    updates.push({ doc: ch, from: ch.category || "(empty)", to: next, dropSub: hadSub });
  }
  return { updates, skipped };
}

function report(label, { updates, skipped }) {
  const tally = new Map();
  for (const u of updates) {
    const key = `${u.from} → ${u.to}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }

  console.log(`\n=== ${label} ===`);
  console.log(`Already on a rail (untouched): ${skipped.length}`);
  console.log(`To rewrite: ${updates.length}`);
  for (const [key, count] of Array.from(tally.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${key}`);
  }

  const pinned = updates.filter((u) => u.doc.isPinned === true);
  if (pinned.length > 0) {
    console.log(`\nPinned channels in the rewrite list (${pinned.length}) — confirm these before publishing:`);
    for (const u of pinned.slice(0, 40)) {
      console.log(`  ${describe(u.doc)}  →  "${u.to}"`);
    }
    if (pinned.length > 40) console.log(`  … and ${pinned.length - 40} more`);
  }
}

async function main() {
  const { normalizeCategory } = loadClassifier();

  const needsConn = Boolean(process.env.MONGODB_URI);
  const mongo = needsConn ? await migrateMongo() : null;

  let mongoPlan = null;
  if (mongo) {
    mongoPlan = plan(mongo.docs, normalizeCategory);
    report("MongoDB", mongoPlan);
  } else {
    console.log("MONGODB_URI is not set — MongoDB pass skipped, local store only.");
  }

  const store = migrateStore();
  let storePlan = null;
  if (store) {
    storePlan = plan(store.collection, normalizeCategory);
    report("data/store.json", storePlan);
  }

  if (!APPLY) {
    console.log("\nDry run — nothing was written.");
    console.log("Re-run with --apply to write MongoDB" + (store ? ", and add --store to also migrate data/store.json" : "") + ".");
    return;
  }

  if (mongo && mongoPlan.updates.length > 0) {
    for (const u of mongoPlan.updates) {
      const patch = { $set: { category: u.to } };
      if (u.dropSub) patch.$unset = { subCategory: "" };
      await mongo.Channel.updateOne({ _id: u.doc._id }, patch);
    }
    console.log(`\nMongoDB: rewrote ${mongoPlan.updates.length} channel(s).`);
  }

  if (STORE && store && storePlan.updates.length > 0) {
    for (const u of storePlan.updates) {
      u.doc.category = u.to;
      if (u.dropSub) delete u.doc.subCategory;
    }
    fs.writeFileSync(store.file, JSON.stringify(store.raw, null, 2));
    console.log(`data/store.json: rewrote ${storePlan.updates.length} channel(s).`);
  } else if (store && storePlan.updates.length > 0) {
    console.log(`\ndata/store.json has ${storePlan.updates.length} channel(s) to rewrite — pass --store to apply.`);
  }
}

main()
  .then(async () => {
    const mongoose = require("mongoose");
    if (mongoose.connection.readyState === 1) await mongoose.disconnect();
    process.exit(0);
  })
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
