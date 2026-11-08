/**
 * Tests for the origin the stream probe measures CORS against
 * (`lib/siteOrigin.ts`).
 *
 * The failure this prevents: a custom domain serves production, while Vercel
 * keeps naming the *.vercel.app host. A grant written for the custom domain is
 * then compared against the wrong origin, and a link a browser can play is
 * filed as blocked.
 *
 * Run with `npm run test:site-origin`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { normaliseOrigin, resolveSiteOrigin } from "../lib/siteOrigin";

test("the configured public origin wins over the deployment host", () => {
  assert.equal(
    resolveSiteOrigin({
      SITE_ORIGIN: "https://soluplay.example",
      VERCEL_PROJECT_PRODUCTION_URL: "soluplay.vercel.app",
      VERCEL_URL: "soluplay-abc.vercel.app",
    }),
    "https://soluplay.example"
  );
});

test("the production deployment host is the fallback", () => {
  assert.equal(
    resolveSiteOrigin({ VERCEL_PROJECT_PRODUCTION_URL: "soluplay.vercel.app" }),
    "https://soluplay.vercel.app"
  );
});

test("a preview deployment measures its own host", () => {
  assert.equal(
    resolveSiteOrigin({ VERCEL_URL: "soluplay-git-branch-user.vercel.app" }),
    "https://soluplay-git-branch-user.vercel.app"
  );
});

test("local development has no known origin", () => {
  assert.equal(resolveSiteOrigin({}), null);
  assert.equal(resolveSiteOrigin({ SITE_ORIGIN: "   " }), null);
});

test("a configured value without a scheme is read as HTTPS", () => {
  assert.equal(resolveSiteOrigin({ SITE_ORIGIN: "soluplay.example" }), "https://soluplay.example");
});

test("paths, queries and host case do not change the origin", () => {
  assert.equal(
    resolveSiteOrigin({ SITE_ORIGIN: "https://SoluPlay.Example/watch/1?x=1#top" }),
    "https://soluplay.example"
  );
});

test("a value that is not a usable HTTP origin is refused", () => {
  assert.equal(resolveSiteOrigin({ SITE_ORIGIN: "ftp://soluplay.example" }), null);
  assert.equal(resolveSiteOrigin({ SITE_ORIGIN: "https://user:pass@soluplay.example" }), null);
  assert.equal(resolveSiteOrigin({ SITE_ORIGIN: "not a url" }), null);
});

test("a CORS grant is compared in its normalised form", () => {
  assert.equal(normaliseOrigin("https://SoluPlay.Example/"), "https://soluplay.example");
  assert.equal(normaliseOrigin("soluplay.example"), "https://soluplay.example");
  assert.equal(normaliseOrigin("null"), null);
  assert.equal(normaliseOrigin("*"), null);
});