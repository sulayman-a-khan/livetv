/**
 * Gate check for the packaging rule that audit finding P8.2 exists to keep.
 *
 * A distributable must never be told to carry its own configuration. Electron packs whatever
 * `build.files` names, and a portable executable travels to other machines with everything inside
 * it — so one `.env` entry in that list is a credential distribution, not a packaging detail. The
 * archived Origin Control build did exactly that — it named an env file and swept in the whole
 * runtime data directory — which is why this rule is a checked line rather than a README comment.
 * (Globs are written out in prose below as `!`-prefixed patterns; this block avoids the literal
 * glob-to-comment sequence so the comment can never close itself early.)
 *
 * Runs with plain `node`, reads nothing but configuration files, and reports the *pattern* that
 * breaks the rule — never a value, and never a secret it happened to pass.
 *
 *   npm run check:packaging                     # this repository and every sibling of the suite
 *   npm run check:packaging -- --at=DIR         # one directory tree
 *   npm run check:packaging -- --self-test      # assert the check itself still bites
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name) => {
  const prefix = `--${name}`;
  const found = process.argv.slice(2).find((entry) => entry === prefix || entry.startsWith(`${prefix}=`));
  return found === prefix ? true : found ? found.slice(prefix.length + 1) : undefined;
};

/**
 * Pattern text that means "put a secret or runtime data inside the distributable". Compared
 * against the glob as written, because the glob is what the builder obeys.
 */
const DANGEROUS = [
  [/\.env/, "an env file, which is where credentials live"],
  [/(^|\/)data(\/|$|\*\*)/, "the runtime data directory, which holds recorded rows"],
  [/\.(key|pem|p12|pfx|crt|der)$/i, "a certificate or private key"],
  [/(credential|secret|token|password)/i, "a file named for a credential"],
  [/id_rsa|\.npmrc|\.netrc|\.cloudflared/, "an identity or service credential"],
  [/store\.json|snapshot\.json/, "a store file, which can carry recorded rows"],
];

/** A pattern that sweeps in whatever the directory holds, allowlists aside. */
const CATCH_ALL = new Set(["*", "**", "**/*", "./**/*"]);

const results = [];
const check = (label, pass, detail = "") => {
  results.push({ label, pass, detail });
  console.log(`${pass ? "[ok]  " : "[FAIL]"} ${label}${detail ? ` — ${detail}` : ""}`);
  return pass;
};

/**
 * Why a `build` block is or is not an executable-packaging config. A plain `"build": "next build"`
 * script string is not; electron-builder's block is an object that names an app id, an output
 * directory or a target platform.
 */
function isPackagingConfig(build) {
  if (!build || typeof build !== "object" || Array.isArray(build)) return false;
  return Boolean(build.appId || build.directories || build.files || build.win || build.mac || build.linux || build.nsis);
}

/**
 * The whole verdict, with no filesystem in it, so `--self-test` can argue with it.
 * Returns the list of findings for one config: empty means the config packages nothing secret.
 */
export function findingsFor(config, where) {
  const findings = [];
  if (!isPackagingConfig(config)) return findings;

  const files = config.files;
  if (files === undefined) {
    // electron-builder's own default is the whole app directory, and an app directory is where a
    // `.env` sits. A packaging config that never says what it includes is not a safe one.
    findings.push(`${where}: no explicit "files" list, so the builder packs everything it finds`);
    return findings;
  }

  const patterns = Array.isArray(files) ? files : typeof files === "object" && files !== null ? Object.keys(files) : [];
  if (Array.isArray(files) === false && patterns.length === 0) {
    findings.push(`${where}: a "files" map with no patterns in it`);
    return findings;
  }

  // `extraResources` and `extraFiles` copy files into the package outside the "files"
  // list, so they are a way around a clean "files" list and need their own look.
  for (const key of ["extraResources", "extraFiles"]) {
    const entries = config[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const from = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.from : null;
      if (typeof from !== "string") continue;
      const hit = DANGEROUS.find(([regex]) => regex.test(from));
      if (hit) findings.push(`${where}: "${key}" copies ${from} — ${hit[1]}`);
    }
  }

  const exclusions = patterns.filter((p) => typeof p === "string" && p.startsWith("!"));
  const excludesEnv = exclusions.some((p) => /\.env/.test(p));

  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.startsWith("!")) continue;
    const hit = DANGEROUS.find(([regex]) => regex.test(pattern));
    if (hit) {
      findings.push(`${where}: "${pattern}" would package ${hit[1]}`);
      continue;
    }
    if (CATCH_ALL.has(pattern) && !excludesEnv) {
      findings.push(`${where}: "${pattern}" sweeps the directory and nothing excludes .env`);
    }
  }
  return findings;
}

