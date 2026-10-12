/**
 * SoluPlay automatic health pass — the GitHub Actions runner.
 *
 * This is not a second probing engine. It is the loop the admin dashboard's
 * "Run Health Check (All Pinned)" button already runs, taken out of the browser
 * so the pass keeps going when nobody has a tab open:
 *
 *   POST /api/admin/health-check  →  one bounded batch of 12 pinned links,
 *   probed and saved server-side, answering with its cursor (`runStartedAt`) and
 *   how many links are still due (`remaining`). Repeat until nothing is due.
 *
 * Nothing here decides whether the pass succeeded. The server does, by writing a
 * completed report only when its own count of due links reaches zero — so this
 * script exiting cleanly is never mistaken for a finished pass.
 *
 * Secrets: the token is read from the environment and only ever placed in one
 * request header. No URL, response body or error message from a probe is ever
 * logged, because a failing stream link can carry credentials in its query
 * string and Actions logs are readable by anyone with repo access.
 */

import fs from "node:fs";

const BASE_URL = (process.env.SOLUPLAY_BASE_URL || "").trim().replace(/\/+$/, "");
const TOKEN = (process.env.HEALTH_CHECK_TOKEN || "").trim();
const TRIGGER = (process.env.HEALTH_RUN_TRIGGER || "workflow_dispatch").trim();
/**
 * Vercel's Deployment Protection answers an unrecognised request with a redirect
 * to its own sign-in, and a redirect is the end of the story for a scheduler —
 * the same silent failure that stops Vercel's cron reaching a protected
 * deployment. Optional: when the app is not protected, no header is sent.
 */
const PROTECTION_BYPASS = (process.env.VERCEL_PROTECTION_BYPASS || "").trim();

/** A batch is 12 links x ~2 probe attempts; the function itself stops at 60s. */
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS_PER_BATCH = 3;
const BACKOFF_MS = [5_000, 15_000, 30_000];
/** Guards against a stuck queue turning into an endless workflow, not against a long pass. */
const MAX_BATCHES = 300;
const WALL_CLOCK_BUDGET_MS = 35 * 60_000;

function log(message) {
  console.log(`[health-run] ${message}`);
}

function fail(message) {
  console.error(`[health-run] ${message}`);
  writeSummary({ ok: false, message });
  process.exit(1);
}

/**
 * Configuration mistakes must say so plainly instead of looking like a health
 * rule that does not work — the failure mode this whole pass exists to avoid.
 */
function validateConfig() {
  if (!BASE_URL) {
    fail("SOLUPLAY_BASE_URL is not set. Add it as a repository variable with the deployed app's address.");
  }
  let parsed;
  try {
    parsed = new URL(BASE_URL);
  } catch {
    fail("SOLUPLAY_BASE_URL is not a valid absolute URL (expected https://<host>).");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    fail("SOLUPLAY_BASE_URL must be https — the pass token is not sent over plain HTTP.");
  }
  if (!TOKEN) {
    fail("HEALTH_CHECK_TOKEN is not set. Add the repository secret that matches HEALTH_CHECK_SECRET on the app.");
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One batch. Returns the parsed response, or throws a message safe to print. */
async function postBatch(cursor) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/api/admin/health-check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
        ...(PROTECTION_BYPASS ? { "x-vercel-protection-bypass": PROTECTION_BYPASS } : {}),
      },
      body: JSON.stringify(cursor ? { before: cursor } : {}),
      redirect: "manual",
      signal: controller.signal,
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // A redirect or an HTML error page: describe it, never dump the body.
      if (res.status >= 300 && res.status < 400) {
        throw Object.assign(
          new Error(
            `HTTP ${res.status} redirect instead of JSON — the deployment is behind Vercel ` +
              `Deployment Protection. Add a "Protection Bypass for Automation" secret to Vercel ` +
              `and set it as the VERCEL_PROTECTION_BYPASS repository secret.`
          ),
          { fatal: true }
        );
      }
      throw new Error(`HTTP ${res.status} returned a non-JSON response.`);
    }

    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error("The app rejected the pass token (HTTP 401)."), { fatal: true });
    }
    if (res.status === 409) {
      throw Object.assign(
        new Error(data.detail || "Another pass is already running on the server."),
        { alreadyRunning: true }
      );
    }
    if (!res.ok || data.success !== true) {
      throw new Error(data.error || `HTTP ${res.status} from the health-check endpoint.`);
    }
    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`No answer within ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    if (err.cause?.name) {
      throw new Error(`Network error: ${err.cause.name}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function postBatchWithRetry(cursor, batchNo) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_BATCH; attempt++) {
    try {
      return await postBatch(cursor);
    } catch (err) {
      if (err.fatal || err.alreadyRunning) throw err;
      lastError = err;
      if (attempt < MAX_ATTEMPTS_PER_BATCH) {
        log(`batch ${batchNo} attempt ${attempt} failed: ${err.message} — retrying in ${BACKOFF_MS[attempt - 1] / 1000}s`);
        await wait(BACKOFF_MS[attempt - 1]);
      }
    }
  }
  throw lastError;
}

