/**
 * Tests for the write half of the 24/7 proxy control tier (`lib/proxyActions.ts`).
 *
 * Run with `npm run test:proxy-actions`. No box is involved: every upstream answer is a
 * stubbed `fetch`, so the rules being executed are the same ones a deployment runs against
 * a real stream box.
 *
 * The cases that matter are the ones an operator would be hurt by if they broke: a write
 * that reaches the box before the secret is checked, a request that can steer this server to
 * a path of the caller's own choosing, and an answer that carries the box's rows — a lane
 * identity, a stream id, an upstream address — back to a browser.
 */

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { afterEach, test } from "node:test";

type Actions = typeof import("../lib/proxyActions");
const actions: Actions = require("../lib/proxyActions");
const { proxyActionResponse, proxyActionConfigProblem, PROXY_ACTION_NAMES } = actions;

type Labels = typeof import("../components/proxy-admin/proxyActionLabels");
const labels: Labels = require("../components/proxy-admin/proxyActionLabels");
const { proxyActionLabel, proxyActionFailure, proxyActionSuccess } = labels;

const ADMIN_SECRET = "correct-horse-battery-staple";
const BOX_TOKEN = "box-write-token-not-real-000000000";

function fakeResponse(status: number, text: string) {
  return {
    status,
    headers: { get: () => null },
    text: async () => text,
  } as unknown as Response;
}

/** A `fetch` a test can change between calls, recording every request it received. */
function stubFetch(reply: { status: number; body: unknown } | Error = { status: 200, body: { ok: true } }) {
  const box: {
    reply: { status: number; body: unknown } | Error;
    calls: { input: string; init: RequestInit | undefined }[];
  } = { reply, calls: [] };

  const fetchImpl = (async (input: unknown, init?: unknown) => {
    box.calls.push({ input: String(input), init: init as RequestInit | undefined });
    if (box.reply instanceof Error) throw box.reply;
    const text = typeof box.reply.body === "string" ? box.reply.body : JSON.stringify(box.reply.body);
    return fakeResponse(box.reply.status, text);
  }) as unknown as typeof fetch;

  return { fetchImpl, box };
}

const REAL_ADMIN_SECRET = process.env.ADMIN_SECRET_KEY;
const REAL_BASE_URL = process.env.PROXY_BASE_URL;
const REAL_ADMIN_TOKEN = process.env.PROXY_ADMIN_TOKEN;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv("ADMIN_SECRET_KEY", REAL_ADMIN_SECRET);
  setEnv("PROXY_BASE_URL", REAL_BASE_URL);
  setEnv("PROXY_ADMIN_TOKEN", REAL_ADMIN_TOKEN);
});

/** The environment a working deployment of this tier has. */
function configuredEnv(): void {
  setEnv("ADMIN_SECRET_KEY", ADMIN_SECRET);
  setEnv("PROXY_BASE_URL", "https://box.example.com");
  setEnv("PROXY_ADMIN_TOKEN", BOX_TOKEN);
}

// --- the gate, before the box is ever asked ---

test("an unauthorized request is refused without the box being asked", async () => {
  configuredEnv();
  const { fetchImpl, box } = stubFetch();

  for (const presented of [null, "", "   ", "wrong-secret", "correct-horse-battery-stapl"]) {
    const result = await proxyActionResponse(presented, { action: "refresh_vault" }, { fetchImpl });
    assert.equal(result.status, 401);
    assert.equal(result.body.success, false);
    assert.match(String(result.body.error), /Unauthorized/);
  }

  assert.equal(box.calls.length, 0, "an unauthorized call must not reach the box");
});

test("an unset admin secret locks the write surface in every environment", async () => {
  setEnv("ADMIN_SECRET_KEY", undefined);
  const { fetchImpl, box } = stubFetch();

  const result = await proxyActionResponse("anything", { action: "refresh_vault" }, { fetchImpl });
  assert.equal(result.status, 401);
  assert.equal(box.calls.length, 0);
});

// --- the action list is closed ---

test("only the four named actions are performed", async () => {
  configuredEnv();
  const { fetchImpl, box } = stubFetch();

  const result = await proxyActionResponse(
    ADMIN_SECRET,
    { action: "delete_provider", target: "acct0" },
    { fetchImpl }
  );

  assert.equal(result.status, 400);
  assert.equal(result.body.success, false);
  assert.deepEqual(result.body.allowed, [...PROXY_ACTION_NAMES]);
  assert.equal(box.calls.length, 0, "an unknown action must not reach the box");
});

