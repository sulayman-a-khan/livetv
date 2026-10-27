/**
 * Tests for the premium tier's refusal vocabulary (`lib/premiumPlayFailure.ts`) and for the
 * play route's half of that contract.
 *
 * Run with `npm run test:premium-play-failure`.
 *
 * The rule this locks: a viewer on a Bengali screen is never answered in English because the
 * stream box refused. The server answers in codes, the player turns a code into a Bengali
 * line, and every code the server can send has a line of its own — a code with no line would
 * put an empty box on the screen, and a line the server never sends would be a sentence nobody
 * can reach.
 *
 * Nothing here reaches a database or the network. The route is exercised against the tier's
 * own local store in a temporary directory, and the stream box is simply absent, which is
 * exactly the outage a viewer has to be able to read.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { LocalPremiumChannel } from "../lib/premiumLocalStore";

type Failure = typeof import("../lib/premiumPlayFailure");
const failure: Failure = require("../lib/premiumPlayFailure");
const { PREMIUM_PLAY_FAILURES, premiumPlayFailureText, isPremiumPlayFailure } = failure;

/** An ASCII letter is the mark of a sentence written in the wrong language. */
const hasLatin = (line: string): boolean => /[A-Za-z]/.test(line);

// --- the vocabulary ---

test("every code the server can send has a line of its own", () => {
  const lines = PREMIUM_PLAY_FAILURES.map((code) => premiumPlayFailureText(code));
  for (const code of PREMIUM_PLAY_FAILURES) {
    const line = premiumPlayFailureText(code);
    assert.ok(line.length > 0, `${code} has no line`);
    assert.ok(!hasLatin(line), `${code} answers in English: ${line}`);
  }
  assert.equal(
    new Set(lines).size,
    lines.length,
    "two codes share one line, so one of them says the wrong thing"
  );
});

test("a code the client does not know still reads as a sentence", () => {
  for (const unknown of ["something_new", "", null, undefined]) {
    const line = premiumPlayFailureText(unknown);
    assert.ok(line.length > 0, "an unrecognised refusal must not be an empty box");
    assert.ok(!hasLatin(line), `an unrecognised refusal answers in English: ${line}`);
    assert.ok(!line.includes("something_new"), "the code is never shown to a viewer");
  }
});

test("the code list is the one the matcher accepts", () => {
  for (const code of PREMIUM_PLAY_FAILURES) {
    assert.equal(isPremiumPlayFailure(code), true, `${code} is not recognised`);
  }
  assert.equal(isPremiumPlayFailure("something_new"), false);
});

test("the line for a source that is not on the box yet says the live comes with the match", () => {
  const line = premiumPlayFailureText("not_pushed");
  assert.ok(line.includes("খেলা শুরু হলেই"), `the match promise is missing: ${line}`);
  assert.ok(line.includes("লাইভ স্ট্রিম"), `the live stream is not named: ${line}`);
  assert.ok(!hasLatin(line), `the line answers in English: ${line}`);
});

// --- the route, not only the vocabulary ---

const nodeModule = Module as typeof Module & {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};

/**
 * The route reaches its siblings through the app's `@/` alias, which the compiler leaves in the
 * emitted `require`. Point it at the compiled output so the route under test is the real one.
 */
const originalResolve = nodeModule._resolveFilename;
const compiledRoot = path.resolve(__dirname, "..");
nodeModule._resolveFilename = function resolveAppAlias(request: string, ...rest: unknown[]) {
  if (request.startsWith("@/")) {
    return originalResolve.call(this, path.resolve(compiledRoot, request.slice(2)), ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};

const projectRoot = path.resolve(__dirname, "..", "..");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "freetv-premium-play-"));

// A blank URI is the shape of "this process has no database", and `VERCEL` is what
// `mustUseDatabase` reads. Both are cleared before anything is loaded, because the database
// module reads the URI once, at load time.
delete process.env.MONGODB_URI;
delete process.env.VERCEL;
delete process.env.PROXY_BASE_URL;
delete process.env.PROXY_APP_TOKEN;
delete process.env.PROXY_ADMIN_TOKEN;