/**
 * Every packaging config under one directory: the project's own `build` block, plus a standalone
 * `electron-builder` config file. Each is answered as a list of findings so the caller does not
 * have to know which shape it came from.
 */
function configsIn(dir) {
  const out = [];

  const packageFile = path.join(dir, "package.json");
  if (fs.existsSync(packageFile)) {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(packageFile, "utf-8"));
    } catch {
      out.push({ where: packageFile, findings: ["a package.json this check cannot read, so its build block is unverified"] });
      return out;
    }
    if (isPackagingConfig(parsed?.build)) {
      out.push({ where: packageFile, findings: findingsFor(parsed.build, packageFile) });
    }
  }

  for (const name of ["electron-builder.json", "electron-builder.yml", "electron-builder.yaml"]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;

    if (name.endsWith(".json")) {
      let config = null;
      try {
        config = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {
        out.push({ where: file, findings: ["an unreadable packaging config — it has to be read to be trusted"] });
        continue;
      }
      out.push({ where: file, findings: findingsFor(config, file) });
      continue;
    }

    // YAML without a dependency to parse it: a `files:` list item is a glob line beginning with
    // `-`, so those are what get checked, and an absent `files:` key is the same risk as an
    // implicit one in the JSON shape.
    const text = fs.readFileSync(file, "utf-8");
    const findings = [];
    if (!/^files:/m.test(text)) findings.push(`${file}: no explicit "files" list, so the builder packs everything it finds`);
    const excludesEnv = /^\s*-\s*!.*\.env/m.test(text);
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      const item = raw.trimStart();
      if (!item.startsWith("-") || item.startsWith("- !")) continue;
      const pattern = item.replace(/^-\s*/, "").replace(/^["']|["']$/g, "");
      const at = `${file}:${index + 1}`;
      const hit = DANGEROUS.find(([regex]) => regex.test(pattern));
      if (hit) findings.push(`${at}: "${pattern}" would package ${hit[1]}`);
      else if (CATCH_ALL.has(pattern) && !excludesEnv) findings.push(`${at}: "${pattern}" sweeps the directory and nothing excludes .env`);
    }
    out.push({ where: file, findings });
  }

  return out;
}

/**
 * Walks a project tree a few levels deep — a suite root holds its components one level further in,
 * and the archived one is the config this check was written about — skipping the directories that
 * hold other people's code or build output rather than a packaging decision.
 */
function discoverConfigs(root, maxDepth = 3) {
  const skip = new Set(["node_modules", ".git", ".next", ".tmp-tests", "dist", "build", "out", "coverage", ".vercel"]);
  const found = [];
  const walk = (dir, depth) => {
    found.push(...configsIn(dir));
    if (depth >= maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || skip.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

function scan(dir) {
  return discoverConfigs(dir);
}

/**
 * What a *built* package must not contain. The rule above judges the builder's intent;
 * this judges what the builder actually produced, because a package that carries a `.env`
 * is a credential in transit no matter what the config says today.
 */
const FORBIDDEN_FILE = [
  [/\.env(\..*)?$/i, "an env file, which is where credentials live"],
  [/\.(key|pem|p12|pfx|crt|der)$/i, "a certificate or private key"],
  [/^(store|snapshot)\.json$/i, "a store file, which can carry recorded rows"],
  [/(credential|secret|token|password)/i, "a file named for a credential"],
];

/**
 * The app tree of a built package. electron-builder writes `resources/app` inside its
 * unpacked output, and the single-file portable EXE is packed from that same tree, so
 * whatever is here is what the EXE carries.
 */
function isArtifactAppDir(dir) {
  return path.basename(dir) === "app" && path.basename(path.dirname(dir)) === "resources";
}

function artifactAppDirs(root) {
  const found = [];
  const skip = new Set(["node_modules", ".git", ".next", ".tmp-tests", "coverage", ".vercel"]);
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (isArtifactAppDir(full)) {
        found.push(full);
        continue;
      }
      if (skip.has(entry.name)) continue;
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * The forbidden files inside one built package. Paths and sizes only — a credential is
 * never read, opened or printed by this check.
 */
function findingsInArtifact(appDir) {
  const findings = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const at = path.relative(appDir, full);
      if (entry.isDirectory()) {
        if (entry.name === "data") {
          let count = 0;
          try {
            count = fs.readdirSync(full).length;
          } catch {
            count = 0;
          }
          // An empty directory carries nothing. A directory with rows in it does.
          if (count > 0) {
            findings.push({ at, why: "the runtime data directory, which holds recorded rows", size: count });
          }
          continue;
        }
        if (entry.name !== "node_modules") walk(full, depth + 1);
        continue;
      }
      const hit = FORBIDDEN_FILE.find(([regex]) => regex.test(entry.name));
      if (!hit) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        size = 0;
      }
      findings.push({ at, why: hit[1], size });
    }
  };
  walk(appDir, 0);
  return findings;
}

/**
 * The packaging config that governs a built package: the nearest `package.json` above it
 * that carries a build block. Used to say whether a package predates the current rule.
 */
function governingConfig(appDir) {
  let dir = path.dirname(appDir);
  for (let depth = 0; depth < 6; depth += 1) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (isPackagingConfig(parsed?.build)) return file;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * A path a reader can act on: relative to the suite when the package is in it, absolute
 * otherwise. A path that climbs out of the project tells nobody which file it means.
 */
function displayPath(target) {
  const suite = path.resolve(ROOT, "..");
  const relative = path.relative(suite, target);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return path.join(path.basename(suite), relative);
  return target;
}
/**
 * Asserts the check still catches each shape of the mistake, against throwaway configs in a temp
 * directory — so a future edit to `findingsFor` cannot pass by going blind.
 */
function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soluplay-packaging-"));
  const write = (name, build) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ name, build }), "utf-8");
    return { config: build, where: file };
  };
  try {
    const cases = [
      ["the archived mistake: an env file named outright", write("a", { appId: "x", files: ["main.js", ".env"] }), true],
      ["the archived mistake: the runtime data directory", write("b", { appId: "x", files: ["main.js", "data/**/*"] }), true],
      ["a private key", write("c", { appId: "x", files: ["main.js", "signing.pem"] }), true],
      ["a catch-all with nothing excluding .env", write("d", { appId: "x", files: ["**/*"] }), true],
      ["no files list at all", write("e", { appId: "x", win: { target: "portable" } }), true],
      ["the corrected rule", write("f", { appId: "x", files: ["main.js", "public/**/*", "!**/.env", "!data/**"] }), false],
      ["not a packaging config", write("g", { scripts: { build: "next build" } }), false],
      [
        "a clean files list with a credential copied in beside it",
        write("h", {
          appId: "x",
          files: ["main.js", "!**/.env"],
          extraResources: [{ from: ".env", to: ".env" }],
        }),
        true,
      ],
      [
        "a clean files list with a whole data directory copied in beside it",
        write("i", {
          appId: "x",
          files: ["main.js"],
          extraFiles: ["data/events.json"],
        }),
        true,
      ],
      [
        "a clean files list with an ordinary resource copied in beside it",
        write("j", {
          appId: "x",
          files: ["main.js"],
          extraResources: [{ from: "build/icon.png", to: "icon.png" }],
        }),
        false,
      ],
    ];
    let ok = true;
    for (const [label, entry, expectFinding] of cases) {
      const found = findingsFor(entry.config, entry.where);
      const passed = expectFinding ? found.length > 0 : found.length === 0;
      ok = check(`self-test: ${label}`, passed, passed ? "" : `expected ${expectFinding ? "a finding" : "clean"}, got ${JSON.stringify(found)}`) && ok;
    }

    // The artifact rules are checked the same way, against a throwaway package tree.
    const appDir = path.join(dir, "resources", "app");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "main.js"), "0");
    let okArtifacts = true;
    const clean = findingsInArtifact(appDir);
    okArtifacts =
      check("self-test: a package with nothing but its code is clean", clean.length === 0, clean.length ? JSON.stringify(clean) : "") &&
      okArtifacts;

    fs.writeFileSync(path.join(appDir, ".env"), "SECRET=never-printed\n");
    const withEnv = findingsInArtifact(appDir);
    okArtifacts =
      check("self-test: a package carrying an env file is caught", withEnv.some((f) => f.at === ".env"), JSON.stringify(withEnv)) &&
      okArtifacts;

    fs.mkdirSync(path.join(appDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "data", "events.json"), "{}");
    const withData = findingsInArtifact(appDir);
    okArtifacts =
      check("self-test: a package carrying the runtime data directory is caught", withData.some((f) => f.at === "data"), JSON.stringify(withData)) &&
      okArtifacts;

    fs.writeFileSync(path.join(appDir, "signing.pem"), "-----BEGIN KEY-----\n");
    const withKey = findingsInArtifact(appDir);
    okArtifacts =
      check("self-test: a package carrying a private key is caught", withKey.some((f) => f.at === "signing.pem"), JSON.stringify(withKey)) &&
      okArtifacts;

    // The report must name the file and never its contents.
    okArtifacts =
      check("self-test: the artifact report never carries a value", !JSON.stringify(withEnv).includes("never-printed")) &&
      okArtifacts;

    return ok && okArtifacts;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------------------- */