test("a caller cannot steer the request to a path of its own", async () => {
  configuredEnv();
  const { fetchImpl, box } = stubFetch();

  // Every one of these is an attempt to escape the table: a path traversal, a second path
  // segment, an absolute URL, a query string, or an id the box itself would refuse.
  const badTargets = [
    "../../admin/channels",
    "acct0/../../admin",
    "http://evil.example.com/admin/channels",
    "acct0?admin=true",
    "acct0#x",
    "a",
    "ACCT0 CH0",
    "acct0\\ch0",
    "%2e%2e%2fadmin",
    "",
  ];

  for (const target of badTargets) {
    const result = await proxyActionResponse(
      ADMIN_SECRET,
      { action: "probe_channel", target },
      { fetchImpl }
    );
    assert.equal(result.status, 400, `target ${JSON.stringify(target)} must be refused`);
  }

  assert.equal(box.calls.length, 0, "a refused target must not reach the box");
});

test("each action reaches exactly the box route the table names", async () => {
  configuredEnv();
  const cases: {
    action: string;
    request: Record<string, unknown>;
    method: string;
    path: string;
    body: unknown;
  }[] = [
    {
      action: "refresh_vault",
      request: { action: "refresh_vault" },
      method: "POST",
      path: "/admin/refresh",
      body: undefined,
    },
    {
      action: "set_provider_active",
      request: { action: "set_provider_active", target: "acct0", active: false },
      method: "PATCH",
      path: "/admin/providers/acct0",
      body: { active: false },
    },
    {
      action: "set_channel_active",
      request: { action: "set_channel_active", target: "acct0-ch1", active: true },
      method: "PATCH",
      path: "/admin/channels/acct0-ch1",
      body: { active: true },
    },
    {
      action: "probe_channel",
      request: { action: "probe_channel", target: "acct0-ch1" },
      method: "POST",
      path: "/admin/channels/acct0-ch1/probe",
      body: undefined,
    },
  ];

  for (const testCase of cases) {
    const { fetchImpl, box } = stubFetch({ status: 200, body: { ok: true } });
    const result = await proxyActionResponse(ADMIN_SECRET, testCase.request, { fetchImpl });

    assert.equal(result.status, 200);
    assert.equal(box.calls.length, 1);
    const call = box.calls[0];
    assert.equal(call.input, `https://box.example.com${testCase.path}`);
    assert.equal(call.init?.method, testCase.method);
    assert.equal(call.init?.cache, "no-store");
    if (testCase.body === undefined) {
      assert.equal(call.init?.body, undefined);
    } else {
      assert.deepEqual(JSON.parse(String(call.init?.body)), testCase.body);
    }
  }
});

test("a body field the action does not use is never forwarded", async () => {
  configuredEnv();
  const { fetchImpl, box } = stubFetch({ status: 200, body: { ok: true } });

  await proxyActionResponse(
    ADMIN_SECRET,
    {
      action: "set_channel_active",
      target: "acct0-ch1",
      active: false,
      // None of these belongs to the action, and none of them may reach the box.
      displayName: "renamed",
      sourceUrl: "http://user:pass@panel.example.com/get.php",
      streamId: "4411",
      accountKey: "9f8e7d6c5b4a",
      adminToken: "a-token-the-caller-supplied",
    },
    { fetchImpl }
  );

  assert.equal(box.calls.length, 1);
  assert.deepEqual(JSON.parse(String(box.calls[0].init?.body)), { active: false });
  const sent = JSON.stringify(box.calls[0]);
  assert.ok(!sent.includes("panel.example.com"), "no upstream address may travel");
  assert.ok(!sent.includes("a-token-the-caller-supplied"), "no caller-supplied token may travel");
});

// --- the credential ---

test("the box's write credential travels in the header and nowhere else", async () => {
  configuredEnv();
  const { fetchImpl, box } = stubFetch({ status: 200, body: { ok: true } });

  await proxyActionResponse(ADMIN_SECRET, { action: "refresh_vault" }, { fetchImpl });

  const call = box.calls[0];
  const headers = (call.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${BOX_TOKEN}`);
  assert.ok(!call.input.includes(BOX_TOKEN), "the token must not appear in the URL");
  assert.ok(!String(call.init?.body ?? "").includes(BOX_TOKEN), "the token must not appear in the body");
});

test("the write credential is never taken from the request", async () => {
  configuredEnv();
  const { fetchImpl, box } = stubFetch({ status: 200, body: { ok: true } });

  await proxyActionResponse(
    ADMIN_SECRET,
    { action: "refresh_vault", token: "caller-supplied", adminToken: "caller-supplied" },
    { fetchImpl }
  );

  const headers = (box.calls[0].init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${BOX_TOKEN}`);
});

