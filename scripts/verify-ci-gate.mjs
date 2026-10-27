/**
 * Gate check for SoluPlay's CI workflow (audit P14.11).
 *
 * Runs with plain `node`, no dependencies, and touches nothing: it reads
 * .github/workflows/ci.yml, package.json and tsconfig.tests.json and asserts
 * the things that must never quietly drift apart —
 *
 *   1. a push and a pull request both trigger the gate;
 *   2. the gate runs the project's type check, its lint and its tests, and
 *      every script it names really exists in package.json;
 *   3. the type check is a real type check (tsc --noEmit), the test compile
 *      is not allowed to skip typing (--noCheck), and the test compile is
 *      strict and covers the whole tests/ directory;
 *   4. no test file is left out of the aggregate test run;
 *   5. the workflow carries no literal credential or address, keeps write
 *      permissions off, and does not depend on the private stream box.
 *
 * A failing line is reported by line number only — a value that looks like a
 * credential is never echoed.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "ci.yml");
const PACKAGE = path.join(ROOT, "package.json");
const TESTS_CONFIG = path.join(ROOT, "tsconfig.tests.json");
const TESTS_DIR = path.join(ROOT, "tests");

const results = [];
const check = (label, pass, detail = "") => {
  results.push({ label, pass, detail });
  console.log(`${pass ? "[ok]  " : "[FAIL]"} ${label}${detail ? ` — ${detail}` : ""}`);
  return pass;
};

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * The workflow file.
 * ------------------------------------------------------------------------ */

const workflowText = readText(WORKFLOW);
if (workflowText === null) {
  check("the CI workflow file is present", false, path.relative(ROOT, WORKFLOW));
  console.log("\n[ci-gate] cannot evaluate the gate — fix the workflow file first.");
  process.exit(1);
}
check("the CI workflow file is present", true, path.relative(ROOT, WORKFLOW));

const workflowLines = workflowText.split(/\r?\n/);
const lineOf = (predicate) =>
  workflowLines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => predicate(entry.line));

/** The indented body of a top-level YAML key such as `on:`. */
function yamlBlock(text, header) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${header}:\\s*$`).test(line));
  if (start === -1) return null;
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      block.push(line);
      continue;
    }
    if (!/^\s/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

const onBlock = yamlBlock(workflowText, "on");
check("the workflow declares an `on:` block", onBlock !== null);
check(
  "a push triggers the gate",
  onBlock !== null && /^\s{2}push:/m.test(onBlock),
  "so a bad commit cannot reach main unchallenged"
);
check(
  "a pull request triggers the gate",
  onBlock !== null && /^\s{2}pull_request:/m.test(onBlock),
  "so a change is checked before it is merged"
);
check(
  "the workflow can also be started by hand",
  onBlock !== null && /^\s{2}workflow_dispatch:/m.test(onBlock)
);

/* ---------------------------------------------------------------------------
 * The scripts the gate runs.
 * ------------------------------------------------------------------------ */

const packageText = readText(PACKAGE);
let packageScripts = {};
let packageJson = null;
if (packageText !== null) {
  try {
    packageJson = JSON.parse(packageText);
    packageScripts = packageJson.scripts ?? {};
  } catch {
    packageJson = null;
  }
}
check("package.json is readable as JSON", packageJson !== null);
if (packageJson === null) {
  console.log("\n[ci-gate] cannot evaluate the gate — fix package.json first.");
  process.exit(1);
}

const runTargets = [...workflowText.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((match) => match[1]);
const uniqueTargets = [...new Set(runTargets)];
check(
  "the workflow runs at least one npm script",
  uniqueTargets.length > 0,
  uniqueTargets.join(", ")
);

for (const target of uniqueTargets) {
  check(
    `the workflow's "${target}" script exists in package.json`,
    Object.prototype.hasOwnProperty.call(packageScripts, target),
    Object.prototype.hasOwnProperty.call(packageScripts, target)
      ? "the gate runs a script that exists"
      : "the gate would fail on a script that does not exist"
  );
}

for (const required of ["typecheck", "lint", "test:all", "check:ci-gate"]) {
  check(
    `the gate runs "${required}"`,
    uniqueTargets.includes(required),
    uniqueTargets.includes(required) ? "" : "missing from the workflow"
  );
}

check(
  "the gate installs dependencies with npm ci",
  /npm ci/.test(workflowText),
  "a lockfile install, not a drifting resolve"
);

const testTargets = uniqueTargets.filter(
  (target) => target.startsWith("test:") && target !== "test:premium-box"
);
check(
  "the gate runs a test script",
  testTargets.length > 0,
  testTargets.join(", ")
);

/* ---------------------------------------------------------------------------
 * The type check has to be a type check.
 * ------------------------------------------------------------------------ */

const typecheck = String(packageScripts.typecheck ?? "");
check(
  "the typecheck script really type checks",
  /\btsc\b/.test(typecheck) && /--noEmit/.test(typecheck),
  typecheck || "no typecheck script"
);

const noCheckScripts = Object.entries(packageScripts)
  .filter(([, command]) => String(command).includes("--noCheck"))
  .map(([name]) => name);
check(
  "no script compiles the tests with --noCheck",
  noCheckScripts.length === 0,
  noCheckScripts.length === 0
    ? "the test compile type checks its own sources"
    : `still skipping typing: ${noCheckScripts.join(", ")}`
);