process.chdir(sandbox);

type LocalStore = typeof import("../lib/premiumLocalStore");
const localStore: LocalStore = require("../lib/premiumLocalStore");

after(() => {
  process.chdir(path.resolve(projectRoot));
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** A row in the tier's own local store, which is where a local run keeps its channels. */
function addChannel(id: string, patch: Partial<LocalPremiumChannel> = {}): void {
  const now = new Date();
  localStore.premiumLocalStore.addChannel({
    _id: id,
    name: `Test ${id}`,
    category: "Sports",
    logoUrl: "",
    sourceUrl: "",
    headers: { userAgent: "", referer: "" },
    proxyChannelKey: "",
    proxyPushedAt: null,
    active: true,
    sortOrder: 1,
    note: "",
    createdAt: now,
    updatedAt: now,
    ...patch,
  });
}

/** The route's own answer, as the fields the contract is written in. */
async function ask(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { NextRequest } = require("next/server");
  const { GET } = require("../app/api/premium/[id]/play/route.js");
  const res = await GET(new NextRequest(`http://localhost/api/premium/${id}/play`), {
    params: { id },
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

/** Every refusal has to be matchable, and has to keep an English reason for the log. */
function assertRefusal(
  answer: { status: number; body: Record<string, unknown> },
  status: number,
  code: string
): void {
  assert.equal(answer.status, status, `wrong status: ${JSON.stringify(answer.body)}`);
  assert.equal(answer.body.success, false);
  assert.equal(answer.body.code, code, `the refusal carries no code: ${JSON.stringify(answer.body)}`);
  assert.ok(
    typeof answer.body.error === "string" && answer.body.error.length > 0,
    "the refusal keeps an English reason for the log"
  );
}

test("a channel nobody has is a refusal the client can match", async () => {
  assertRefusal(await ask("no-such-channel"), 404, "not_found");
});

test("a channel the admin switched off is a refusal the client can match", async () => {
  addChannel("off-air", { active: false });
  assertRefusal(await ask("off-air"), 410, "off_air");
});

test("a channel whose source was never pushed is a refusal the client can match", async () => {
  addChannel("not-pushed", { active: true, proxyChannelKey: "" });
  assertRefusal(await ask("not-pushed"), 409, "not_pushed");
});

test("a box that cannot answer is a refusal the client can match", async () => {
  addChannel("box-down", { active: true, proxyChannelKey: "prem-box-down" });
  assertRefusal(await ask("box-down"), 503, "box_unavailable");
});

test("every code the route sends has a line a viewer can read", async () => {
  for (const [id, code] of [
    ["no-such-channel", "not_found"],
    ["off-air", "off_air"],
    ["not-pushed", "not_pushed"],
    ["box-down", "box_unavailable"],
  ] as const) {
    const answer = await ask(id);
    assert.equal(answer.body.code, code);
    const line = premiumPlayFailureText(String(answer.body.code));
    assert.ok(line.length > 0, `${code} has no line`);
    assert.ok(!hasLatin(line), `${code} answers in English: ${line}`);
  }
});

// --- the player, which is the surface the viewer actually reads ---

test("the player shows the Bengali line and not the server's English sentence", () => {
  // The player is a client component and this project has no renderer for it, so the check is
  // made against its source: these are the places an English sentence could enter the overlay,
  // and a regression that puts one back has to fail here.
  const source = fs.readFileSync(
    path.join(projectRoot, "components", "premium", "PremiumPlayer.tsx"),
    "utf-8"
  );
  const forbidden = [
    // The server's own English sentence must not even be read by this screen.
    /data\??\.error\b/,
    // And nothing the hls.js event or the browser's MediaError says may reach the overlay.
    /block\(\s*data\./,
    /block\(\s*video\.error/,
    /setNotice\(\s*data\./,
    /setNotice\(\s*video\.error/,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `the overlay can still show an English string: ${pattern}`);
  }
  assert.ok(
    source.includes("premiumPlayFailureText"),
    "the player has to read the refusal vocabulary"
  );
});