function writeSummary(result) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const lines = [];
  lines.push(`## SoluPlay automatic health pass`);
  lines.push("");
  lines.push(`- Trigger: \`${TRIGGER}\``);
  const outcome = result.skipped
    ? `**skipped** — ${result.message}`
    : result.ok
      ? "**completed**"
      : `**not completed** — ${result.message || "see the log"}`;
  lines.push(`- Result: ${outcome}`);
  if (result.report) {
    const r = result.report;
    lines.push(`- Pass started: ${r.startedAt}`);
    lines.push(`- Completed: ${r.completedAt} (${Math.round(r.durationMs / 1000)}s, ${r.batches} batches)`);
    lines.push(`- Links: ${r.completed} of ${r.eligible} eligible tested, ${r.remaining} still due`);
    lines.push(`- Verdicts: ${r.active} active, ${r.degraded} degraded, ${r.failures} broken`);
    if (r.unplayable) lines.push(`- Hidden for browser blocking: ${r.unplayable}`);
    if (r.notDelivering) lines.push(`- Hidden for not delivering: ${r.notDelivering}`);
    if (r.inconclusive) lines.push(`- Inconclusive (probed but not saved): ${r.inconclusive}`);
    // The sweep runs in the batch that empties the queue, so this is where a
    // deletion shows up — without it, a link that left the catalogue looks like
    // a probe verdict the log never mentions.
    if (r.sweep) {
      lines.push(
        `- Sweep: ${r.sweep.channelsMerged} merged, ${r.sweep.duplicateLinksRemoved} duplicate, ` +
          `${r.sweep.placeholderLinksPurged} test, ${r.sweep.deadLinksPurged} dead link(s) removed, ` +
          `${r.sweep.channelsReordered} channels re-ranked`
      );
    }
  } else if (result.progress) {
    const p = result.progress;
    lines.push(`- Tested so far: ${p.completed} of ${p.eligible}, ${p.remaining} still due`);
    lines.push(`- The app kept its checkpoint; the next scheduled pass resumes from it.`);
  } else if (!result.skipped) {
    lines.push(`- The app reported nothing: ${result.message || "no progress recorded on the app."}`);
  }
  lines.push("");
  lines.push(`No stream URLs, tokens or probe errors are recorded here.`);
  try {
    fs.appendFileSync(path, lines.join("\n"), "utf8");
  } catch {
    // A missing summary file is a hosted-runner detail, not a reason to fail a pass.
  }
}

async function main() {
  validateConfig();

  log(`posting batches to ${BASE_URL.replace(/^(https?:\/\/)[^@/]*@/, "$1")}`);

  let cursor = null;
  let batches = 0;
  let tested = 0;
  let lastProgress = null;
  let finalReport = null;
  const startedAt = Date.now();

  while (batches < MAX_BATCHES) {
    if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) {
      fail(
        `Stopped after ${batches} batches and ${Math.round((Date.now() - startedAt) / 60000)} min — the ` +
          `time budget ran out with ${lastProgress?.remaining ?? "?"} link(s) still due.`
      );
    }

    batches++;
    let data;
    try {
      data = await postBatchWithRetry(cursor, batches);
    } catch (err) {
      if (err.alreadyRunning) {
        log(`skipped: ${err.message}`);
        writeSummary({ skipped: true, message: "another pass was already running on the server." });
        console.log(`::notice::${err.message}`);
        return;
      }
      fail(`Batch ${batches} could not be completed: ${err.message}`);
    }

    cursor = data.runStartedAt;
    lastProgress = data.progress ?? lastProgress;
    if (data.finalReport) finalReport = data.finalReport;
    tested += data.summary?.checkedCount ?? 0;

    const s = data.summary || {};
    log(
      `batch ${batches}: ${data.batchSize} link(s) probed, ${s.checkedCount} recorded ` +
        `(${s.activeCount} active, ${s.degradedCount} degraded, ${s.brokenCount} broken` +
        `${s.secondLookCount ? `, ${s.secondLookCount} re-probed before hiding` : ""}` +
        `${s.inconclusiveCount ? `, ${s.inconclusiveCount} not saved` : ""}) — ` +
        `${lastProgress?.completed ?? tested}/${lastProgress?.eligible ?? "?"} tested, ` +
        `${data.remaining} still due`
    );

    if (data.hasMore === false) break;

    // Same guard the dashboard uses: a pass that is offered links but records
    // nothing would otherwise repeat this batch forever.
    if ((data.batchSize ?? 0) === 0) {
      fail(
        `Stopped: ${data.remaining} link(s) are still due but this batch recorded none of them. ` +
          `The queue is not draining — check the app's database connection.`
      );
    }
  }

  if (batches >= MAX_BATCHES && finalReport === null) {
    fail(`Stopped at the ${MAX_BATCHES}-batch limit with ${lastProgress?.remaining ?? "?"} link(s) still due.`);
  }

  if (finalReport) {
    log(
      `pass complete: ${finalReport.completed} of ${finalReport.eligible} eligible link(s) tested ` +
        `in ${finalReport.batches} batches (${finalReport.active} active, ${finalReport.degraded} degraded, ` +
        `${finalReport.failures} broken)` +
        `${finalReport.inconclusive ? `, ${finalReport.inconclusive} inconclusive` : ""}` +
        `${finalReport.sweep ? ` — sweep removed ${finalReport.sweep.streamsRemoved} link(s)` : ""}`
    );
    writeSummary({ ok: true, report: finalReport });
    return;
  }

  // The loop finished without the server ever writing a report: every link that
  // was due is not accounted for, so this run is not a success.
  fail(
    `No completed report from the server after ${batches} batches ` +
      `(${lastProgress?.remaining ?? "?"} link(s) still due).`
  );
}

main().catch((err) => fail(`Unexpected runner failure: ${err.message}`));