// --- what comes back ---

test("the box's answer is projected, not passed through", async () => {
  configuredEnv();
  const { fetchImpl } = stubFetch({
    status: 200,
    body: {
      ok: true,
      channel: {
        channelKey: "acct0-ch1",
        displayName: "Account 0 Channel 1",
        active: false,
        providerId: "acct0",
        streamId: "4411",
        accountKey: "9f8e7d6c5b4a39281706",
        backupStreamIds: ["4412"],
      },
      provider: {
        providerId: "acct0",
        active: false,
        server: "http://panel.example.com:8080",
        usernameHint: "ab***",
        accountKey: "9f8e7d6c5b4a39281706",
      },
      probe: {
        ok: false,
        httpStatus: 401,
        error: "panel responded 401",
        upstreamUrl: "http://user:pass@panel.example.com/get.php",
      },
    },
  });

  const result = await proxyActionResponse(
    ADMIN_SECRET,
    { action: "set_channel_active", target: "acct0-ch1", active: false },
    { fetchImpl }
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  const resultBody = result.body.result as Record<string, unknown>;
  assert.equal(resultBody.action, "set_channel_active");
  assert.equal(resultBody.target, "acct0-ch1");
  assert.equal(resultBody.ok, true);
  assert.deepEqual(resultBody.detail, { active: false });

  const sent = JSON.stringify(result.body);
  for (const secret of [
    "9f8e7d6c5b4a39281706",
    "4411",
    "4412",
    "panel.example.com",
    "user:pass",
    "accountKey",
    "streamId",
    "Account 0 Channel 1",
  ]) {
    assert.ok(!sent.includes(secret), `${secret} must not reach the browser`);
  }
});

test("a probe's own failure text does not travel either", async () => {
  configuredEnv();
  const { fetchImpl } = stubFetch({
    status: 502,
    body: {
      ok: false,
      channelKey: "acct0-ch1",
      via: "cold",
      probe: {
        ok: false,
        httpStatus: 401,
        error: "panel responded 401",
        upstreamUrl: "http://user:pass@panel.example.com/get.php",
      },
    },
  });

  const result = await proxyActionResponse(
    ADMIN_SECRET,
    { action: "probe_channel", target: "acct0-ch1" },
    { fetchImpl }
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  const resultBody = result.body.result as Record<string, unknown>;
  assert.equal(resultBody.ok, false);
  const detail = resultBody.detail as Record<string, unknown>;
  assert.equal(detail.probeOk, false);
  assert.equal(detail.via, "cold");
  assert.equal(detail.httpStatus, 401);

  const sent = JSON.stringify(result.body);
  assert.ok(!sent.includes("panel.example.com"));
  assert.ok(!sent.includes("user:pass"));
  assert.ok(!sent.includes("panel responded 401"));
});

// --- what the box refuses, and how the site says it ---

test("a row the box does not know is a 404, and the box's own text stays on the box", async () => {
  configuredEnv();
  const { fetchImpl } = stubFetch({
    status: 404,
    body: { ok: false, code: "unknown_channel", message: "no such channel in the vault" },
  });

  const result = await proxyActionResponse(
    ADMIN_SECRET,
    { action: "set_channel_active", target: "acct0-ch1", active: false },
    { fetchImpl }
  );

  assert.equal(result.status, 404);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, "the stream box does not know that row");
  const resultBody = result.body.result as Record<string, unknown>;
  assert.equal(resultBody.code, "unknown_channel");
  assert.equal(resultBody.ok, false);
  assert.ok(!JSON.stringify(result.body).includes("no such channel in the vault"));
});

test("a refused credential is this server's problem, not the caller's", async () => {
  configuredEnv();
  const { fetchImpl } = stubFetch({
    status: 401,
    body: { ok: false, code: "unauthorized", message: "a bearer admin token is required" },
  });

  const result = await proxyActionResponse(ADMIN_SECRET, { action: "refresh_vault" }, { fetchImpl });

  assert.equal(result.status, 502);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, "the stream box refused this server's credential");
});