if (arg("self-test")) {
  const ok = selfTest();
  console.log(`\n${ok ? "the packaging check still bites" : "the packaging check is blind"}`);
  process.exitCode = ok ? 0 : 1;
} else {
  const named = arg("at");
  let roots;
  let suiteWide = false;
  if (named) {
    roots = [path.resolve(String(named))];
  } else {
    // The default covers the whole suite, because the one packaging config in it lives in
    // a sibling project. A check that only looked at this repository inspected nothing at
    // all and still passed, which is how a rule quietly stops being enforced.
    const parent = path.resolve(ROOT, "..");
    try {
      roots = fs
        .readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
        .map((entry) => path.join(parent, entry.name));
      if (!roots.includes(ROOT)) roots.push(ROOT);
      suiteWide = true;
    } catch {
      // A checkout on its own (a CI box, a deploy) has no siblings to name. Say so rather than
      // pretending the wider suite was checked.
      console.log("  note: no suite parent to walk, so only this repository was checked");
      roots = [ROOT];
    }
  }

  const configs = roots.flatMap(scan);
  const findings = configs.flatMap((entry) => entry.findings);
  console.log(
    `${roots.map((r) => path.basename(r) || r).join(", ")} — ${configs.length} packaging config(s) inspected`
  );
  for (const line of findings) console.log(`  ${line}`);
  check(
    configs.length === 0
      ? "nothing to inspect here, so nothing is claimed about a build"
      : findings.length === 0
        ? "no distributable is told to carry a credential"
        : `${findings.length} packaging rule violation(s)`,
    findings.length === 0
  );

  // A rule that the builder obeys is worth nothing if the package already on disk carries
  // the secret. The built tree is judged too, and a package that holds one fails here.
  const artifacts = roots.flatMap((root) => artifactAppDirs(root));
  let artifactFindings = 0;
  for (const appDir of artifacts) {
    const found = findingsInArtifact(appDir);
    if (!found.length) continue;
    artifactFindings += found.length;
    const config = governingConfig(appDir);
    let age = "";
    if (config) {
      try {
        const built = fs.statSync(appDir).mtimeMs;
        const rule = fs.statSync(config).mtimeMs;
        age =
          built < rule
            ? "this package was built before the current packaging rule, so it is a leftover that still carries the secret"
            : "this package was built after the current packaging rule, so the rule was not obeyed";
      } catch {
        /* the ages are a note, not a verdict */
      }
    }
    console.log(`  ${displayPath(appDir)} — ${found.length} forbidden entr(ies) in a built package`);
    for (const item of found) {
      const size = item.at.endsWith("data") ? `${item.size} entr(ies)` : `${item.size} byte(s)`;
      console.log(`    ${item.at} — ${item.why} (${size})`);
    }
    if (age) console.log(`    ${age}`);
  }
  check(
    artifacts.length === 0
      ? "no built package to inspect here, so nothing is claimed about a build"
      : artifactFindings === 0
        ? "no built package carries a credential"
        : `${artifactFindings} forbidden entr(ies) in ${artifacts.length} built package(s)`,
    artifactFindings === 0
  );

  // A check that found no packaging config at all has not checked anything. Say so as a
  // failure rather than as a quiet pass.
  if (suiteWide) {
    check(
      "the suite's packaging config was found and inspected",
      configs.length > 0,
      configs.length === 0 ? "no packaging config was reachable from the suite root" : ""
    );
  }

  console.log(`\n${results.filter((row) => row.pass).length} passed, ${results.filter((row) => !row.pass).length} failed`);
  process.exitCode = results.every((row) => row.pass) ? 0 : 1;
}
