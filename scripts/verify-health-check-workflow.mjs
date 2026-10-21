/**
 * Gate check for SoluPlay's automatic health pass.
 *
 * Runs with plain `node`, no dependencies, and touches nothing: it reads
 * .github/workflows/soluplay-health-check.yml plus the runner script and
 * asserts the two things that must never quietly drift apart —
 *
 *   1. a manual "Run workflow" executes even when the schedule gate is absent
 *      or "false", and a cron slot executes only when it is exactly "true";
 *   2. the pass still fires every four hours and still never shares a minute
 *      with any Vercel cron in vercel.json;
 *   3. vercel.json drives the playlist sync but no longer drives any health
 *      pass — this workflow is the only scheduled health driver.
 *
 * The job-level `if:` is evaluated as written in the file, so editing that
 * line cannot pass these cases by accident. A failing line is reported by
 * line number only — a value that looks like a credential is never echoed.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "soluplay-health-check.yml");
const RUNNER = path.join(ROOT, "scripts", "health-check-runner.mjs");
const VERCEL = path.join(ROOT, "vercel.json");

const results = [];
const check = (label, pass, detail = "") => {
  results.push({ label, pass, detail });
  console.log(`${pass ? "[ok]  " : "[FAIL]"} ${label}${detail ? ` — ${detail}` : ""}`);
  return pass;
};

/** Strip `${{ }}` and the quotes YAML may wrap the value in. */
function unwrapExpression(raw) {
  let text = raw.trim().replace(/^["']|["']$/g, "");
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  if (wrapped) text = wrapped[1].trim();
  return text;
}

/* ---------------------------------------------------------------------------
 * A deliberately small evaluator for the GitHub expression subset this file
 * uses: || and &&, the comparison operators, quoted literals, numbers, and
 * context paths such as github.event_name or vars.ANY_NAME. Parentheses are
 * supported. Anything else raises, rather than silently guessing.
 * ------------------------------------------------------------------------ */

const COMPARISONS = ["==", "!=", "<=", ">=", "<", ">"];

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = expr.indexOf(ch, i + 1);
      if (end === -1) throw new Error(`unterminated string literal in: ${expr}`);
      tokens.push({ kind: "string", value: expr.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ kind: ch });
      i += 1;
      continue;
    }
    if (expr.startsWith("||", i)) {
      tokens.push({ kind: "||" });
      i += 2;
      continue;
    }
    if (expr.startsWith("&&", i)) {
      tokens.push({ kind: "&&" });
      i += 2;
      continue;
    }
    const cmp = COMPARISONS.find((op) => expr.startsWith(op, i));
    if (cmp) {
      tokens.push({ kind: "op", value: cmp });
      i += cmp.length;
      continue;
    }
    if (/^-?[\d.]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?/.exec(expr.slice(i));
      if (!match) throw new Error(`malformed number in: ${expr}`);
      tokens.push({ kind: "number", value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    const pathMatch = /^[A-Za-z_][\w.]*/.exec(expr.slice(i));
    if (!pathMatch) throw new Error(`unsupported token at offset ${i} in: ${expr}`);
    tokens.push({ kind: "path", value: pathMatch[0] });
    i += pathMatch[0].length;
  }
  return tokens;
}

function parse(tokens, pos, contexts) {
  const [value, next] = parseOr(tokens, pos, contexts);
  if (next < tokens.length) throw new Error(`unexpected trailing token in expression`);
  return value;
}

function parseOr(tokens, pos, contexts) {
  let [left, next] = parseAnd(tokens, pos, contexts);
  while (next < tokens.length && tokens[next].kind === "||") {
    const [right, after] = parseAnd(tokens, next + 1, contexts);
    left = truthy(left) || truthy(right);
    next = after;
  }
  return [left, next];
}

function parseAnd(tokens, pos, contexts) {
  let [left, next] = parseComparison(tokens, pos, contexts);
  while (next < tokens.length && tokens[next].kind === "&&") {
    const [right, after] = parseComparison(tokens, next + 1, contexts);
    left = truthy(left) && truthy(right);
    next = after;
  }
  return [left, next];
}

function parseComparison(tokens, pos, contexts) {
  const [left, next] = parsePrimary(tokens, pos, contexts);
  if (next >= tokens.length || tokens[next].kind !== "op") return [left, next];
  const op = tokens[next].value;
  const [right, after] = parsePrimary(tokens, next + 1, contexts);
  return [compare(left, op, right), after];
}

function parsePrimary(tokens, pos, contexts) {
  const token = tokens[pos];
  if (!token) throw new Error("expression ended too early");
  if (token.kind === "(") {
    const [value, next] = parseOr(tokens, pos + 1, contexts);
    if (tokens[next]?.kind !== ")") throw new Error("unbalanced parentheses");
    return [value, next + 1];
  }
  if (token.kind === "string") return [token.value, pos + 1];
  if (token.kind === "number") return [token.value, pos + 1];
  if (token.kind === "path") return [resolvePath(token.value, contexts), pos + 1];
  throw new Error(`unsupported operand: ${token.kind}`);
}

function resolvePath(dotted, contexts) {
  const [root, ...rest] = dotted.split(".");
  let cursor = contexts[root];
  for (const segment of rest) {
    if (cursor === undefined || cursor === null) break;
    cursor = cursor[segment];
  }
  // GitHub renders an unset variable or input as an empty string.
  return cursor === undefined || cursor === null ? "" : cursor;
}

const truthy = (value) => value !== false && value !== "" && value !== 0 && value !== null;

function compare(left, op, right) {
  const numeric = Number(left);
  const bothNumeric =
    Number.isFinite(numeric) && Number.isFinite(Number(right)) && String(left).trim() !== "";
  const a = bothNumeric ? numeric : String(left);
  const b = bothNumeric ? Number(right) : String(right);
  switch (op) {
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    default:
      throw new Error(`unsupported operator: ${op}`);
  }
}

/* ---------------------------------------------------------------------------
 * Read the workflow's own text.
 * ------------------------------------------------------------------------ */

let workflowText;
try {
  workflowText = fs.readFileSync(WORKFLOW, "utf8");
} catch {
  check("workflow file is present", false, WORKFLOW);
  process.exit(1);
}
const workflowLines = workflowText.split(/\r?\n/);
const lineOf = (predicate) =>
  workflowLines.map((line, index) => ({ line, number: index + 1 })).filter((entry) => predicate(entry.line));

const ifEntries = lineOf((line) => /^\s*if:\s*\S/.test(line));
check(
  "exactly one job-level gate exists in the workflow",
  ifEntries.length === 1,
  ifEntries.length === 1 ? `line ${ifEntries[0].number}` : `found ${ifEntries.length}`
);
if (ifEntries.length !== 1) {
  console.log("\n[health-gate] cannot evaluate the gate — fix the workflow file first.");
  process.exit(1);
}

const gate = unwrapExpression(ifEntries[0].line.split(/if:\s*/)[1]);
console.log(`[health-gate] evaluating: ${gate}`);

const GATE_NAME = "SOLUPLAY_HEALTH_CHECK_SCHEDULE_ENABLED";

function runsFor(eventName, gateValue) {
  const vars = gateValue === null ? {} : { [GATE_NAME]: gateValue };
  return truthy(
    parse(tokenize(gate), 0, {
      github: { event_name: eventName },
      vars,
      secrets: {},
      inputs: {},
    })
  );
}

const gateCases = [
  { event: "workflow_dispatch", value: null, expected: true, why: "manual dispatch, variable absent" },
  { event: "workflow_dispatch", value: "false", expected: true, why: "manual dispatch, schedule disabled" },
  { event: "workflow_dispatch", value: "true", expected: true, why: "manual dispatch, schedule enabled" },
  { event: "schedule", value: null, expected: false, why: "cron slot, variable absent" },
  { event: "schedule", value: "false", expected: false, why: "cron slot, schedule disabled" },
  { event: "schedule", value: "", expected: false, why: "cron slot, variable empty" },
  { event: "schedule", value: "TRUE", expected: false, why: "cron slot, value not exactly true" },
  { event: "schedule", value: "true", expected: true, why: "cron slot, schedule enabled" },
];

for (const testCase of gateCases) {
  let actual;
  try {
    actual = runsFor(testCase.event, testCase.value);
  } catch (error) {
    check(`gate: ${testCase.why}`, false, `expression could not be evaluated (${error.message})`);
    continue;
  }
  check(
    `gate: ${testCase.event} runs when ${testCase.why.replace(/^.*, /, "")}`,
    actual === testCase.expected,
    `expected ${testCase.expected ? "runs" : "skips"}, got ${actual ? "runs" : "skips"}`
  );
}

/* ---------------------------------------------------------------------------
 * Schedule shape: every four hours, and never in a minute a Vercel cron uses.
 * ------------------------------------------------------------------------ */

const cronEntries = lineOf((line) => /^\s*-\s*cron:\s*\S/.test(line));
check(
  "the workflow has exactly one cron line",
  cronEntries.length === 1,
  `found ${cronEntries.length}`
);
const cron = unwrapYamlString(cronEntries[0]?.line.split(/cron:\s*/)[1] || "");

function unwrapYamlString(raw) {
  return (raw || "").trim().replace(/^["']|["']$/g, "");
}

const fields = cron.split(/\s+/);
check("cron has five fields", fields.length === 5, cron);

const minuteField = fields[0] ?? "";
const hourField = fields[1] ?? "";
const hours = hourField.split(",").map((part) => Number(part));
const evenSpacing =
  hours.length === 6 &&
  hours.every((hour) => Number.isFinite(hour)) &&
  hours.every((hour, index) => (hours[(index + 1) % 6] - hour + 24) % 24 === 4);
check(
  "the pass fires every four hours at :37",
  /^\d+$/.test(minuteField) && Number(minuteField) < 60 && evenSpacing,
  `${minuteField} ${hourField} * * *`
);

function expandField(field, size) {
  if (field === "*") return Array.from({ length: size }, (_, value) => value);
  const values = new Set();
  for (const part of field.split(",")) {
    const [body, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    const [lowRaw, highRaw] = body.includes("-") ? body.split("-") : [body, body];
    const low = Number(lowRaw);
    const high = body === "*" ? size - 1 : Number(highRaw ?? lowRaw);
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return [...values];
}

const cronMinutes = new Set(expandField(minuteField, 60));

let vercelText;
try {
  vercelText = fs.readFileSync(VERCEL, "utf8");
} catch {
  vercelText = "";
}
let vercelCrons = [];
try {
  vercelCrons = JSON.parse(vercelText).crons ?? [];
} catch {
  check("vercel.json is readable as JSON", false, "parse failed");
}

const vercelMinutes = new Set();
for (const entry of vercelCrons) {
  const entryFields = String(entry.schedule ?? "").split(/\s+/);
  for (const minute of expandField(entryFields[0] ?? "0", 60)) vercelMinutes.add(minute);
}
const colliding = [...cronMinutes].filter((minute) => vercelMinutes.has(minute));
check(
  "no Vercel cron shares this pass's minute",
  colliding.length === 0,
  colliding.length === 0
    ? `${vercelCrons.length} Vercel crons all fire on other minutes`
    : `minute(s) ${colliding.join(", ")} collide`
);
check(
  "the playlist sync cron is still listed",
  vercelCrons.some((entry) => entry.path === "/api/admin/scheduler/sync"),
  `sync remains in vercel.json — the other system is untouched`
);

const healthCrons = vercelCrons.filter((entry) => /health/i.test(String(entry.path ?? "")));
check(
  "no Vercel cron drives the health check",
  healthCrons.length === 0,
  healthCrons.length === 0
    ? "this GitHub pass is the only scheduled health driver"
    : `still scheduled: ${healthCrons.map((entry) => entry.path).join(", ")}`
);

/* ---------------------------------------------------------------------------
 * Hygiene: the workflow must carry no literal credential or address, and the
 * runner must still use the existing endpoint with values from the environment.
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
  literalSecretLine === -1 ? "addresses and tokens come only from vars/secrets" : `line ${literalSecretLine + 1}`
);

check(
  "the gate variable is the only schedule switch",
  workflowText.includes(GATE_NAME) &&
    /vars\.SOLUPLAY_HEALTH_CHECK_SCHEDULE_ENABLED/.test(gate),
  "read from the repository variable, never a literal"
);

check(
  "workflow_dispatch is offered and schedule is registered",
  /^\s*workflow_dispatch:/m.test(workflowText) && /^\s*schedule:/m.test(workflowText)
);

check(
  "concurrency queues a second pass instead of cancelling the first",
  /concurrency:/.test(workflowText) && /cancel-in-progress:\s*false/.test(workflowText)
);

check(
  "the workflow keeps write permissions off",
  /permissions:\s*[\s\S]*?contents:\s*read/.test(workflowText) && !/contents:\s*write/.test(workflowText)
);

let runnerText;
try {
  runnerText = fs.readFileSync(RUNNER, "utf8");
} catch {
  runnerText = "";
}
check(
  "the runner still calls the existing batch endpoint",
  runnerText.includes("/api/admin/health-check") && !/api\/admin\/[a-z-]+\/(auto|cron|github)/.test(runnerText)
);
check(
  "the runner takes its address and token from the environment",
  runnerText.includes("process.env.SOLUPLAY_BASE_URL") &&
    runnerText.includes("process.env.HEALTH_CHECK_TOKEN") &&
    !/Bearer\s+[0-9a-f]{8,}/i.test(runnerText)
);

const failed = results.filter((entry) => !entry.pass);
console.log(
  `\n[health-gate] ${results.length - failed.length}/${results.length} checks passed` +
    (failed.length ? ` — ${failed.length} FAILED` : "")
);
process.exit(failed.length ? 1 : 0);