test("an unreachable box is a 502, not a crash", async () => {
  configuredEnv();
  const { fetchImpl } = stubFetch(new Error("connect ECONNREFUSED"));

  const result = await proxyActionResponse(ADMIN_SECRET, { action: "refresh_vault" }, { fetchImpl });

  assert.equal(result.status, 502);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, "the stream box could not be reached");
});

test("an answer that is not JSON is not read as values", async () => {
  configuredEnv();
  const { fetchImpl } = stubFetch({ status: 200, body: "<html>error page</html>" });

  const result = await proxyActionResponse(ADMIN_SECRET, { action: "refresh_vault" }, { fetchImpl });

  assert.equal(result.status, 200);
  const resultBody = result.body.result as Record<string, unknown>;
  assert.equal(resultBody.ok, true);
  assert.deepEqual(resultBody.detail, {
    providers: null,
    stored: null,
    resolvable: null,
    hasError: false,
  });
});

// --- what the server itself is missing ---

test("without the write credential the server says what is missing and asks nothing", async () => {
  setEnv("ADMIN_SECRET_KEY", ADMIN_SECRET);
  setEnv("PROXY_BASE_URL", "https://box.example.com");
  setEnv("PROXY_ADMIN_TOKEN", undefined);
  const { fetchImpl, box } = stubFetch();

  const result = await proxyActionResponse(ADMIN_SECRET, { action: "refresh_vault" }, { fetchImpl });

  assert.equal(result.status, 503);
  assert.equal(result.body.success, false);
  assert.match(String(result.body.error), /PROXY_ADMIN_TOKEN/);
  assert.ok(!String(result.body.error).includes(BOX_TOKEN));
  assert.equal(box.calls.length, 0, "a server that cannot write must not ask the box");

  assert.equal(proxyActionConfigProblem(), "PROXY_ADMIN_TOKEN");
});

test("a boolean is required for the two activation actions", async () => {
  configuredEnv();
  const { fetchImpl, box } = stubFetch();

  for (const active of ["true", 1, 0, null, undefined, {}]) {
    const result = await proxyActionResponse(
      ADMIN_SECRET,
      { action: "set_channel_active", target: "acct0-ch1", active },
      { fetchImpl }
    );
    assert.equal(result.status, 400, `active ${JSON.stringify(active)} must be refused`);
  }

  assert.equal(box.calls.length, 0);
});

// --- the route itself, not only the function behind it ---

const nodeModule = require("node:module") as {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};

/**
 * The route files import through the `@/` alias. TypeScript resolves that alias for types and
 * leaves it in the emitted JavaScript, so the resolver is pointed at the compiled output
 * before a route is required. Without this the route could not be exercised at all.
 */
function installAliasResolver(): void {
  const patched = nodeModule as { __d3AliasPatched?: boolean };
  if (patched.__d3AliasPatched) return;
  const original = nodeModule._resolveFilename;
  nodeModule._resolveFilename = (request: string, ...rest: unknown[]) => {
    const resolved =
      typeof request === "string" && request.startsWith("@/")
        ? path.join(__dirname, "..", request.slice(2))
        : request;
    return original.call(nodeModule, resolved, ...rest);
  };
  patched.__d3AliasPatched = true;
}

