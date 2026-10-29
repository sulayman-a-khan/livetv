/**
 * The site's own credentials for the stream box, derived per box.
 *
 * Until now the site held three shared tokens and every box held the same three. A shared
 * token is the same credential in every machine, so a box that leaked one — through a log
 * line, a backup, a screenshot — gave the leak the right to talk to every other box, and
 * withdrawing it meant editing every box by hand. That is the gap P8.3 names, and this
 * module is the other side of it.
 *
 * The model is one master secret and a derivation. The site holds `PROXY_BOX_SECRET` and
 * nothing else; a box's three tokens are HMAC-SHA256 over its own name and the purpose:
 *
 *     appToken(box) = HMAC(secret, "soluplay-box:app:<boxId>")
 *     adminToken(box) = HMAC(secret, "soluplay-box:admin:<boxId>")
 *     readonlyToken(box) = HMAC(secret, "soluplay-box:readonly:<boxId>")
 *
 * Three things follow from that, and they are the reasons it is done this way:
 *
 *   - **The site's database holds no credential.** A dump of it yields box names and
 *     addresses, not tokens. The secret lives in the deployment's environment, where the
 *     other secrets already live.
 *   - **A box's tokens are its own.** A box that leaks its app token does not give anyone
 *     access to a second box, and revoking that box is a change to the site's registry —
 *     one row — rather than an edit on every machine.
 *   - **Rotating the secret withdraws every box at once.** That is the emergency lever, and
 *     it costs every box one re-enrollment. It is deliberate that the lever is this blunt:
 *     the alternative is a shared secret, and a shared secret cannot be withdrawn at all.
 *
 * The tokens are 64 hex characters, which is above the 24 characters the box demands of a
 * service token, and the three differ from each other because the purpose is part of the
 * message.
 */

import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** What a token is for. Each purpose is a different token, always. */
export type BoxTokenPurpose = "app" | "admin" | "readonly";

/**
 * The site's master secret. Empty when it is not configured, and every caller must treat
 * that as "this site cannot talk to a box" — a missing secret never falls back to a
 * default, because a default secret would be a shared secret with extra steps.
 */
export function boxSecret(): string {
  return (process.env.PROXY_BOX_SECRET || "").trim();
}

/**
 * The shortest master secret this module will use. A short one is still a secret; it is
 * just not worth having.
 */
export const MIN_BOX_SECRET_LENGTH = 32;

/**
 * A box's token for one purpose.
 *
 * The box id is part of the message, so two boxes never share a token even when they run
 * on the same secret, and the purpose is part of it, so one box's admin token is not its
 * app token. A caller with no secret gets an empty string, which no box will accept.
 */
export function deriveBoxToken(
  secret: string,
  purpose: BoxTokenPurpose,
  boxId: string
): string {
  if (!secret) return "";
  const id = (boxId || "").trim();
  if (!id) return "";
  return createHmac("sha256", secret).update(`soluplay-box:${purpose}:${id}`).digest("hex");
}

/**
 * Compare a presented token with the expected one, in constant time.
 *
 * The comparison is over the bytes, and a length difference is refused without a timing
 * signal about the secret itself: a token that is the right length but the wrong bytes is
 * the case this is here for.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented || "", "utf8");
  const b = Buffer.from(expected || "", "utf8");
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * A one-time enrollment code.
 *
 * This is the credential that admits a box: it is handed to the operator once, exchanged
 * for the box's tokens, and worthless afterwards. It is random rather than derived,
 * because it is the one secret that has to survive without the site's master secret in
 * the picture — the box does not have that yet when it presents the code.
 */
export function newEnrollmentCode(): string {
  return randomBytes(24).toString("hex");
}

/**
 * What the site keeps of an enrollment code: its hash.
 *
 * The code itself is shown to the operator once and never stored, so a dump of the site's
 * database cannot be replayed as an enrollment.
 */
export function hashEnrollmentCode(code: string): string {
  return createHash("sha256").update((code || "").trim(), "utf8").digest("hex");
}

/**
 * The enrolment code, compared against the hash the site kept.
 *
 * Both sides are hashed first so the comparison is over equal-length buffers whatever the
 * code's length was.
 */
export function enrollmentCodeMatches(presented: string, storedHash: string): boolean {
  const presentedHash = hashEnrollmentCode(presented);
  const expected = (storedHash || "").trim();
  if (!expected) return false;
  const a = Buffer.from(presentedHash, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