const lintScript = String(packageScripts.lint ?? "");
check("the lint script exists", lintScript.length > 0, lintScript);

/* ---------------------------------------------------------------------------
 * The test compile: strict, complete, and it must emit.
 * ------------------------------------------------------------------------ */

const testsConfigText = readText(TESTS_CONFIG);
let testsConfig = null;
if (testsConfigText !== null) {
  try {
    testsConfig = JSON.parse(testsConfigText);
  } catch {
    testsConfig = null;
  }
}
check("tsconfig.tests.json is readable as JSON", testsConfig !== null);
if (testsConfig === null) {
  console.log("\n[ci-gate] cannot evaluate the gate — fix tsconfig.tests.json first.");
  process.exit(1);
}

const testsOptions = testsConfig.compilerOptions ?? {};
check(
  "the test compile is strict",
  testsOptions.strict === true,
  `strict: ${JSON.stringify(testsOptions.strict)}`
);
check(
  "the test compile emits its output",
  testsOptions.noEmit === false && typeof testsOptions.outDir === "string",
  `outDir: ${JSON.stringify(testsOptions.outDir)}`
);
const testsInclude = Array.isArray(testsConfig.include) ? testsConfig.include : [];
check(
  "the test compile covers the whole tests directory",
  testsInclude.some((entry) => String(entry).replace(/\\/g, "/").includes("tests/**")),
  testsInclude.filter((entry) => String(entry).includes("tests")).join(", ")
);

/* ---------------------------------------------------------------------------
 * Every test file has to be inside the aggregate run.
 * ------------------------------------------------------------------------ */

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

/** The compiled test paths a script's `node --test` arguments would select. */
function testArgsOf(command) {
  const match = /node\s+--test\s+(.+)$/.exec(String(command).trim());
  if (!match) return [];
  return match[1]
    .split(/\s+/)
    .map((part) => part.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

const testSources = fs.existsSync(TESTS_DIR)
  ? fs
      .readdirSync(TESTS_DIR)
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => name.replace(/\.ts$/, ".js"))
  : [];
check("the tests directory holds test files", testSources.length > 0, `${testSources.length} files`);

const outDir = String(testsOptions.outDir ?? "").replace(/\\/g, "/").replace(/\/$/, "");
const allArgs = testArgsOf(packageScripts["test:all"] ?? "");
const uncovered = testSources.filter((name) => {
  const relative = `${outDir}/tests/${name}`;
  return !allArgs.some((arg) => {
    const pattern = arg.replace(/\\/g, "/");
    if (!pattern.includes("*")) {
      const base = pattern.replace(/\.js$/, "");
      return relative === `${base}.js` || relative.startsWith(`${base}/`);
    }
    return globToRegExp(pattern).test(relative);
  });
});
check(
  "every test file is inside the aggregate test run",
  uncovered.length === 0,
  uncovered.length === 0
    ? `${testSources.length} test files are covered`
    : `not run by test:all: ${uncovered.join(", ")}`
);

for (const [name, command] of Object.entries(packageScripts)) {
  if (!name.startsWith("test:") || name === "test:all" || name === "test:premium-box") continue;
  const args = testArgsOf(command);
  const missing = args.filter((arg) => {
    if (arg.includes("*")) return false;
    const source = path.join(TESTS_DIR, path.basename(arg).replace(/\.js$/, ".ts"));
    return !fs.existsSync(source);
  });
  check(
    `the "${name}" script points at a test file that exists`,
    missing.length === 0,
    missing.length === 0 ? "" : `missing: ${missing.join(", ")}`
  );
}

/* ---------------------------------------------------------------------------
 * Hygiene: no literal credential, no write permission, no dependency on the
 * private stream box.
 * ------------------------------------------------------------------------ */

function hardcodedCredentialLine(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    if (text.trim().startsWith("#")) continue;
    if (/\bbearer\b/i.test(text)) return index + 1;
    if (/https?:\/\//.test(text) && !/https?:\/\/\$\{\{/.test(text)) return index + 1;
  }
  return -1;
}

const literalSecretLine = hardcodedCredentialLine(workflowLines);
check(
  "the workflow hardcodes no URL or bearer value",
  literalSecretLine === -1,
  literalSecretLine === -1 ? "the gate needs no address and no token" : `line ${literalSecretLine}`
);

check(
  "the workflow reads no secret",
  !/secrets\./.test(workflowText),
  "the gate has nothing to authenticate with"
);

check(
  "the workflow keeps write permissions off",
  /permissions:\s*\n\s*contents:\s*read/.test(workflowText) && !/contents:\s*write/.test(workflowText)
);

const codeLines = workflowLines.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
const codeText = codeLines.join("\n");
check(
  "the gate does not depend on the private stream box",
  !/premium-box/.test(codeText),
  "test:premium-box needs the private ProxyServer checkout and stays local"
);
check(
  "the local stream-box test is still available",
  Object.prototype.hasOwnProperty.call(packageScripts, "test:premium-box"),
  "it is excluded from CI, not deleted"
);

/* ---------------------------------------------------------------------------
 * Verdict.
 * ------------------------------------------------------------------------ */

const failed = results.filter((entry) => !entry.pass);
console.log(
  `\n[ci-gate] ${results.length - failed.length}/${results.length} checks passed` +
    (failed.length ? ` — ${failed.length} FAILED` : "")
);
process.exit(failed.length ? 1 : 0);
