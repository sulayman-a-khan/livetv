/**
 * Shared admin authentication guard.
 * Accepts the secret via the `x-admin-secret` header, a `secretKey` query
 * param, or a `secretKey` body field, matching the existing admin routes.
 */
import { NextRequest } from "next/server";

export function isAuthorizedAdmin(req: NextRequest, bodySecret?: string): boolean {
  const header = req.headers.get("x-admin-secret");
  const { searchParams } = new URL(req.url);
  const raw = header || searchParams.get("secretKey") || bodySecret || "";
  const expected = (process.env.ADMIN_SECRET_KEY || "supersecret123").trim();
  return Boolean(raw.trim()) && raw.trim() === expected;
}