/** A box that records what it was asked, so a caller that never reached it can be shown. */
async function startRecordingBox(): Promise<{
  url: string;
  hits: () => number;
  requests: { method: string; url: string; authorization: string | undefined; body: string }[];
  close: () => Promise<void>;
}> {
  const requests: { method: string; url: string; authorization: string | undefined; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, channel: { channelKey: "acct0-ch1", active: false } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => requests.length,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("the action route refuses an unauthorized caller before the box is asked", async () => {
  installAliasResolver();
  const { NextRequest } = require("next/server");
  const { POST } = require("../app/api/admin/proxy/action/route.js");

  setEnv("ADMIN_SECRET_KEY", ADMIN_SECRET);
  setEnv("PROXY_ADMIN_TOKEN", BOX_TOKEN);
  const box = await startRecordingBox();
  setEnv("PROXY_BASE_URL", box.url);

  const post = (headers: Record<string, string>, body: Record<string, unknown>) =>
    new NextRequest("http://localhost/api/admin/proxy/action", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  try {
    const refused = await POST(post({}, { action: "refresh_vault" }));
    assert.equal(refused.status, 401);
    assert.equal(box.hits(), 0, "an unauthorized call must not reach the box");

    const wrong = await POST(post({ "x-admin-secret": "not-the-key" }, { action: "refresh_vault" }));
    assert.equal(wrong.status, 401);
    assert.equal(box.hits(), 0, "a wrong key must not reach the box either");

    const allowed = await POST(
      post({ "x-admin-secret": ADMIN_SECRET }, { action: "set_channel_active", target: "acct0-ch1", active: false })
    );
    assert.equal(allowed.status, 200);
    assert.equal(box.hits(), 1);

    const json = (await allowed.json()) as Record<string, unknown>;
    assert.equal(json.success, true);
    const result = json.result as Record<string, unknown>;
    assert.equal(result.action, "set_channel_active");
    assert.equal(result.target, "acct0-ch1");
    assert.deepEqual(result.detail, { active: false });

    const asked = box.requests[0];
    assert.equal(asked.method, "PATCH");
    assert.equal(asked.url, "/admin/channels/acct0-ch1");
    assert.equal(asked.authorization, `Bearer ${BOX_TOKEN}`);
    assert.deepEqual(JSON.parse(asked.body), { active: false });

    const refused2 = await POST(post({ "x-admin-secret": ADMIN_SECRET }, { action: "drop_everything" }));
    assert.equal(refused2.status, 400);
    assert.equal(box.hits(), 1, "an unknown action must not reach the box");
  } finally {
    await box.close();
  }
});

// --- the panel's own words ---

test("every action and every refusal the server can send has a line", () => {
  for (const action of PROXY_ACTION_NAMES) {
    const label = proxyActionLabel(action);
    assert.ok(label && label.length > 0, `${action} must have a name in the panel`);
  }

  // The server's own failure codes.
  const siteCodes = [
    "unauthorized",
    "unknown_action",
    "invalid_target",
    "invalid_active",
    "not_configured",
    "unreachable",
    "unreadable_answer",
    "refused",
    "unknown_row",
    "refused_credential",
    "box_error",
  ];
  for (const code of siteCodes) {
    const line = proxyActionFailure(code, null);
    assert.ok(line.text.length > 0, `${code} must have a line`);
    assert.equal(line.tone, "red");
  }

  // The codes the box itself uses when it refuses a write.
  const boxCodes = [
    "unknown_channel",
    "unknown_provider",
    "invalid_channelKey",
    "invalid_providerId",
    "invalid_kind",
    "invalid_credential",
    "unauthorized",
    "admin_disabled",
    "vault_disabled",
    "vault_failed",
    "vault_write_failed",
    "registry_unavailable",
    "provider_busy",
    "provider_in_use",
    "duplicate_credential",
    "channel_limit",
    "too_many_channels",
    "invalid_body",
  ];
  for (const code of boxCodes) {
    const line = proxyActionFailure(null, code);
    assert.ok(line.text.length > 0, `${code} must have a line`);
    assert.equal(line.tone, "red");
  }

  // A code nobody has seen still has to read as something.
  const unknown = proxyActionFailure("something_new", "also_new");
  assert.ok(unknown.text.length > 0);
  assert.equal(unknown.tone, "red");
});

test("a probe that ran and found nothing is amber, not a failure", () => {
  const failed = proxyActionSuccess("probe_channel", {
    via: "cold",
    probeOk: false,
    httpStatus: 401,
  });
  assert.equal(failed.tone, "amber");
  assert.match(failed.text, /401/);

  const worked = proxyActionSuccess("probe_channel", {
    via: "lane",
    probeOk: true,
    bytes: 1024,
  });
  assert.equal(worked.tone, "green");
});

test("a refresh that found a vault problem is amber, and a clean one is green", () => {
  const broken = proxyActionSuccess("refresh_vault", {
    providers: 2,
    stored: 5,
    hasError: true,
  });
  assert.equal(broken.tone, "amber");

  const clean = proxyActionSuccess("refresh_vault", {
    providers: 2,
    stored: 5,
    hasError: false,
  });
  assert.equal(clean.tone, "green");
  assert.match(clean.text, /2/);
  assert.match(clean.text, /5/);
});

test("an activation says which state the row is in now", () => {
  const off = proxyActionSuccess("set_channel_active", { active: false });
  assert.match(off.text, /বন্ধ/);
  const on = proxyActionSuccess("set_provider_active", { active: true });
  assert.match(on.text, /চালু/);
});
