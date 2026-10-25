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
 *   npm run check:packaging                     # the repository this file lives in
 *   npm run check:packaging -- --at=DIR         # one directory tree
 *   npm run check:packaging -- --suite          # every sibling project of the suite
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
    ];
    let ok = true;
    for (const [label, entry, expectFinding] of cases) {
      const found = findingsFor(entry.config, entry.where);
      const passed = expectFinding ? found.length > 0 : found.length === 0;
      ok = check(`self-test: ${label}`, passed, passed ? "" : `expected ${expectFinding ? "a finding" : "clean"}, got ${JSON.stringify(found)}`) && ok;
    }
    return ok;
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
  const suite = arg("suite");
  const named = arg("at");
  let roots;
  if (named) {
    roots = [path.resolve(String(named))];
  } else if (suite) {
    const parent = path.resolve(ROOT, "..");
    try {
      roots = fs
        .readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
        .map((entry) => path.join(parent, entry.name));
    } catch {
      // A checkout on its own (a CI box, a deploy) has no siblings to name. Say so rather than
      // pretending the wider suite was checked.
      console.log("  note: no suite parent to walk, so only this repository was checked");
      roots = [ROOT];
    }
  } else {
    roots = [ROOT];
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
  console.log(`\n${results.filter((row) => row.pass).length} passed, ${results.filter((row) => !row.pass).length} failed`);
  process.exitCode = results.every((row) => row.pass) ? 0 : 1;
}
