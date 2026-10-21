/**
 * ESLint configuration.
 *
 * The Next.js rules (`next/core-web-vitals`) are the ones that catch real
 * breakage — hook dependency mistakes, invalid image usage, bad anchors — so
 * the build now runs them instead of skipping linting.
 *
 * Two rules are set by hand:
 *
 *  - `@typescript-eslint/no-explicit-any` is a warning, not an error. The
 *    catalogue code uses `any` deliberately in a lot of places (a probe
 *    result, a parsed playlist, a document that comes back from Mongo) and
 *    several of those spots already carry an `eslint-disable` comment for it.
 *    Turning it into an error would mean retyping a large part of the app,
 *    which is a type-safety project of its own — not something a lint rule
 *    should be allowed to smuggle in. The rule stays on, so the list is still
 *    visible in `npm run lint` and can be worked down over time.
 *  - `@typescript-eslint/no-unused-vars` is an error, because an unused
 *    import or a dead local is a real defect: it is either a leftover from a
 *    refactor or a sign that a branch was never wired up.
 */
module.exports = {
  extends: ["next/core-web-vitals"],
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  rules: {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
    ],
    "no-unused-vars": "off",
    "prefer-const": "error",
  },
  ignorePatterns: [".tmp-tests/", ".tmp-verify/", "node_modules/"],
};
